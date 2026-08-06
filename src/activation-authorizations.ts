import { createHash, randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';

import { AUTHORIZATION_STATUS_LABELS, AuthorizationTokenSuffixCollisionError, Database, type AuthorizationListDisplayStatus, type AuthorizationListPage, type AuthorizationListQuery, type AuthorizationStatus } from './database.js';
import { budgetStockAtPrice, HeroSmsResponseError, type HeroSms, type HeroSmsActivationRecord, type HeroSmsActivationStatus, type HeroSmsCountry, type HeroSmsNumber, type HeroSmsOffer } from './herosms.js';

const CLAIM_ACQUISITION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RESULT_VIEW_LIFETIME_MS = 5 * 60 * 1000;
const END_PROMPT_LIFETIME_MS = 2 * 60 * 1000;
const RESULT_VIEW_ENDED_REASON = 'result_view_expired';
const QUOTA_EXHAUSTED_ENDED_REASON = 'quota_exhausted';
/** 取消请求返回 too-early 后的重试间隔，也是对账 claim 时持久化的下一次处理时间。 */
const CANCELLATION_RETRY_DELAY_MS = 60_000;
const CANCELLATION_RECONCILIATION_LEASE_MS = 5 * 60 * 1000;

export interface CreatedAuthorization {
  id: string;
  token: string;
  tokenSuffix: string;
}

export interface AuthorizationTokenGenerator {
  generate(): string;
}

export type AuthorizationTokenGeneratorInput = AuthorizationTokenGenerator | (() => string);

export interface BatchAuthorizationPreflight {
  quantity: number;
}

export interface AuthorizationSummary {
  id: string;
  tokenSuffix?: string;
  status: '待领取' | '进行中' | '结果可查看' | '已结束';
}

export interface AuthorizationDetail {
  id: string;
  tokenSuffix?: string;
  status: AuthorizationListDisplayStatus;
  createdAt: Date;
  claimedAt?: Date;
  numberAcquisitionExpiresAt?: Date;
  resultViewUntil?: Date;
  endPromptUntil?: Date;
  endedAt?: Date;
  endedReason?: string;
  lastActivityAt?: Date;
  acquisitionCount: number;
  canRevoke: boolean;
  revocationConsequence?: string;
  acquisition?: {
    countryName: string;
    status: '获取结果确认中' | '结果待人工对账';
    position: number;
  };
  unrecognizedSmsText?: string;
  activation?: {
    countryName: string;
    position: number;
    providerActivationId: string;
    activationCost: number;
    currency: string;
    status: 'acquisition_confirming' | 'waiting_sms' | 'cancellation_confirming' | 'cancelled' | 'manual_reconciliation' | 'sms_delivered' | 'completion_confirming' | 'completed' | 'timed_out';
    numberExpiresAt: Date;
    /** 仅非终态（waiting_sms、cancellation_confirming、sms_delivered 等）时为 true，前端据此决定是否显示倒计时。 */
    numberExpiresAtCountdown: boolean;
    revocationFinalizing: boolean;
    phoneNumber?: string;
    verificationCode?: string;
    unrecognizedSmsText?: string;
  };
  candidates: Array<{
    position: number;
    countryName: string;
    used: boolean;
    recentAcquisitionResult?: {
      kind: 'confirmed_absent' | 'failed';
      errorKind?: string;
      determinedAt: Date;
    };
  }>;
  activations: Array<{
    position: number;
    countryName: string;
    providerActivationId: string;
    status: 'acquisition_confirming' | 'waiting_sms' | 'cancellation_confirming' | 'cancelled' | 'manual_reconciliation' | 'sms_delivered' | 'completion_confirming' | 'completed' | 'timed_out';
    activationCost: number;
    currency: string;
    acquiredAt: Date;
    refundConfirmed?: number;
    refundPending: boolean;
  }>;
  costs: Array<{ currency: string; activationCost: number; confirmedRefund: number; netCost: number }>;
}

export type RecipientAuthorizationState = 'available' | 'claimed' | 'unavailable' | 'not-found';

export interface RecipientAuthorizationView {
  state: RecipientAuthorizationState;
  hasAcquiredNumber: boolean;
  expiresAt?: Date;
  countryName?: string;
  phoneNumber?: string;
  acquiredAt?: Date;
  cancelAvailableAt?: Date;
  numberExpiresAt?: Date;
  remainingNumberCount?: number;
  acquisitionState?: 'confirming' | 'manual';
  currentNumberAction?: 'replace' | 'end';
  currentNumberActionAvailable?: boolean;
  currentNumberActionInProgress?: 'replace' | 'end';
  activationTimeoutInProgress?: boolean;
  nextNumberAvailable?: boolean;
  resultViewUntil?: Date;
  resultViewRemainingMs?: number;
  quotaExhaustedPromptUntil?: Date;
  smsDelivered?: boolean;
  verificationCode?: string;
}

export type ReplacementResult =
  | { state: 'replaced' | 'ended' | 'confirming' | 'no-numbers' | 'error' }
  | { state: 'too-early' | 'unavailable' | 'not-found' };

type ReplacementTransition =
  | { kind: 'not-found' | 'unavailable' | 'too-early' | 'no-numbers' }
  | { kind: 'cancel'; activationId: string; claimToken: string };

type NumberAcquisitionOutcome =
  | 'acquired'
  | 'already-active'
  | 'confirming'
  | 'paused'
  | 'no-numbers'
  | 'error'
  | 'expired'
  | 'unavailable';

interface NumberAcquisitionOptions {
  clearPendingReplacement: boolean;
}

type PreparedNumberCandidate = {
  position: number;
  countryId: number;
  requestedPrice: number;
};

type PreparedNumberAcquisition =
  | { kind: 'expired' | 'unavailable' | 'already-active' | 'no-candidates' | 'configuration-error' }
  | { kind: 'ready'; candidates: PreparedNumberCandidate[] };

export interface HeroSmsWebhookEvent {
  activationId: string;
  serviceCode: string;
  countryId: number;
  receivedAt: Date;
  text: string;
  code?: string;
}

export type ClaimResult =
  | { state: 'claimed' | 'confirming' | 'no-numbers' | 'error' }
  | { state: 'unavailable' | 'not-found' | 'claim-failed' };

export interface AcquisitionReconciliation {
  id: string;
  tokenSuffix?: string;
  countryName: string;
  status: '获取结果确认中' | '结果待人工对账';
  requestedAt: Date;
  candidates: Array<{ activationId: string; countryId?: number; activationTime?: Date }>;
}

export class AuthorizationValidationError extends Error {}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const AUTHORIZATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_COLLISION_RETRIES = 100;
const defaultAuthorizationTokenGenerator: AuthorizationTokenGenerator = {
  generate: () => randomBytes(32).toString('base64url'),
};

function generatedToken(generator: AuthorizationTokenGeneratorInput): string {
  const token = typeof generator === 'function' ? generator() : generator.generate();
  if (!AUTHORIZATION_TOKEN_PATTERN.test(token)) {
    throw new Error('授权 token 必须是 256 位以上的 Base64URL 值');
  }
  return token;
}

function tokenCollisionConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (!('code' in error) || error.code !== '23505') return false;
  const constraint = 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : '';
  return constraint === 'activation_authorizations_token_suffix_idx' || constraint === 'activation_authorizations_token_hash_idx';
}

function parseBatchQuantity(value: unknown): number {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(raw)) {
    throw new AuthorizationValidationError('创建数量必须是 1 至 50 的整数。');
  }
  const quantity = Number(raw);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 50) {
    throw new AuthorizationValidationError('创建数量必须是 1 至 50 的整数。');
  }
  return quantity;
}

function isAuthorizationAccessible(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt > now;
}

function optionalDate(value: Date | null): Date | undefined {
  return value ?? undefined;
}

type AuthorizationDeadlineRow = {
  number_acquisition_expires_at?: Date | null;
};

function authorizationAcquisitionDeadline(row: AuthorizationDeadlineRow | null | undefined): Date | null {
  return row?.number_acquisition_expires_at ?? null;
}

interface NormalizedProviderActivationTimes {
  acquiredAt: Date;
  expiresAt: Date;
}

function normalizeProviderActivationTimes(number: HeroSmsNumber, confirmedAt: Date): NormalizedProviderActivationTimes {
  const providerAcquiredAt = number.activationTime;
  const acquiredAt = providerAcquiredAt
    && Number.isFinite(providerAcquiredAt.getTime())
    && Math.abs(providerAcquiredAt.getTime() - confirmedAt.getTime()) <= 5 * 60 * 1000
    ? providerAcquiredAt
    : confirmedAt;
  const providerExpiresAt = number.activationEndTime;
  const expiresAt = providerExpiresAt
    && Number.isFinite(providerExpiresAt.getTime())
    && providerExpiresAt > acquiredAt
    && Math.abs(providerExpiresAt.getTime() - acquiredAt.getTime()) <= 30 * 60 * 1000
    ? providerExpiresAt
    : new Date(acquiredAt.getTime() + 20 * 60 * 1000);
  return { acquiredAt, expiresAt };
}

function resultViewDeadline(receivedAt: Date): Date {
  return new Date(receivedAt.getTime() + RESULT_VIEW_LIFETIME_MS);
}

/** 供应商状态处理结果的四类可观测性分类：等待短信静默不告警（调用点不记录），其余按严重程度记录极简 stdout 日志。 */
type ProviderStatusOutcome = 'cancelled' | 'uncertain' | 'response';

/** 状态查询异常的两档映射：格式错误（契约破坏）为 response，其余（网络错误、限流、上游临时故障等）统一为 uncertain。 */
function providerStatusOutcomeOf(error: unknown): 'uncertain' | 'response' {
  return error instanceof HeroSmsResponseError && error.kind === 'response' ? 'response' : 'uncertain';
}

/** 极简 stdout 日志：等待短信是正常中间态，调用点静默不产生告警；供应商取消 info、网络错误 warn、格式错误 error。 */
function logProviderStatus(activationId: string, outcome: ProviderStatusOutcome): void {
  let level: 'info' | 'warn' | 'error';
  let message: string;
  if (outcome === 'cancelled') {
    level = 'info';
    message = '供应商已取消';
  } else if (outcome === 'uncertain') {
    level = 'warn';
    message = '状态查询失败（网络错误或供应商临时故障）';
  } else {
    level = 'error';
    message = '状态查询返回格式错误（无法识别的响应）';
  }
  process.stdout.write(`[herosms][${level}] 激活 ${activationId} ${message}\n`);
}

export class ActivationAuthorizations {
  constructor(
    private readonly database: Database,
    private readonly heroSms: HeroSms,
    private readonly openAiServiceCode: string,
    private readonly now: () => Date = () => new Date(),
    private readonly tokenGenerator: AuthorizationTokenGeneratorInput = defaultAuthorizationTokenGenerator,
  ) {}

  async expireDue(): Promise<void> {
    await this.database.expireDueAuthorizations(this.now());
    await this.deleteExpiredSensitiveDeliveryData();
  }

  private async expireQuotaExhaustedPrompt(authorizationId?: string): Promise<void> {
    const now = this.now();
    await this.database.pool.query(
      `UPDATE activation_authorizations
       SET token_hash = NULL
       WHERE status = 'ended' AND ended_reason = $1 AND end_prompt_until IS NOT NULL
         AND end_prompt_until <= $2 AND ($3::uuid IS NULL OR id = $3)`,
      [QUOTA_EXHAUSTED_ENDED_REASON, now, authorizationId ?? null],
    );
  }

  private async endForExhaustedQuota(client: PoolClient, authorizationId: string, now: Date): Promise<void> {
    const ended = await client.query(
      `UPDATE activation_authorizations auth
       SET status = 'ended', ended_reason = $2, ended_at = $3,
           end_prompt_until = $4, last_activity_at = $3
       WHERE auth.id = $1 AND auth.status = 'in_progress'
         AND NOT EXISTS (
           SELECT 1 FROM authorization_candidate_countries candidate
           WHERE candidate.authorization_id = auth.id AND candidate.used_at IS NULL
         )`,
      [authorizationId, QUOTA_EXHAUSTED_ENDED_REASON, now, new Date(now.getTime() + END_PROMPT_LIFETIME_MS)],
    );
    if (!ended.rowCount) return;
    await client.query(
      `UPDATE supplier_activations
       SET phone_number = NULL, sms_code = NULL, sms_text = NULL
       WHERE authorization_id = $1`,
      [authorizationId],
    );
  }

  async nextRecipientAccessExpiry(): Promise<Date | undefined> {
    const result = await this.database.pool.query<{ expires_at: Date | null }>(
      `SELECT min(deadline) AS expires_at
       FROM (
         SELECT CASE
           WHEN auth.status = 'result_available' THEN auth.result_view_until
           WHEN auth.status = 'ended' AND auth.ended_reason = $1 THEN auth.end_prompt_until
           WHEN auth.status = 'in_progress' AND (
             EXISTS (
               SELECT 1 FROM supplier_activations activation
               WHERE activation.authorization_id = auth.id
                 AND activation.status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'completion_confirming')
             ) OR EXISTS (
               SELECT 1 FROM number_acquisition_requests request
               WHERE request.authorization_id = auth.id AND request.status IN ('requesting', 'reconciling', 'manual')
             )
           ) THEN NULL
           ELSE auth.number_acquisition_expires_at
         END AS deadline
         FROM activation_authorizations auth
         WHERE auth.token_hash IS NOT NULL
       ) access_deadlines
       WHERE deadline IS NOT NULL`,
      [QUOTA_EXHAUSTED_ENDED_REASON],
    );
    return result.rows[0]?.expires_at || undefined;
  }

  async nextPendingRevocationCancellation(): Promise<Date | undefined> {
    const now = this.now();
    const result = await this.database.pool.query<{ cancel_available_at: Date | null }>(
      `SELECT min(GREATEST(activation.cancel_available_at, COALESCE(activation.cancellation_retry_after, activation.cancel_available_at))) AS cancel_available_at
       FROM supplier_activations activation
       JOIN activation_authorizations auth ON auth.id = activation.authorization_id
       WHERE activation.status IN ('waiting_sms', 'manual_reconciliation')
         AND activation.authorization_revocation_cancellation_pending
         AND (auth.status <> 'in_progress' OR auth.number_acquisition_expires_at > $1 OR auth.ended_reason = 'admin_revoked')`,
      [now],
    );
    return result.rows[0]?.cancel_available_at || undefined;
  }

  async batchPreflight(quantityValue: unknown): Promise<BatchAuthorizationPreflight> {
    return { quantity: parseBatchQuantity(quantityValue) };
  }

  async createBatch(quantityValue: unknown): Promise<CreatedAuthorization[]> {
    const quantity = parseBatchQuantity(quantityValue);
    const createdAt = this.now();
    let tokens = Array.from({ length: quantity }, () => generatedToken(this.tokenGenerator));

    for (let attempt = 0; attempt < MAX_TOKEN_COLLISION_RETRIES; attempt += 1) {
      try {
        const ids = await this.database.createUnclaimedAuthorizationBatch(tokens.map((token) => ({
          tokenHash: tokenHash(token),
          tokenSuffix: token.slice(-8),
          createdAt,
        })));
        return ids.map((id, index) => ({ id, token: tokens[index]!, tokenSuffix: tokens[index]!.slice(-8) }));
      } catch (error) {
        if (error instanceof AuthorizationTokenSuffixCollisionError) {
          const index = tokens.findIndex((token) => token.slice(-8) === error.suffix);
          if (index < 0) throw error;
          tokens[index] = generatedToken(this.tokenGenerator);
          continue;
        }
        if (tokenCollisionConstraint(error)) {
          tokens = Array.from({ length: quantity }, () => generatedToken(this.tokenGenerator));
          continue;
        }
        throw error;
      }
    }
    throw new Error('批量生成授权 token 失败');
  }

  async list(query: AuthorizationListQuery = {}): Promise<AuthorizationListPage> {
    return this.database.listActivationAuthorizations(query, this.now());
  }

  async revoke(id: string): Promise<boolean> {
    const cancellation = await this.database.transaction(async (client) => {
      const result = await client.query<{
        status: AuthorizationStatus; number_acquisition_expires_at: Date | null; result_view_until: Date | null;
      }>('SELECT status, number_acquisition_expires_at, result_view_until FROM activation_authorizations WHERE id = $1 FOR UPDATE', [id]);
      const authorization = result.rows[0];
      const now = this.now();
      const pendingAcquisition = authorization?.status === 'in_progress'
        ? await client.query(
          "SELECT 1 FROM number_acquisition_requests WHERE authorization_id = $1 AND status IN ('requesting', 'reconciling', 'manual') LIMIT 1",
          [id],
        )
        : undefined;
      const activeActivation = authorization?.status === 'in_progress'
        ? await client.query(
          "SELECT 1 FROM supplier_activations WHERE authorization_id = $1 AND status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'completion_confirming') LIMIT 1",
          [id],
        )
        : undefined;
      const resultViewAccessible = authorization?.status === 'result_available'
        && authorization.result_view_until !== null && authorization.result_view_until > now;
      const accessDeadline = authorization ? authorizationAcquisitionDeadline(authorization) : null;
      if (!authorization
        || (!isAuthorizationAccessible(accessDeadline, now) && !resultViewAccessible && !activeActivation?.rowCount && !pendingAcquisition?.rowCount)
        || authorization.status === 'ended') return undefined;
      await client.query(
        `UPDATE activation_authorizations
         SET status = 'ended',
             ended_at = $2, ended_reason = 'admin_revoked', last_activity_at = $2,
             token_hash = NULL
         WHERE id = $1`,
        [id, now],
      );
      // 撤销立即清理号码、验证码和短信正文；未决号码获取请求保留非敏感事实，
      // 由后台对账在重启后继续确认供应商结果并在允许时取消，但绝不重新交付或恢复接收者访问。
      await client.query(
        `UPDATE supplier_activations SET phone_number = NULL, sms_code = NULL, sms_text = NULL
         WHERE authorization_id = $1`,
        [id],
      );
      await client.query(
        `DELETE FROM number_acquisition_candidates candidate USING number_acquisition_requests request
         WHERE candidate.request_id = request.id AND request.authorization_id = $1`,
        [id],
      );
      const activationResult = await client.query<{ provider_activation_id: string; status: string; cancel_available_at: Date; expires_at: Date }>(
        `SELECT provider_activation_id, status, cancel_available_at, expires_at FROM supplier_activations
         WHERE authorization_id = $1 AND status IN ('waiting_sms', 'cancellation_confirming', 'manual_reconciliation')
         ORDER BY acquired_at DESC LIMIT 1 FOR UPDATE`,
        [id],
      );
      const activation = activationResult.rows[0];
      if (!activation) return null;
      // 撤销后的供应商收尾不受号码窗口和领取期限约束：达到最早可取消时间即请求取消，
      // 窗口已经结束的取消确认也交由取消响应与超时对账安全收尾，避免任务永久滞留。
      if (activation.status === 'cancellation_confirming' || activation.cancel_available_at > now) {
        await client.query(
          "UPDATE supplier_activations SET replacement_pending = false, end_use_pending = false, authorization_revocation_cancellation_pending = true WHERE provider_activation_id = $1",
          [activation.provider_activation_id],
        );
        return null;
      }
      // 转态时即写入对账租约：请求供应商期间，并发对账或另一实例不会抢 claim 同一激活；
      // 撤销路由的同步取消完成后释放租约，由对账按实际到期时间接管。
      const claimToken = randomBytes(16).toString('base64url');
      await client.query(
        `UPDATE supplier_activations SET status = 'cancellation_confirming', replacement_pending = false, end_use_pending = false,
           authorization_revocation_cancellation_pending = true,
           cancellation_reconciliation_claimed_at = $2, cancellation_reconciliation_claim_token = $3
         WHERE provider_activation_id = $1`,
        [activation.provider_activation_id, now, claimToken],
      );
      return { providerActivationId: activation.provider_activation_id, claimToken };
    });
    if (cancellation === undefined) return false;
    if (cancellation) {
      await this.cancelRevokedActivation(cancellation.providerActivationId, cancellation.claimToken);
    } else {
      // 撤销时激活已处于“取消确认中”：打标记后立即对账一次，不再干等周期任务。
      await this.reconcileCancellationConfirmations().catch(() => undefined);
    }
    return true;
  }

  /** 释放转态入口持有的对账租约：仅清除本执行者（claim_token 匹配）设置的租约字段。
   *  转态时写入租约用于堵住并发对账抢 claim，调用结束（含异常）后释放，
   *  让对账按实际到期时间接管并在 claim 时重新持久化 60 秒重试期限。 */
  private async releaseCancellationLease(providerActivationId: string, claimToken: string): Promise<void> {
    await this.database.pool.query(
      `UPDATE supplier_activations
       SET cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL
       WHERE provider_activation_id = $1 AND cancellation_reconciliation_claim_token = $2`,
      [providerActivationId, claimToken],
    ).catch(() => undefined);
  }

  private async cancelRevokedActivation(providerActivationId: string, claimToken: string): Promise<void> {
    try {
      const result = await this.heroSms.cancelActivation(providerActivationId);
      if (result === 'cancelled') {
        await this.confirmCancellation(providerActivationId);
      } else if (result === 'too-early') {
        await this.database.pool.query(
          `UPDATE supplier_activations SET status = 'waiting_sms', authorization_revocation_cancellation_pending = true,
             cancellation_retry_after = $2
           WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'`,
          [providerActivationId, new Date(this.now().getTime() + CANCELLATION_RETRY_DELAY_MS)],
        );
        await this.releaseCancellationLease(providerActivationId, claimToken);
      } else {
        // 短信已送达（或供应商返回其它非取消结果）：撤销后不再请求取消，改为查询状态按完成收尾。
        // 释放转态租约，让立即对账马上接管，不等待租约到期。
        await this.releaseCancellationLease(providerActivationId, claimToken);
        await this.reconcileCancellationConfirmations();
      }
    } catch {
      // 请求结果不明确：释放转态租约，由对账按实际到期时间接管（claim 时重新持久化重试期限）。
      await this.releaseCancellationLease(providerActivationId, claimToken);
    }
  }

  async detail(id: string): Promise<AuthorizationDetail | undefined> {
    await this.deleteExpiredSensitiveDeliveryData();
    const result = await this.database.pool.query<{
      id: string; token_suffix: string | null; authorization_status: AuthorizationStatus;
      created_at: Date; claimed_at: Date | null; number_acquisition_expires_at: Date | null;
      result_view_until: Date | null; end_prompt_until: Date | null; ended_at: Date | null; ended_reason: string | null; last_activity_at: Date | null;
      country_name: string | null; activation_status: NonNullable<AuthorizationDetail['activation']>['status'] | null; number_expires_at: Date | null;
      provider_activation_id: string | null; activation_position: number | null; activation_cost: string | null; activation_currency: string | null;
      sms_code: string | null; sms_text: string | null; phone_number: string | null; used_count: string; acquisition_status: 'requesting' | 'reconciling' | 'manual' | null;
      acquisition_country_name: string | null; acquisition_position: number | null; cancel_available_at: Date | null;
      authorization_revocation_cancellation_pending: boolean | null;
    }>(
      `SELECT auth.id, auth.token_suffix, auth.status AS authorization_status,
              auth.created_at, auth.claimed_at,
              auth.number_acquisition_expires_at,
              COALESCE(auth.result_view_until, (
                SELECT max(item.sms_received_at) + INTERVAL '5 minutes'
                FROM supplier_activations item
                WHERE item.authorization_id = auth.id AND item.sms_received_at IS NOT NULL
              )) AS result_view_until,
              auth.end_prompt_until,
              auth.ended_at, auth.ended_reason, auth.last_activity_at,
              candidate.country_name, activation.status AS activation_status, activation.expires_at AS number_expires_at,
              activation.provider_activation_id, candidate.position AS activation_position,
              activation.activation_cost::text AS activation_cost, activation.currency AS activation_currency,
              activation.phone_number, activation.sms_code, activation.sms_text,
              (SELECT count(*) FROM authorization_candidate_countries candidate WHERE candidate.authorization_id = auth.id AND candidate.used_at IS NOT NULL)::text AS used_count,
              acquisition.status AS acquisition_status, acquisition.country_name AS acquisition_country_name,
              acquisition.candidate_position AS acquisition_position,
              activation.cancel_available_at,
              activation.authorization_revocation_cancellation_pending
       FROM activation_authorizations auth
       LEFT JOIN LATERAL (
         SELECT * FROM supplier_activations item WHERE item.authorization_id = auth.id ORDER BY item.acquired_at DESC LIMIT 1
       ) activation ON true
       LEFT JOIN LATERAL (
         SELECT request.status, request.candidate_position, candidate.country_name
         FROM number_acquisition_requests request
         JOIN authorization_candidate_countries candidate
           ON candidate.authorization_id = request.authorization_id AND candidate.position = request.candidate_position
         WHERE request.authorization_id = auth.id AND request.status IN ('requesting', 'reconciling', 'manual')
         ORDER BY request.requested_at DESC LIMIT 1
       ) acquisition ON true
       LEFT JOIN authorization_candidate_countries candidate
         ON candidate.authorization_id = auth.id AND candidate.position = activation.candidate_position
       WHERE auth.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const [candidateResult, activationResult] = await Promise.all([
      this.database.pool.query<{
        position: number; country_name: string; used_at: Date | null;
        recent_result_kind: 'confirmed_absent' | 'failed' | null; recent_result_error_kind: string | null; recent_result_updated_at: Date | null;
      }>(
        `SELECT candidate.position, candidate.country_name, candidate.used_at,
                recent.status AS recent_result_kind, recent.error_kind AS recent_result_error_kind,
                recent.updated_at AS recent_result_updated_at
         FROM authorization_candidate_countries candidate
         LEFT JOIN LATERAL (
           SELECT request.status, request.error_kind, request.updated_at, request.id
           FROM number_acquisition_requests request
           WHERE request.authorization_id = candidate.authorization_id
             AND request.candidate_position = candidate.position
             AND request.status IN ('confirmed_absent', 'failed')
             AND (request.error_kind IS NULL OR request.error_kind NOT IN ('authorization-expired', 'authorization-unavailable', 'active-activation', 'sms-delivered'))
           ORDER BY request.updated_at DESC, request.id DESC
           LIMIT 1
         ) recent ON true
         WHERE candidate.authorization_id = $1
         ORDER BY candidate.position`, [id],
      ),
      this.database.pool.query<{
        position: number; country_name: string; provider_activation_id: string; status: NonNullable<AuthorizationDetail['activation']>['status']; activation_cost: string; currency: string;
        acquired_at: Date; refund_amount: string | null; refund_reconciliation_status: 'pending' | 'resolved';
      }>(
        `SELECT candidate.position, candidate.country_name, activation.provider_activation_id, activation.status, activation.activation_cost::text, activation.currency, activation.acquired_at,
                refund.amount::text AS refund_amount, activation.refund_reconciliation_status
         FROM supplier_activations activation
         JOIN authorization_candidate_countries candidate
           ON candidate.authorization_id = activation.authorization_id AND candidate.position = activation.candidate_position
         LEFT JOIN supplier_activation_refunds refund ON refund.supplier_activation_id = activation.id
         WHERE activation.authorization_id = $1 ORDER BY activation.acquired_at`, [id],
      ),
    ]);
    const activations = activationResult.rows.map((activation) => ({
      position: activation.position, countryName: activation.country_name, providerActivationId: activation.provider_activation_id, status: activation.status, activationCost: Number(activation.activation_cost),
      currency: activation.currency, acquiredAt: activation.acquired_at,
      ...(activation.refund_amount ? { refundConfirmed: Number(activation.refund_amount) } : {}),
      refundPending: activation.refund_reconciliation_status === 'pending',
    }));
    const costsByCurrency = new Map<string, { activationCost: number; confirmedRefund: number }>();
    for (const activation of activations) {
      const cost = costsByCurrency.get(activation.currency) ?? { activationCost: 0, confirmedRefund: 0 };
      cost.activationCost += activation.activationCost;
      cost.confirmedRefund += activation.refundConfirmed ?? 0;
      costsByCurrency.set(activation.currency, cost);
    }
    const costs = [...costsByCurrency.entries()].map(([currency, cost]) => ({ ...cost, currency, netCost: cost.activationCost - cost.confirmedRefund }));
    const ACTIVE_ACTIVATION_STATUSES = new Set(['acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'sms_delivered', 'completion_confirming']);
    const canRevoke = (isAuthorizationAccessible(authorizationAcquisitionDeadline(row), this.now())
      || (row.authorization_status === 'result_available' && row.result_view_until !== null && row.result_view_until > this.now())
      || (row.authorization_status === 'in_progress' && row.activation_status !== null && ACTIVE_ACTIVATION_STATUSES.has(row.activation_status))
      || (row.authorization_status === 'in_progress' && row.acquisition_status !== null))
      && row.authorization_status !== 'ended';
    const revocationConsequence = !canRevoke ? undefined
      : row.acquisition_status ? '先完成供应商对账，确认号码后取消。'
        : row.activation_status === 'waiting_sms'
          ? (row.cancel_available_at && row.cancel_available_at > this.now() ? '将在可取消时请求取消当前供应商激活。'
            : row.number_expires_at && row.number_expires_at <= this.now() ? '当前激活已结束，仅终止接收者访问。' : '立即请求取消当前供应商激活。')
          : row.authorization_status === 'result_available' ? '只终止接收者访问，不请求供应商取消。'
            : '立即终止接收者访问。';
    const detailNow = this.now();
    const ordinaryDeliveryDataVisible = row.ended_reason !== RESULT_VIEW_ENDED_REASON
      && row.number_expires_at !== null && row.number_expires_at > detailNow;
    const deliveryDataVisible = ordinaryDeliveryDataVisible
      || (row.authorization_status === 'result_available' && row.result_view_until !== null && row.result_view_until > detailNow);
    return {
      id: row.id,
      ...(row.token_suffix !== null ? { tokenSuffix: row.token_suffix } : {}),
      status: AUTHORIZATION_STATUS_LABELS[row.authorization_status],
      createdAt: row.created_at,
      ...(optionalDate(row.claimed_at) ? { claimedAt: row.claimed_at! } : {}),
      ...(optionalDate(row.number_acquisition_expires_at) ? { numberAcquisitionExpiresAt: row.number_acquisition_expires_at! } : {}),
      ...(optionalDate(row.result_view_until) ? { resultViewUntil: row.result_view_until! } : {}),
      ...(optionalDate(row.end_prompt_until) ? { endPromptUntil: row.end_prompt_until! } : {}),
      ...(optionalDate(row.ended_at) ? { endedAt: row.ended_at! } : {}),
      ...(row.ended_reason ? { endedReason: row.ended_reason } : {}),
      ...(optionalDate(row.last_activity_at) ? { lastActivityAt: row.last_activity_at! } : {}),
      acquisitionCount: Number(row.used_count), canRevoke,
      candidates: candidateResult.rows.map((candidate) => ({
        position: candidate.position,
        countryName: candidate.country_name,
        used: candidate.used_at !== null,
        ...(candidate.used_at === null && candidate.recent_result_kind && candidate.recent_result_updated_at ? { recentAcquisitionResult: {
          kind: candidate.recent_result_kind,
          ...(candidate.recent_result_error_kind ? { errorKind: candidate.recent_result_error_kind } : {}),
          determinedAt: candidate.recent_result_updated_at,
        } } : {}),
      })),
      activations,
      costs,
      ...(revocationConsequence ? { revocationConsequence } : {}),
      ...(!row.sms_code && deliveryDataVisible && row.sms_text ? { unrecognizedSmsText: row.sms_text } : {}),
      ...(row.acquisition_status && row.acquisition_country_name && row.acquisition_position !== null ? { acquisition: {
        countryName: row.acquisition_country_name,
        position: row.acquisition_position,
        status: row.acquisition_status === 'manual' ? '结果待人工对账' as const : '获取结果确认中' as const,
      } } : {}),
      ...(row.country_name && row.activation_status && ACTIVE_ACTIVATION_STATUSES.has(row.activation_status) && row.number_expires_at && row.provider_activation_id !== null && row.activation_position !== null && row.activation_cost !== null && row.activation_currency !== null ? { activation: {
        countryName: row.country_name, status: row.activation_status, numberExpiresAt: row.number_expires_at,
        position: row.activation_position, providerActivationId: row.provider_activation_id,
        activationCost: Number(row.activation_cost), currency: row.activation_currency,
        numberExpiresAtCountdown: true,
        revocationFinalizing: row.activation_status === 'waiting_sms' && row.authorization_revocation_cancellation_pending === true,
        ...(deliveryDataVisible && row.phone_number ? { phoneNumber: row.phone_number } : {}),
        ...(deliveryDataVisible && row.sms_code ? { verificationCode: row.sms_code } : {}),
        ...(!row.sms_code && deliveryDataVisible && row.sms_text ? { unrecognizedSmsText: row.sms_text } : {}),
      } } : {}),
    };
  }

  private async endResultView(client: PoolClient, authorizationId: string, now: Date, viewUntil?: Date): Promise<void> {
    await client.query(
      `UPDATE activation_authorizations
       SET status = 'ended', result_view_until = COALESCE(result_view_until, $3),
           ended_at = COALESCE(ended_at, $2), ended_reason = COALESCE(ended_reason, $4),
           token_hash = NULL, last_activity_at = $2
       WHERE id = $1 AND status IN ('in_progress', 'result_available')`,
      [authorizationId, now, viewUntil ?? now, RESULT_VIEW_ENDED_REASON],
    );
    await client.query(
      `UPDATE supplier_activations
       SET phone_number = NULL, sms_code = NULL, sms_text = NULL
       WHERE authorization_id = $1`,
      [authorizationId],
    );
  }

  private async expireResultView(authorizationId?: string): Promise<void> {
    const now = this.now();
    await this.database.transaction(async (client) => {
      const expired = await client.query<{ id: string }>(
        `SELECT id FROM activation_authorizations
         WHERE status = 'result_available' AND result_view_until IS NOT NULL AND result_view_until <= $1
           AND ($2::uuid IS NULL OR id = $2)
         FOR UPDATE`,
        [now, authorizationId ?? null],
      );
      for (const authorization of expired.rows) await this.endResultView(client, authorization.id, now);
    });
    await this.expireQuotaExhaustedPrompt(authorizationId);
  }

  async recipientState(token: string): Promise<RecipientAuthorizationView> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found', hasAcquiredNumber: false };
    const target = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM activation_authorizations WHERE token_hash = $1', [tokenHash(token)],
    );
    if (!target.rows[0]) return { state: 'not-found', hasAcquiredNumber: false };
    await this.expireResultView(target.rows[0].id);
    // 页面访问也必须让二十分钟边界生效，不能等待下一次分钟扫描继续交付旧号码。
    await this.reconcileTimedOutActivations(target.rows[0].id);
    await this.deleteExpiredSensitiveDeliveryData();
    const result = await this.database.pool.query<{
      id: string; status: AuthorizationStatus; ended_reason: string | null;
      number_acquisition_expires_at: Date | null; result_view_until: Date | null; end_prompt_until: Date | null; country_name: string | null; phone_number: string | null;
      acquired_at: Date | null; cancel_available_at: Date | null; number_expires_at: Date | null; used_count: string; candidate_count: string;
      acquisition_status: 'requesting' | 'reconciling' | 'manual' | null; activation_status: string | null; end_use_pending: boolean | null; sms_code: string | null;
      last_activation_status: string | null; last_activation_timed_out_at: Date | null;
    }>(
      `SELECT auth.id, auth.status, auth.ended_reason, auth.number_acquisition_expires_at,
              COALESCE(auth.result_view_until, (
                SELECT max(item.sms_received_at) + INTERVAL '5 minutes'
                FROM supplier_activations item
                WHERE item.authorization_id = auth.id AND item.sms_received_at IS NOT NULL
              )) AS result_view_until,
              auth.end_prompt_until,
              candidate.country_name, activation.phone_number, activation.acquired_at,
              activation.cancel_available_at, activation.expires_at AS number_expires_at,
              activation.status AS activation_status, activation.end_use_pending, activation.sms_code,
              (SELECT count(*) FROM authorization_candidate_countries candidate_count WHERE candidate_count.authorization_id = auth.id)::text AS candidate_count,
              (SELECT count(*) FROM authorization_candidate_countries used WHERE used.authorization_id = auth.id AND used.used_at IS NOT NULL)::text AS used_count,
              acquisition.status AS acquisition_status, last_activation.status AS last_activation_status,
              last_activation.timed_out_at AS last_activation_timed_out_at
       FROM activation_authorizations auth
       LEFT JOIN supplier_activations activation ON activation.authorization_id = auth.id AND activation.status IN ('waiting_sms', 'cancellation_confirming', 'sms_delivered', 'completion_confirming', 'completed', 'manual_reconciliation')
       LEFT JOIN authorization_candidate_countries candidate ON candidate.authorization_id = auth.id AND candidate.position = activation.candidate_position
       LEFT JOIN LATERAL (
         SELECT status FROM number_acquisition_requests request
         WHERE request.authorization_id = auth.id AND request.status IN ('requesting', 'reconciling', 'manual')
         ORDER BY request.requested_at DESC LIMIT 1
       ) acquisition ON true
       LEFT JOIN LATERAL (
         SELECT status, timed_out_at FROM supplier_activations item
         WHERE item.authorization_id = auth.id ORDER BY item.acquired_at DESC LIMIT 1
       ) last_activation ON true
       WHERE auth.token_hash = $1`,
      [tokenHash(token)],
    );
    const authorization = result.rows[0];
    if (!authorization) return { state: 'not-found', hasAcquiredNumber: false };
    const now = this.now();
    const accessDeadline = authorizationAcquisitionDeadline(authorization);
    if (accessDeadline !== null && accessDeadline <= now
      && !(authorization.status === 'result_available'
        && authorization.result_view_until && authorization.result_view_until > now)
      && !(authorization.status === 'ended'
        && authorization.ended_reason === QUOTA_EXHAUSTED_ENDED_REASON
        && authorization.end_prompt_until && authorization.end_prompt_until > now)
      && !(authorization.status === 'in_progress'
        && authorization.activation_status && ['acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'completion_confirming'].includes(authorization.activation_status))
      && !(authorization.status === 'in_progress'
        && authorization.acquisition_status && ['requesting', 'reconciling', 'manual'].includes(authorization.acquisition_status))) {
      await this.database.expireAuthorization(authorization.id, now);
      return { state: 'not-found', hasAcquiredNumber: Number(authorization.used_count) > 0 };
    }
    const expiresAt = optionalDate(authorizationAcquisitionDeadline(authorization));
    const hasAcquiredNumber = Number(authorization.used_count) > 0;
    if (authorization.status === 'unclaimed') {
      return {
        state: 'available', hasAcquiredNumber,
        ...(expiresAt ? { expiresAt } : {}),
      };
    }
    if (authorization.status === 'ended'
      && authorization.ended_reason === QUOTA_EXHAUSTED_ENDED_REASON
      && authorization.end_prompt_until && authorization.end_prompt_until > now) {
      return { state: 'claimed', hasAcquiredNumber, quotaExhaustedPromptUntil: authorization.end_prompt_until };
    }
    if (authorization.status === 'ended') {
      return { state: 'unavailable', hasAcquiredNumber, ...(expiresAt ? { expiresAt } : {}) };
    }
    const deliveryContextVisible = authorization.activation_status !== 'manual_reconciliation' || authorization.last_activation_timed_out_at === null;
    const remainingNumberCount = Number(authorization.candidate_count) - Number(authorization.used_count);
    return {
      state: 'claimed', hasAcquiredNumber, ...(expiresAt ? { expiresAt } : {}),
      ...(authorization.country_name ? { countryName: authorization.country_name } : {}),
      ...(deliveryContextVisible && authorization.phone_number ? { phoneNumber: authorization.phone_number } : {}),
      ...(authorization.acquired_at ? { acquiredAt: authorization.acquired_at } : {}),
      ...(authorization.cancel_available_at ? { cancelAvailableAt: authorization.cancel_available_at } : {}),
      ...(authorization.number_expires_at ? { numberExpiresAt: authorization.number_expires_at } : {}),
      ...(authorization.result_view_until ? {
        resultViewUntil: authorization.result_view_until,
        resultViewRemainingMs: Math.max(0, authorization.result_view_until.getTime() - now.getTime()),
      } : {}),
      remainingNumberCount,
      ...(authorization.acquisition_status ? { acquisitionState: authorization.acquisition_status === 'manual' ? 'manual' as const : 'confirming' as const } : {}),
      // 领取截止后不得更换号码或创建后继号码：窗口内的当前号码只能结束使用。
      // waiting_sms 必然已领取，领取时写入的截止时间保证 expiresAt 已定义，防御分支只为类型安全。
      ...(authorization.activation_status === 'waiting_sms'
        ? { currentNumberAction: (expiresAt === undefined || expiresAt <= now || remainingNumberCount === 0) ? 'end' as const : 'replace' as const } : {}),
      ...(authorization.activation_status === 'waiting_sms'
        && authorization.cancel_available_at && authorization.cancel_available_at <= now
        ? { currentNumberActionAvailable: true } : {}),
      ...(authorization.activation_status === 'cancellation_confirming'
        ? { currentNumberActionInProgress: authorization.end_use_pending ? 'end' as const : 'replace' as const } : {}),
      ...(authorization.last_activation_status === 'manual_reconciliation' && authorization.last_activation_timed_out_at ? { activationTimeoutInProgress: true } : {}),
      ...(authorization.last_activation_status === 'timed_out' && remainingNumberCount > 0 ? { nextNumberAvailable: true } : {}),
      ...(authorization.status === 'result_available' ? { smsDelivered: true } : {}),
      ...(authorization.sms_code ? { verificationCode: authorization.sms_code } : {}),
    };
  }

  async receiveHeroSmsWebhook(event: HeroSmsWebhookEvent): Promise<'accepted' | 'ignored'> {
    const payloadDigest = createHash('sha256').update(JSON.stringify({
      activationId: event.activationId, serviceCode: event.serviceCode, countryId: event.countryId,
      receivedAt: event.receivedAt.toISOString(), text: event.text, code: event.code ?? null,
    })).digest('hex');
    return this.database.transaction(async (client) => {
      // 换号命令始终先锁授权再锁激活；Webhook 保持相同顺序以避免竞争时死锁。
      const found = await client.query<{ authorization_id: string; country_id: number }>(
        'SELECT authorization_id, country_id FROM supplier_activations WHERE provider_activation_id = $1',
        [event.activationId],
      );
      const candidate = found.rows[0];
      if (!candidate || candidate.country_id !== event.countryId || event.serviceCode !== this.openAiServiceCode) return 'ignored';
      const authorizationResult = await client.query<{ status: AuthorizationStatus; ended_reason: string | null; result_view_until: Date | null }>(
        'SELECT status, ended_reason, result_view_until FROM activation_authorizations WHERE id = $1 FOR UPDATE',
        [candidate.authorization_id],
      );
      const authorization = authorizationResult.rows[0];
      const activation = await client.query<{
        id: string; authorization_id: string; country_id: number; status: string; acquired_at: Date; expires_at: Date;
        supplier_cancelled_at: Date | null; sms_received_at: Date | null; timed_out_at: Date | null;
      }>(
        'SELECT id, authorization_id, country_id, status, acquired_at, expires_at, supplier_cancelled_at, sms_received_at, timed_out_at FROM supplier_activations WHERE provider_activation_id = $1 FOR UPDATE',
        [event.activationId],
      );
      const current = activation.rows[0];
      if (!authorization || !current || current.country_id !== event.countryId || event.serviceCode !== this.openAiServiceCode) return 'ignored';
      const inserted = await client.query(
        `INSERT INTO hero_sms_events (provider_activation_id, received_at, payload_digest, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [event.activationId, event.receivedAt, payloadDigest, this.now()],
      );
      // 撤销单已无接收者访问，不受窗口约束：即使同一送达事件此前已被对账记录（幂等冲突），
      // 也必须按完成收尾，否则“撤销单 + 窗口外送达 + 事件已记录”会让取消确认中永久滞留。
      const revoked = authorization.status === 'ended' && authorization.ended_reason === 'admin_revoked';
      if (!inserted.rowCount && !revoked) return 'accepted';

      // 供应商报告的短信送达时间是唯一有效性依据，号码窗口采用严格半开区间；
      // 撤销单不受窗口约束：短信已到达即按完成收尾并在供应商侧释放号码，
      // 避免“撤销单 + 窗口外送达”成为取消确认中的永久滞留路径。
      if (!revoked && (event.receivedAt < current.acquired_at || event.receivedAt >= current.expires_at)) return 'accepted';
      const now = this.now();
      const viewUntil = resultViewDeadline(event.receivedAt);
      const smsBeforeCancellation = current.status === 'cancelled'
        && current.supplier_cancelled_at !== null
        && event.receivedAt <= current.supplier_cancelled_at;
      if (current.status === 'timed_out' || smsBeforeCancellation) {
        const successor = await client.query(
          `SELECT 1 FROM supplier_activations
           WHERE authorization_id = $1 AND id <> $2
             AND status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'completion_confirming')
           LIMIT 1`,
          [current.authorization_id, current.id],
        );
        if (successor.rowCount) return 'accepted';
      }
      if (current.status === 'waiting_sms' || current.status === 'cancellation_confirming' || current.status === 'manual_reconciliation' || current.status === 'timed_out' || smsBeforeCancellation) {
        await client.query(
          `UPDATE supplier_activations
           SET status = 'completion_confirming', sms_code = $2, sms_text = $3, sms_received_at = $4, sms_poll_after = NULL,
               replacement_pending = false, end_use_pending = false, authorization_expiry_cancellation_pending = false,
               authorization_revocation_cancellation_pending = false,
               cancellation_retry_after = NULL,
               cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL,
               refund_reconciliation_status = CASE WHEN status = 'manual_reconciliation' THEN 'resolved' ELSE refund_reconciliation_status END,
               timeout_reconciliation_claimed_at = NULL, timeout_reconciliation_claim_token = NULL
           WHERE id = $1 AND status IN ('waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'timed_out', 'cancelled')`,
          [current.id, event.code ?? null, event.text, event.receivedAt],
        );
        if (smsBeforeCancellation) {
          // 取消确认后才收到事件，但供应商送达时间早于取消时间时，短信事实胜过退款确认；
          // 删除错误的退款事实，避免并发竞态伪造退款，同时不恢复接收者访问。
          await client.query('DELETE FROM supplier_activation_refunds WHERE supplier_activation_id = $1', [current.id]);
        }
        if (!['in_progress', 'result_available'].includes(authorization.status)) {
          await client.query(
            `UPDATE supplier_activations
             SET phone_number = NULL, sms_code = NULL, sms_text = NULL
             WHERE id = $1`,
            [current.id],
          );
          return 'accepted';
        }
        await this.stopPendingAcquisitionRequests(client, current.authorization_id, now);
        if (now >= viewUntil) {
          await this.endResultView(client, current.authorization_id, now, viewUntil);
        } else if (authorization.status === 'in_progress') {
          await client.query(
            `UPDATE activation_authorizations
             SET status = 'result_available', result_view_until = $2, last_activity_at = $3
             WHERE id = $1 AND status = 'in_progress'`,
            [current.authorization_id, viewUntil, now],
          );
        } else {
          await client.query(
            `UPDATE activation_authorizations
             SET last_activity_at = $2
             WHERE id = $1 AND status = 'result_available'`,
            [current.authorization_id, now],
          );
        }
      } else if (event.code && ['completion_confirming', 'completed', 'sms_delivered'].includes(current.status)) {
        // 轮询可能先取得正文，后续才取得供应商提供的结构化验证码。
        if (authorization.status !== 'result_available') return 'accepted';
        if (!authorization.result_view_until || authorization.result_view_until <= now) {
          await this.endResultView(client, current.authorization_id, now);
        } else {
          await client.query(
            `UPDATE supplier_activations
             SET sms_code = COALESCE(sms_code, $2), sms_text = COALESCE(sms_text, $3),
                 sms_received_at = COALESCE(sms_received_at, $4), sms_poll_after = NULL
             WHERE id = $1 AND status IN ('completion_confirming', 'completed', 'sms_delivered')`,
            [current.id, event.code, event.text, event.receivedAt],
          );
          await client.query(
            `UPDATE activation_authorizations
             SET last_activity_at = $2
             WHERE id = $1 AND status = 'result_available'`,
            [current.authorization_id, now],
          );
        }
      }
      return 'accepted';
    });
  }

  async finishDeliveredActivations(providerActivationId?: string): Promise<void> {
    for (;;) {
      const claimed = await this.database.transaction(async (client) => {
        const candidate = await client.query<{ id: string; provider_activation_id: string; authorization_id: string }>(
          `SELECT activation.id, activation.provider_activation_id, activation.authorization_id
           FROM supplier_activations activation
           WHERE activation.status = 'completion_confirming'
             AND (activation.completion_claimed_at IS NULL OR activation.completion_claimed_at <= $1)
             AND ($2::text IS NULL OR activation.provider_activation_id = $2)
           ORDER BY activation.sms_received_at LIMIT 1`,
          [new Date(this.now().getTime() - 5 * 60 * 1000), providerActivationId ?? null],
        );
        const row = candidate.rows[0];
        if (!row) return null;
        await client.query('SELECT id FROM activation_authorizations WHERE id = $1 FOR UPDATE', [row.authorization_id]);
        const updated = await client.query<{ id: string; provider_activation_id: string }>(
          `UPDATE supplier_activations
           SET completion_claimed_at = $2
           WHERE id = $1 AND status = 'completion_confirming'
             AND (completion_claimed_at IS NULL OR completion_claimed_at <= $3)
           RETURNING id, provider_activation_id`,
          [row.id, this.now(), new Date(this.now().getTime() - 5 * 60 * 1000)],
        );
        return updated.rows[0];
      });
      const activation = claimed;
      if (activation === null) return;
      if (!activation) continue;
      try {
        await this.heroSms.finishActivation(activation.provider_activation_id);
        await this.updateCompletionClaim(activation.id, 'completed');
      } catch (error) {
        if (error instanceof HeroSmsResponseError && error.kind === 'uncertain') {
          // 完成请求结果不明确时读取供应商状态；已结束则确认完成，仍可查询短信则保留任务重试。
          const reconciled = await this.heroSms.activationStatus(activation.provider_activation_id).catch(() => undefined);
          if (reconciled?.providerStatus === 'cancelled') {
            await this.updateCompletionClaim(activation.id, 'manual_reconciliation');
            continue;
          }
        }
        await this.updateCompletionClaim(activation.id, 'release');
        return;
      }
    }
  }

  private async updateCompletionClaim(activationId: string, outcome: 'completed' | 'manual_reconciliation' | 'release'): Promise<void> {
    const update = outcome === 'completed'
      ? "UPDATE supplier_activations SET status = 'completed', completed_at = $2, completion_claimed_at = NULL WHERE id = $1 AND status = 'completion_confirming'"
      : outcome === 'manual_reconciliation'
        ? "UPDATE supplier_activations SET status = 'manual_reconciliation', completion_claimed_at = NULL WHERE id = $1 AND status = 'completion_confirming'"
        : "UPDATE supplier_activations SET completion_claimed_at = NULL WHERE id = $1 AND status = 'completion_confirming'";
    await this.database.transaction(async (client) => {
      const activation = await client.query<{ authorization_id: string }>(
        'SELECT authorization_id FROM supplier_activations WHERE id = $1', [activationId],
      );
      const authorizationId = activation.rows[0]?.authorization_id;
      if (!authorizationId) return;
      await client.query('SELECT id FROM activation_authorizations WHERE id = $1 FOR UPDATE', [authorizationId]);
      await client.query(update, outcome === 'completed' ? [activationId, this.now()] : [activationId]);
      // 完成确认和异常终局是真实业务事实；release 只是释放任务锁，不推进活动时间。
      if (outcome !== 'release') {
        await this.touchLastActivity(client, authorizationId, this.now());
      }
    });
  }

  async pollWaitingActivations(): Promise<void> {
    const now = this.now();
    const polled = await this.database.pool.query<{
      provider_activation_id: string; country_id: number; sms_received_at: Date | null; sms_text: string | null;
    }>(
      `UPDATE supplier_activations activation SET sms_poll_after = $2
       WHERE activation.id IN (
         SELECT activation.id FROM supplier_activations activation
         JOIN activation_authorizations auth ON auth.id = activation.authorization_id
         WHERE (
           (activation.status = 'waiting_sms' AND activation.expires_at > $1)
           OR (activation.status IN ('completion_confirming', 'completed', 'sms_delivered')
             AND auth.status = 'result_available' AND auth.result_view_until > $1)
           OR (activation.status = 'manual_reconciliation' AND activation.timed_out_at IS NULL
             AND auth.status = 'result_available' AND auth.result_view_until > $1)
         )
           AND (activation.sms_code IS NULL OR activation.status = 'waiting_sms')
           AND (activation.sms_poll_after IS NULL OR activation.sms_poll_after <= $1)
         ORDER BY activation.acquired_at FOR UPDATE OF activation SKIP LOCKED
       )
       RETURNING activation.provider_activation_id, activation.country_id, activation.sms_received_at, activation.sms_text`,
      [now, new Date(now.getTime() + 60_000)],
    );
    for (const activation of polled.rows) {
      let status: HeroSmsActivationStatus;
      try {
        status = await this.heroSms.activationStatus(activation.provider_activation_id);
      } catch (error) {
        // 轮询是 Webhook 的恢复机制：失败只记录、不处理，留待下次任务；
        // 网络错误 warn 与格式错误 error 分开记录，等待状态不产生告警。
        logProviderStatus(activation.provider_activation_id, providerStatusOutcomeOf(error));
        continue;
      }
      const receivedAt = status.receivedAt ?? activation.sms_received_at;
      const text = status.text ?? activation.sms_text;
      if (status.delivered && text && receivedAt) {
        try {
          await this.receiveHeroSmsWebhook({
            activationId: activation.provider_activation_id, serviceCode: this.openAiServiceCode, countryId: activation.country_id,
            receivedAt, text, ...(status.code ? { code: status.code } : {}),
          });
        } catch {
          // 轮询是 Webhook 的恢复机制：短信落库失败只跳过本条，留待下次任务，不中断本轮其余激活。
        }
        continue;
      }
      if (status.providerStatus === 'cancelled') {
        // 轮询路径对供应商取消只记录、不处理：上游主动取消仍由既有超时对账收尾。
        logProviderStatus(activation.provider_activation_id, 'cancelled');
      }
      // 等待短信静默不告警；下一次轮询由 claim 时写入的 sms_poll_after 按约 60 秒推进。
    }
  }

  async deleteExpiredSensitiveDeliveryData(): Promise<void> {
    const now = this.now();
    await this.database.transaction(async (client) => {
      const expired = await client.query<{ id: string }>(
        `SELECT id FROM activation_authorizations
         WHERE status IN ('result_available')
           AND ((result_view_until IS NOT NULL AND result_view_until <= $1))
         FOR UPDATE`,
        [now],
      );
      for (const authorization of expired.rows) await this.endResultView(client, authorization.id, now);
      await client.query(
        `UPDATE activation_authorizations
         SET token_hash = NULL
         WHERE status = 'ended' AND ended_reason = $1 AND end_prompt_until IS NOT NULL
           AND end_prompt_until <= $2`,
        [QUOTA_EXHAUSTED_ENDED_REASON, now],
      );
      await client.query(
        `UPDATE supplier_activations activation
         SET phone_number = NULL, sms_code = NULL, sms_text = NULL
         WHERE activation.expires_at <= $1
           AND (activation.phone_number IS NOT NULL OR activation.sms_code IS NOT NULL OR activation.sms_text IS NOT NULL)
           AND NOT (
             activation.status IN ('waiting_sms', 'cancellation_confirming')
             OR (
               activation.status = 'manual_reconciliation'
               AND activation.timed_out_at IS NOT NULL
               AND activation.refund_reconciliation_status = 'pending'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM activation_authorizations auth
             WHERE auth.id = activation.authorization_id
               AND auth.status = 'result_available'
               AND auth.result_view_until > $1
           )`,
        [now],
      );
    });
  }

  async reconcileTimedOutActivations(authorizationId?: string): Promise<void> {
    const now = this.now();
    // 号码有效窗口到期后先进入供应商对账；只有确认窗口内未送达，才进入“已超时”明确终态。
    // 异常状态形成（进入人工对账）是真实业务事实，同时推进父授权活动时间。
    await this.database.pool.query(
      `WITH moved AS (
         UPDATE supplier_activations
         SET status = 'manual_reconciliation', timed_out_at = COALESCE(timed_out_at, $1),
             refund_reconciliation_status = 'pending', timeout_reconciliation_claimed_at = NULL,
             timeout_reconciliation_claim_token = NULL, replacement_pending = false, end_use_pending = false,
             authorization_expiry_cancellation_pending = false,
             authorization_revocation_cancellation_pending = false,
             cancellation_retry_after = NULL,
             cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL,
             sms_code = NULL, sms_text = NULL, sms_poll_after = NULL
         WHERE id IN (
           SELECT id FROM supplier_activations
           WHERE status IN ('waiting_sms', 'cancellation_confirming') AND expires_at <= $1
             AND ($2::uuid IS NULL OR authorization_id = $2)
             AND NOT EXISTS (
               SELECT 1 FROM activation_authorizations auth
               WHERE auth.id = supplier_activations.authorization_id
                 AND auth.status = 'ended' AND auth.ended_reason = 'admin_revoked'
             )
           ORDER BY expires_at FOR UPDATE SKIP LOCKED
         )
         RETURNING authorization_id
       )
       UPDATE activation_authorizations auth
       SET last_activity_at = $1
       FROM moved
       WHERE auth.id = moved.authorization_id`,
      [now, authorizationId ?? null],
    );

    const reconciliationClaimToken = randomBytes(16).toString('base64url');
    const claimed = await this.database.pool.query<{
      id: string; provider_activation_id: string; acquired_at: Date; expires_at: Date; status: 'manual_reconciliation' | 'timed_out';
    }>(
      `UPDATE supplier_activations
       SET timeout_reconciliation_claimed_at = $1, timeout_reconciliation_claim_token = $3
       WHERE id IN (
         SELECT id FROM supplier_activations
         WHERE ((status = 'manual_reconciliation' AND timed_out_at IS NOT NULL) OR status = 'timed_out')
           AND refund_reconciliation_status = 'pending'
           AND (timeout_reconciliation_claimed_at IS NULL OR timeout_reconciliation_claimed_at <= $2)
           AND ($4::uuid IS NULL OR authorization_id = $4)
           AND NOT EXISTS (
             SELECT 1 FROM activation_authorizations auth
             WHERE auth.id = supplier_activations.authorization_id
               AND auth.status = 'ended' AND auth.ended_reason = 'admin_revoked'
           )
         ORDER BY expires_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, provider_activation_id, acquired_at, expires_at, status`,
      [now, new Date(now.getTime() - 5 * 60 * 1000), reconciliationClaimToken, authorizationId ?? null],
    );

    for (const activation of claimed.rows) {
      if (activation.status === 'timed_out') {
        await this.reconcileTimedOutRefund(activation, reconciliationClaimToken, now);
        continue;
      }

      let finalStatus;
      try {
        finalStatus = await this.heroSms.activationStatus(activation.provider_activation_id);
      } catch (error) {
        // 状态查询失败（网络错误 warn 或格式错误 error）只记录并释放租约，由下一次扫描继续对账。
        logProviderStatus(activation.provider_activation_id, providerStatusOutcomeOf(error));
        await this.releaseTimeoutReconciliation(activation.id, reconciliationClaimToken);
        continue;
      }

      if (finalStatus.delivered) {
        if (!finalStatus.receivedAt) {
          // 无法证明短信在号码有效窗口内送达时，保持供应商对账，不能凭猜测改变后继资格。
          await this.releaseTimeoutReconciliation(activation.id, reconciliationClaimToken);
        } else if (finalStatus.receivedAt >= activation.acquired_at && finalStatus.receivedAt < activation.expires_at) {
          // 窗口内已送达的短信必须胜过超时，禁止再开放后继号码；窗口已结束，敏感数据仍立即删除。
          await this.recordTimedOutDelivery(activation.id, reconciliationClaimToken, {
            receivedAt: finalStatus.receivedAt,
            ...(finalStatus.code ? { code: finalStatus.code } : {}),
            ...(finalStatus.text ? { text: finalStatus.text } : {}),
          });
        } else {
          // 临界点及窗口后的迟到短信不改变已经发生的激活超时，也不能恢复敏感交付数据。
          await this.confirmTimedOutFinalStatus(activation.id, reconciliationClaimToken);
          await this.resolveTimeoutRefund(activation.id, reconciliationClaimToken, false);
        }
        continue;
      }
      if (finalStatus.providerStatus !== 'cancelled') {
        // 等待短信（对象形式或 V1 字符串）不是最终状态，必须继续供应商对账，不能抢先开放后继号码；等待静默不告警。
        await this.releaseTimeoutReconciliation(activation.id, reconciliationClaimToken);
        continue;
      }
      logProviderStatus(activation.provider_activation_id, 'cancelled');
      await this.recordSupplierCancellation(activation.id, reconciliationClaimToken);
      // 供应商已经确认取消；退款仍可继续对账，但不再阻塞接收者自行获取下一个号码。
      await this.confirmTimedOutFinalStatus(activation.id, reconciliationClaimToken);

      await this.reconcileTimedOutRefund(activation, reconciliationClaimToken, now);
    }
  }

  private async reconcileTimedOutRefund(
    activation: { id: string; provider_activation_id: string; acquired_at: Date },
    claimToken: string,
    now: Date,
  ): Promise<void> {
    try {
      const history = await this.heroSms.activationHistory(
        new Date(activation.acquired_at.getTime() - 5 * 60 * 1000),
        now,
      );
      const record = history.find((item) => item.activationId === activation.provider_activation_id);
      if (!record || record.activationCost !== 0) {
        // 尚无零费用历史事实时不能确认退款，保留任务供下一次扫描或重启恢复。
        await this.releaseTimeoutReconciliation(activation.id, claimToken);
        return;
      }
      await this.resolveTimeoutRefund(activation.id, claimToken, true);
    } catch {
      await this.releaseTimeoutReconciliation(activation.id, claimToken);
    }
  }

  private async confirmTimedOutFinalStatus(activationId: string, claimToken: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const activationResult = await client.query<{ authorization_id: string }>(
        `SELECT authorization_id FROM supplier_activations
         WHERE id = $1 AND status = 'manual_reconciliation' AND timed_out_at IS NOT NULL
           AND timeout_reconciliation_claim_token = $2`,
        [activationId, claimToken],
      );
      const authorizationId = activationResult.rows[0]?.authorization_id;
      if (!authorizationId) return;
      await client.query('SELECT id FROM activation_authorizations WHERE id = $1 FOR UPDATE', [authorizationId]);
      const confirmed = await client.query<{ authorization_id: string }>(
        `UPDATE supplier_activations
         SET status = 'timed_out', timeout_final_status_confirmed_at = COALESCE(timeout_final_status_confirmed_at, $3)
         WHERE id = $1 AND status = 'manual_reconciliation' AND timed_out_at IS NOT NULL
           AND timeout_reconciliation_claim_token = $2
         RETURNING authorization_id`,
        [activationId, claimToken, this.now()],
      );
      const confirmedAuthorizationId = confirmed.rows[0]?.authorization_id;
      if (!confirmedAuthorizationId) return;
      await client.query(
        `UPDATE supplier_activations
         SET phone_number = NULL, sms_code = NULL, sms_text = NULL
         WHERE id = $1`,
        [activationId],
      );
      // 供应商超时确认是推动父授权排序的真实业务事实。
      await this.touchLastActivity(client, confirmedAuthorizationId, this.now());
      await this.endForExhaustedQuota(client, confirmedAuthorizationId, this.now());
    });
  }

  private async recordTimedOutDelivery(
    activationId: string,
    claimToken: string,
    delivery: { receivedAt: Date; code?: string; text?: string },
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const activationResult = await client.query<{ authorization_id: string }>(
        `SELECT authorization_id FROM supplier_activations
         WHERE id = $1 AND status = 'manual_reconciliation' AND timed_out_at IS NOT NULL
           AND timeout_reconciliation_claim_token = $2`,
        [activationId, claimToken],
      );
      const authorizationId = activationResult.rows[0]?.authorization_id;
      if (!authorizationId) return;
      await client.query('SELECT id FROM activation_authorizations WHERE id = $1 FOR UPDATE', [authorizationId]);
      const result = await client.query<{ authorization_id: string }>(
        `UPDATE supplier_activations
         SET status = 'completion_confirming', refund_reconciliation_status = 'resolved',
             sms_code = $3, sms_text = $4, sms_received_at = $5, sms_poll_after = NULL,
             timeout_reconciliation_claimed_at = NULL, timeout_reconciliation_claim_token = NULL
         WHERE id = $1 AND status = 'manual_reconciliation' AND timed_out_at IS NOT NULL
           AND timeout_reconciliation_claim_token = $2
         RETURNING authorization_id`,
        [activationId, claimToken, delivery.code ?? null, delivery.text ?? null, delivery.receivedAt],
      );
      const confirmedAuthorizationId = result.rows[0]?.authorization_id;
      if (!confirmedAuthorizationId) return;
      const now = this.now();
      const viewUntil = resultViewDeadline(delivery.receivedAt);
      const authorization = await client.query<{ status: AuthorizationStatus }>(
        'SELECT status FROM activation_authorizations WHERE id = $1', [confirmedAuthorizationId],
      );
      if (!['in_progress', 'result_available'].includes(authorization.rows[0]?.status ?? '')) {
        await client.query(
          `UPDATE supplier_activations
           SET phone_number = NULL, sms_code = NULL, sms_text = NULL
           WHERE id = $1`,
          [activationId],
        );
        return;
      }
      await this.stopPendingAcquisitionRequests(client, confirmedAuthorizationId, now);
      if (now >= viewUntil) {
        await this.endResultView(client, confirmedAuthorizationId, now, viewUntil);
      } else if (authorization.rows[0]?.status === 'in_progress') {
        await client.query(
          `UPDATE activation_authorizations
           SET status = 'result_available', result_view_until = $2, last_activity_at = $3
           WHERE id = $1 AND status = 'in_progress'`,
          [confirmedAuthorizationId, viewUntil, now],
        );
      } else {
        // 授权已处于结果可查看时，超时恢复送达的短信同样是新事实。
        await client.query(
          `UPDATE activation_authorizations
           SET last_activity_at = $2
           WHERE id = $1 AND status = 'result_available'`,
          [confirmedAuthorizationId, now],
        );
      }
    });
  }

  private async recordSupplierCancellation(activationId: string, claimToken: string): Promise<void> {
    await this.database.pool.query(
      `UPDATE supplier_activations
       SET supplier_cancelled_at = COALESCE(supplier_cancelled_at, $3)
       WHERE id = $1 AND status = 'manual_reconciliation' AND timed_out_at IS NOT NULL
         AND timeout_reconciliation_claim_token = $2`,
      [activationId, claimToken, this.now()],
    );
  }

  private async releaseTimeoutReconciliation(activationId: string, claimToken: string): Promise<void> {
    await this.database.pool.query(
      `UPDATE supplier_activations
       SET timeout_reconciliation_claimed_at = NULL, timeout_reconciliation_claim_token = NULL
       WHERE id = $1 AND status IN ('manual_reconciliation', 'timed_out') AND timed_out_at IS NOT NULL
         AND refund_reconciliation_status = 'pending' AND timeout_reconciliation_claim_token = $2`,
      [activationId, claimToken],
    );
  }

  private async resolveTimeoutRefund(activationId: string, claimToken: string, refundConfirmed: boolean): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<{ authorization_id: string; activation_cost: string; currency: string }>(
        `SELECT authorization_id, activation_cost::text, currency FROM supplier_activations
         WHERE id = $1 AND status = 'timed_out' AND timeout_reconciliation_claim_token = $2 FOR UPDATE`,
        [activationId, claimToken],
      );
      const activation = result.rows[0];
      if (!activation) return;
      if (refundConfirmed) {
        await client.query(
          `INSERT INTO supplier_activation_refunds (supplier_activation_id, amount, currency, confirmed_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT (supplier_activation_id) DO NOTHING`,
          [activationId, activation.activation_cost, activation.currency, this.now()],
        );
        // 退款确认是真实业务事实，推动父授权排序。
        await this.touchLastActivity(client, activation.authorization_id, this.now());
      }
      await client.query(
        `UPDATE supplier_activations
         SET refund_reconciliation_status = 'resolved', timeout_reconciliation_claimed_at = NULL,
             timeout_reconciliation_claim_token = NULL
         WHERE id = $1 AND status = 'timed_out' AND timeout_reconciliation_claim_token = $2`,
        [activationId, claimToken],
      );
    });
  }

  /** 列表排序的唯一事实推进入口：只有真实业务事实才更新父授权最近活动时间。 */
  private async touchLastActivity(client: PoolClient, authorizationId: string, at: Date): Promise<void> {
    await client.query(
      'UPDATE activation_authorizations SET last_activity_at = $2 WHERE id = $1',
      [authorizationId, at],
    );
  }

  private async expireAuthorization(client: PoolClient, authorizationId: string, now: Date): Promise<void> {
    // 与数据库层 expireAuthorization 保持同一结束语义：存在活跃激活（窗口内当前号码）时
    // 不结束也不清理凭据，进入只允许当前号码收尾的阶段，避免后续送达的短信结果被丢弃。
    await client.query(
      `UPDATE activation_authorizations
       SET status = 'ended',
           ended_at = COALESCE(ended_at, $2),
           ended_reason = COALESCE(ended_reason, 'acquisition_expired'),
           token_hash = NULL, last_activity_at = $2
       WHERE id = $1 AND number_acquisition_expires_at <= $2
         AND status NOT IN ('result_available', 'ended')
         AND NOT (status = 'ended' AND end_prompt_until > $2)
         AND NOT (
           status = 'in_progress' AND EXISTS (
             SELECT 1 FROM supplier_activations activation
             WHERE activation.authorization_id = activation_authorizations.id
               AND activation.status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'completion_confirming')
           )
         )
         AND NOT (
           status = 'in_progress' AND EXISTS (
             SELECT 1 FROM number_acquisition_requests request
             WHERE request.authorization_id = activation_authorizations.id
               AND request.status IN ('requesting', 'reconciling', 'manual')
           )
         )`,
      [authorizationId, now],
    );
  }

  async requestNumberReplacement(token: string): Promise<ReplacementResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found' };
    const target = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM activation_authorizations WHERE token_hash = $1', [tokenHash(token)],
    );
    if (!target.rows[0]) return { state: 'not-found' };
    await this.expireResultView(target.rows[0].id);
    await this.reconcileTimedOutActivations(target.rows[0].id);
    const transition = await this.database.transaction(async (client): Promise<ReplacementTransition> => {
      const authorizationResult = await client.query<{ id: string; status: string; number_acquisition_expires_at: Date | null }>(
        'SELECT id, status, number_acquisition_expires_at FROM activation_authorizations WHERE token_hash = $1 FOR UPDATE',
        [tokenHash(token)],
      );
      const authorization = authorizationResult.rows[0];
      const now = this.now();
      const acquisitionExpiresAt = authorizationAcquisitionDeadline(authorization);
      if (!authorization || !acquisitionExpiresAt) return { kind: 'not-found' };
      const accessible = authorization.status === 'in_progress';
      if (acquisitionExpiresAt <= now) {
        // 领取截止后不能更换号码或创建后继号码；窗口内当前号码仍可结束使用。
        if (!accessible) {
          await this.expireAuthorization(client, authorization.id, now);
          return { kind: 'not-found' };
        }
      } else if (!accessible) {
        return { kind: 'unavailable' };
      }
      const candidates = await client.query<{ has_unused: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM authorization_candidate_countries WHERE authorization_id = $1 AND used_at IS NULL) AS has_unused',
        [authorization.id],
      );
      const endingUse = acquisitionExpiresAt <= now || !candidates.rows[0]?.has_unused;
      const currentResult = await client.query<{ provider_activation_id: string; cancel_available_at: Date; cancellation_retry_after: Date | null }>(
        `SELECT provider_activation_id, cancel_available_at, cancellation_retry_after FROM supplier_activations
         WHERE authorization_id = $1 AND status = 'waiting_sms' FOR UPDATE`,
        [authorization.id],
      );
      const current = currentResult.rows[0];
      // 重试期限未到（上次取消返回 too-early 后）的重复提交不得提前请求供应商，
      // 也不得覆盖已持久化的操作意图：直接返回 too-early，由后台在期限后自动重试。
      if (!current || current.cancel_available_at > now || (current.cancellation_retry_after !== null && current.cancellation_retry_after > now)) return { kind: 'too-early' };
      // 转态时即写入对账租约：事务提交后请求供应商期间，并发对账不会抢 claim 同一激活；
      // 换号/结束使用调用完成后释放租约，由对账按实际到期时间接管。
      const claimToken = randomBytes(16).toString('base64url');
      const updated = await client.query(
        `UPDATE supplier_activations
         SET status = 'cancellation_confirming', replacement_pending = $2, end_use_pending = $3,
             cancellation_reconciliation_claimed_at = $4, cancellation_reconciliation_claim_token = $5
         WHERE authorization_id = $1 AND status = 'waiting_sms'`,
        [authorization.id, !endingUse, endingUse, now, claimToken],
      );
      return updated.rowCount === 1
        ? { kind: 'cancel', activationId: current.provider_activation_id, claimToken }
        : { kind: 'unavailable' };
    });
    if (transition.kind !== 'cancel') return { state: transition.kind };

    try {
      const cancellation = await this.heroSms.cancelActivation(transition.activationId);
      if (cancellation === 'too-early') {
        // 保留换号/结束使用意图并持久化 60 秒重试期限，由后台任务在期限后自动重发取消。
        await this.database.pool.query(
          `UPDATE supplier_activations SET status = 'waiting_sms', cancellation_retry_after = $2
           WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'`,
          [transition.activationId, new Date(this.now().getTime() + CANCELLATION_RETRY_DELAY_MS)],
        );
        await this.releaseCancellationLease(transition.activationId, transition.claimToken);
        return { state: 'too-early' };
      }
      if (cancellation === 'sms-delivered') {
        // 短信已送达：释放转态租约，让立即对账马上接管交付收尾，不等待租约到期。
        await this.releaseCancellationLease(transition.activationId, transition.claimToken);
        await this.reconcileCancellationConfirmations();
        return { state: 'confirming' };
      }
      const confirmed = await this.confirmCancellation(transition.activationId);
      if (!confirmed) return { state: 'confirming' };
      if (confirmed.replacementAllowed) return this.acquireReplacementNumber(confirmed.authorizationId);
      return confirmed.ended ? { state: 'ended' } : { state: 'confirming' };
    } catch {
      // 请求结果不明确时必须保留取消确认状态：释放转态租约，由对账按实际到期时间接管。
      await this.releaseCancellationLease(transition.activationId, transition.claimToken);
      return { state: 'confirming' };
    }
  }

  /** 下一个需要取消确认对账的时间点：取消确认中记录，以及授权到期产生的待取消记录（waiting_sms + 到期取消标记）。
   *  对账调度器按此最早到期时间触发；授权到期来源在 too-early 回退后仍保留到期标记，继续被本查询覆盖。 */
  async nextCancellationConfirmationReconciliation(): Promise<Date | undefined> {
    const result = await this.database.pool.query<{ reconcile_at: Date | null }>(
      `SELECT min(GREATEST(activation.cancel_available_at, COALESCE(activation.cancellation_retry_after, activation.cancel_available_at))) AS reconcile_at
       FROM supplier_activations activation
       WHERE activation.status = 'cancellation_confirming'
          OR (activation.status = 'waiting_sms' AND activation.authorization_expiry_cancellation_pending)`,
    );
    return result.rows[0]?.reconcile_at || undefined;
  }

  async reconcileCancellationConfirmations(): Promise<void> {
    // 取消确认对账的资格判断只有这一处权威实现：所有入口（管理员详情刷新、启动对账、
    // 后台扫描、专用定时器、撤销立即对账）都调用本方法，共享同一条持久化规则——
    // 只有 cancellation_retry_after 为空或已到期，且未被租约锁定的记录才被处理。
    // claim 先持久化下一次处理时间与原子租约再请求供应商：期限写入失败则本轮跳过该记录；
    // 供应商请求异常或未收敛时期限与租约已经落库，任何入口都不会以零延迟循环轰炸供应商 API。
    for (;;) {
      const now = this.now();
      const claimToken = randomBytes(16).toString('base64url');
      const leaseThreshold = new Date(now.getTime() - CANCELLATION_RECONCILIATION_LEASE_MS);
      const claimed = await this.database.pool.query<{ provider_activation_id: string; country_id: number }>(
        `UPDATE supplier_activations activation
         SET cancellation_retry_after = $2,
             cancellation_reconciliation_claimed_at = $1,
             cancellation_reconciliation_claim_token = $3
         WHERE activation.id = (
           SELECT activation.id FROM supplier_activations activation
           WHERE activation.status = 'cancellation_confirming'
             AND (activation.cancellation_retry_after IS NULL OR activation.cancellation_retry_after <= $1)
             AND (activation.cancellation_reconciliation_claimed_at IS NULL OR activation.cancellation_reconciliation_claimed_at <= $4)
           ORDER BY activation.acquired_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING activation.provider_activation_id, activation.country_id`,
        [now, new Date(now.getTime() + CANCELLATION_RETRY_DELAY_MS), claimToken, leaseThreshold],
      );
      const activation = claimed.rows[0];
      if (!activation) return;
      try {
        const status = await this.heroSms.activationStatus(activation.provider_activation_id);
        if (status.providerStatus === 'cancelled') {
          logProviderStatus(activation.provider_activation_id, 'cancelled');
          const confirmed = await this.confirmCancellation(activation.provider_activation_id, claimToken);
          if (confirmed?.replacementAllowed) {
            await this.acquireReplacementNumber(confirmed.authorizationId);
          }
        } else if (status.delivered && status.text && status.receivedAt) {
          await this.receiveHeroSmsWebhook({
            activationId: activation.provider_activation_id,
            serviceCode: this.openAiServiceCode,
            countryId: activation.country_id,
            receivedAt: status.receivedAt,
            text: status.text,
            ...(status.code ? { code: status.code } : {}),
          });
        } else {
          const cancellation = await this.heroSms.cancelActivation(activation.provider_activation_id);
          if (cancellation === 'cancelled') {
            const confirmed = await this.confirmCancellation(activation.provider_activation_id, claimToken);
            if (confirmed?.replacementAllowed) {
              await this.acquireReplacementNumber(confirmed.authorizationId);
            }
          } else if (cancellation === 'sms-delivered') {
            const latestStatus = await this.heroSms.activationStatus(activation.provider_activation_id);
            if (latestStatus.delivered && latestStatus.text && latestStatus.receivedAt) {
              await this.receiveHeroSmsWebhook({
                activationId: activation.provider_activation_id,
                serviceCode: this.openAiServiceCode,
                countryId: activation.country_id,
                receivedAt: latestStatus.receivedAt,
                text: latestStatus.text,
                ...(latestStatus.code ? { code: latestStatus.code } : {}),
              });
            }
          } else if (cancellation === 'too-early') {
            // 保留换号/结束使用/撤销意图并持久化重试期限：回退等待短信后由对应后台任务在期限后自动重发取消。
            await this.database.pool.query(
              `UPDATE supplier_activations
               SET status = 'waiting_sms', cancellation_retry_after = $2,
                   cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL
               WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'
                 AND cancellation_reconciliation_claim_token = $3`,
              [activation.provider_activation_id, new Date(now.getTime() + CANCELLATION_RETRY_DELAY_MS), claimToken],
            );
          }
        }
      } catch (error) {
        // 供应商请求异常：保持取消确认状态；网络错误 warn、格式错误 error 分开记录；
        // 释放租约 token，保留 cancellation_retry_after 重试期限，由专用定时器在期限到达后继续对账，不会以零延迟重试。
        logProviderStatus(activation.provider_activation_id, providerStatusOutcomeOf(error));
        await this.database.pool.query(
          `UPDATE supplier_activations
           SET cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL
           WHERE provider_activation_id = $1 AND cancellation_reconciliation_claim_token = $2`,
          [activation.provider_activation_id, claimToken],
        ).catch(() => undefined);
      }
    }
  }

  async cancelRevokedActivations(): Promise<void> {
    for (;;) {
      const now = this.now();
      const claimToken = randomBytes(16).toString('base64url');
      const claimed = await this.database.pool.query<{ provider_activation_id: string }>(
        // 转态时即写入对账租约：请求供应商期间其他执行者（并发对账、另一实例）不会抢 claim 同一激活。
        `UPDATE supplier_activations activation SET status = 'cancellation_confirming', replacement_pending = false, end_use_pending = false,
                cancellation_reconciliation_claimed_at = $2, cancellation_reconciliation_claim_token = $3
         WHERE activation.id = (
           SELECT activation.id FROM supplier_activations activation
           JOIN activation_authorizations auth ON auth.id = activation.authorization_id
           WHERE activation.status IN ('waiting_sms', 'manual_reconciliation') AND activation.authorization_revocation_cancellation_pending AND activation.cancel_available_at <= $1
             AND (activation.cancellation_retry_after IS NULL OR activation.cancellation_retry_after <= $1)
             AND (auth.status <> 'in_progress' OR auth.number_acquisition_expires_at > $1 OR auth.ended_reason = 'admin_revoked')
           ORDER BY activation.cancel_available_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING activation.provider_activation_id`,
        [now, now, claimToken],
      );
      const activation = claimed.rows[0];
      if (!activation) return;
      await this.cancelRevokedActivation(activation.provider_activation_id, claimToken);
    }
  }

  /** 下一个需要自动重发取消的换号/结束使用激活：查询最早可取消时间与重试期限的较大者。 */
  async nextPendingReplacementCancellation(): Promise<Date | undefined> {
    const result = await this.database.pool.query<{ retry_at: Date | null }>(
      `SELECT min(GREATEST(activation.cancel_available_at, COALESCE(activation.cancellation_retry_after, activation.cancel_available_at))) AS retry_at
       FROM supplier_activations activation
       JOIN activation_authorizations auth ON auth.id = activation.authorization_id
       WHERE activation.status = 'waiting_sms'
         AND (activation.replacement_pending OR activation.end_use_pending)
         AND activation.expires_at > $1
         AND auth.status = 'in_progress'`,
      [this.now()],
    );
    return result.rows[0]?.retry_at || undefined;
  }

  /** 换号/结束使用意图在取消返回 too-early 回退等待短信后的自动重试入口：
   *  只处理号码窗口内且重试期限已到的记录，转入取消确认后重发取消；
   *  撤销与授权到期来源分别由 cancelRevokedActivations 与 cancelAcquisitionsConfirmedAfterAuthorizationExpiry 负责。
   *  领取截止后的结束使用单同样重试：确认取消后不创建后继号码，由授权过期收尾。 */
  async retryPendingReplacementCancellations(): Promise<void> {
    for (;;) {
      const now = this.now();
      // 与取消确认对账相同的 claim 模式：先持久化下一次处理时间与原子租约再请求供应商，
      // 请求异常或未收敛时期限与租约已经落库，任何入口都不会以零延迟循环或并发轰炸供应商 API。
      const claimToken = randomBytes(16).toString('base64url');
      const claimed = await this.database.pool.query<{ provider_activation_id: string }>(
        `UPDATE supplier_activations activation
         SET status = 'cancellation_confirming', cancellation_retry_after = $2,
             cancellation_reconciliation_claimed_at = $3, cancellation_reconciliation_claim_token = $4
         WHERE activation.id = (
           SELECT activation.id FROM supplier_activations activation
           JOIN activation_authorizations auth ON auth.id = activation.authorization_id
           WHERE activation.status = 'waiting_sms'
             AND (activation.replacement_pending OR activation.end_use_pending)
             AND activation.cancel_available_at <= $1
             AND activation.expires_at > $1
             AND (activation.cancellation_retry_after IS NULL OR activation.cancellation_retry_after <= $1)
             AND auth.status = 'in_progress'
           ORDER BY activation.cancellation_retry_after NULLS FIRST, activation.acquired_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING activation.provider_activation_id`,
        [now, new Date(now.getTime() + CANCELLATION_RETRY_DELAY_MS), now, claimToken],
      );
      const activation = claimed.rows[0];
      if (!activation) return;
      try {
        const cancellation = await this.heroSms.cancelActivation(activation.provider_activation_id);
        if (cancellation === 'cancelled') {
          const confirmed = await this.confirmCancellation(activation.provider_activation_id, claimToken);
          if (confirmed?.replacementAllowed) {
            await this.acquireReplacementNumber(confirmed.authorizationId);
          }
        } else if (cancellation === 'too-early') {
          // 保留换号/结束使用意图，再次持久化 60 秒重试期限。
          await this.database.pool.query(
            `UPDATE supplier_activations
             SET status = 'waiting_sms', cancellation_retry_after = $2
             WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'`,
            [activation.provider_activation_id, new Date(now.getTime() + CANCELLATION_RETRY_DELAY_MS)],
          );
        }
        // 短信冲突与不明确结果保持取消确认状态：释放转态租约，交由对账按实际到期时间接管。
        await this.releaseCancellationLease(activation.provider_activation_id, claimToken);
      } catch { /* 取消确认状态与租约已持久化，由对账任务在期限后继续处理。 */ }
    }
  }

  async cancelAcquisitionsConfirmedAfterAuthorizationExpiry(): Promise<void> {
    for (;;) {
      const now = this.now();
      const claimToken = randomBytes(16).toString('base64url');
      const claimed = await this.database.pool.query<{ provider_activation_id: string }>(
        // 到期取消标记是授权到期来源标记，跨取消确认状态保留：
        // 对账返回 too-early 回退等待短信后仍被对账调度器按重试期限覆盖，不会滞留。
        // 转态时即写入对账租约，请求供应商期间并发对账不会抢 claim 同一激活。
        `UPDATE supplier_activations SET status = 'cancellation_confirming',
                cancellation_reconciliation_claimed_at = $2, cancellation_reconciliation_claim_token = $3
         WHERE id = (
           SELECT id FROM supplier_activations
           WHERE status = 'waiting_sms' AND authorization_expiry_cancellation_pending AND cancel_available_at <= $1
             AND (cancellation_retry_after IS NULL OR cancellation_retry_after <= $1)
           ORDER BY cancel_available_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING provider_activation_id`,
        [now, now, claimToken],
      );
      const activation = claimed.rows[0];
      if (!activation) return;
      try {
        const cancellation = await this.heroSms.cancelActivation(activation.provider_activation_id);
        if (cancellation === 'cancelled') {
          await this.confirmCancellation(activation.provider_activation_id);
          continue;
        }
        if (cancellation === 'too-early') {
          // 保留授权到期 pending 标记并持久化 60 秒重试期限，避免回退后零延迟循环请求供应商。
          await this.database.pool.query(
            `UPDATE supplier_activations
             SET status = 'waiting_sms', authorization_expiry_cancellation_pending = true,
                 cancellation_retry_after = $2
             WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'`,
            [activation.provider_activation_id, new Date(now.getTime() + CANCELLATION_RETRY_DELAY_MS)],
          );
        }
        // 短信冲突和不明确结果均保留取消确认状态：释放转态租约，交由对账按实际到期时间接管。
        await this.releaseCancellationLease(activation.provider_activation_id, claimToken);
      } catch {
        // 请求结果不明确：释放转态租约，由对账按实际到期时间接管（claim 时重新持久化重试期限）。
        await this.releaseCancellationLease(activation.provider_activation_id, claimToken);
      }
    }
  }

  async runPendingReplacementAcquisitions(): Promise<void> {
    const now = this.now();
    await this.database.pool.query(
      `UPDATE supplier_activations activation SET replacement_pending = false, end_use_pending = false
       FROM activation_authorizations auth
       WHERE activation.authorization_id = auth.id AND activation.status = 'cancelled' AND activation.replacement_pending
         AND (auth.status <> 'in_progress' OR auth.number_acquisition_expires_at <= $1)`,
      [now],
    );
    const pending = await this.database.pool.query<{ authorization_id: string }>(
      `SELECT activation.authorization_id FROM supplier_activations activation
       JOIN activation_authorizations auth ON auth.id = activation.authorization_id
       WHERE activation.status = 'cancelled' AND activation.replacement_pending
         AND auth.status = 'in_progress' AND auth.number_acquisition_expires_at > $1
       ORDER BY activation.acquired_at`,
      [now],
    );
    for (const replacement of pending.rows) await this.acquireReplacementNumber(replacement.authorization_id);
  }

  private async confirmCancellation(providerActivationId: string, claimToken?: string): Promise<{ authorizationId: string; replacementAllowed: boolean; ended: boolean } | undefined> {
    return this.database.transaction(async (client) => {
      const identity = await client.query<{ authorization_id: string }>(
        `SELECT activation.authorization_id
         FROM supplier_activations activation
         JOIN activation_authorizations auth ON auth.id = activation.authorization_id
           WHERE activation.provider_activation_id = $1 AND activation.status = 'cancellation_confirming'
             AND ($3::text IS NULL OR activation.cancellation_reconciliation_claim_token IS NULL OR activation.cancellation_reconciliation_claim_token = $3)
             AND (
               activation.expires_at > $2
               OR auth.status = 'ended' AND auth.ended_reason = 'admin_revoked'
             )`,
        [providerActivationId, this.now(), claimToken ?? null],
      );
      const authorizationId = identity.rows[0]?.authorization_id;
      if (!authorizationId) return undefined;
      await client.query('SELECT id FROM activation_authorizations WHERE id = $1 FOR UPDATE', [authorizationId]);
      const result = await client.query<{
        id: string; authorization_id: string; replacement_pending: boolean; end_use_pending: boolean; authorization_status: string;
        number_acquisition_expires_at: Date | null;
        activation_cost: string; currency: string;
      }>(
        `SELECT activation.id, activation.authorization_id, activation.replacement_pending, activation.end_use_pending,
                auth.status AS authorization_status,
                auth.number_acquisition_expires_at,
                activation.activation_cost::text, activation.currency
         FROM supplier_activations activation
         JOIN activation_authorizations auth ON auth.id = activation.authorization_id
         WHERE activation.provider_activation_id = $1 AND activation.status = 'cancellation_confirming'
           AND ($3::text IS NULL OR activation.cancellation_reconciliation_claim_token IS NULL OR activation.cancellation_reconciliation_claim_token = $3)
           AND (
             activation.expires_at > $2
             OR auth.status = 'ended' AND auth.ended_reason = 'admin_revoked'
           )
         FOR UPDATE OF activation`,
        [providerActivationId, this.now(), claimToken ?? null],
      );
      const activation = result.rows[0];
      if (!activation) return undefined;
      const confirmedAt = this.now();
      const acquisitionExpiresAt = authorizationAcquisitionDeadline(activation);
      const replacementAllowed = activation.replacement_pending
        && activation.authorization_status === 'in_progress'
        && acquisitionExpiresAt !== null
        && acquisitionExpiresAt > confirmedAt;
      const endsUse = activation.end_use_pending && activation.authorization_status === 'in_progress';
      await client.query(
        `UPDATE supplier_activations
         SET status = 'cancelled', supplier_cancelled_at = COALESCE(supplier_cancelled_at, $2),
             phone_number = NULL, sms_code = NULL, sms_text = NULL, sms_poll_after = NULL,
             replacement_pending = $3, end_use_pending = false, authorization_expiry_cancellation_pending = false,
             authorization_revocation_cancellation_pending = false,
             cancellation_retry_after = NULL,
             cancellation_reconciliation_claimed_at = NULL,
             cancellation_reconciliation_claim_token = NULL,
             refund_reconciliation_status = 'resolved',
             timeout_reconciliation_claimed_at = NULL, timeout_reconciliation_claim_token = NULL
         WHERE id = $1`,
        [activation.id, confirmedAt, replacementAllowed],
      );
      if (endsUse) await this.endForExhaustedQuota(client, activation.authorization_id, confirmedAt);
      await client.query(
        `INSERT INTO supplier_activation_refunds (supplier_activation_id, amount, currency, confirmed_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (supplier_activation_id) DO NOTHING`,
        [activation.id, activation.activation_cost, activation.currency, confirmedAt],
      );
      // 供应商取消确认和退款事实推动父授权排序。
      await this.touchLastActivity(client, activation.authorization_id, confirmedAt);
      return { authorizationId: activation.authorization_id, replacementAllowed, ended: endsUse };
    });
  }

  private async stopPendingAcquisitionRequests(client: PoolClient, authorizationId: string, now: Date): Promise<void> {
    await client.query(
      `UPDATE number_acquisition_requests
       SET status = 'failed', error_kind = 'sms-delivered', updated_at = $2
       WHERE authorization_id = $1 AND status IN ('requesting', 'reconciling', 'manual')`,
      [authorizationId, now],
    );
    await client.query(
      `DELETE FROM number_acquisition_candidates candidate
       USING number_acquisition_requests request
       WHERE candidate.request_id = request.id AND request.authorization_id = $1`,
      [authorizationId],
    );
  }

  private async clearPendingReplacement(authorizationId: string): Promise<void> {
    await this.database.pool.query(
      `UPDATE supplier_activations
       SET replacement_pending = false, end_use_pending = false
       WHERE authorization_id = $1 AND status = 'cancelled' AND replacement_pending`,
      [authorizationId],
    );
  }

  private async prepareNumberAcquisition(
    client: PoolClient,
    authorizationId: string,
    offers: HeroSmsOffer[],
    maxPrice: number,
  ): Promise<PreparedNumberAcquisition> {
    const authorizationResult = await client.query<{ status: string; number_acquisition_expires_at: Date | null }>(
      'SELECT status, number_acquisition_expires_at FROM activation_authorizations WHERE id = $1 FOR UPDATE',
      [authorizationId],
    );
    const authorization = authorizationResult.rows[0];
    const now = this.now();
    const acquisitionExpiresAt = authorizationAcquisitionDeadline(authorization);
    if (!authorization || !acquisitionExpiresAt || acquisitionExpiresAt <= now) {
      if (authorization && acquisitionExpiresAt !== null && acquisitionExpiresAt <= now) await this.expireAuthorization(client, authorizationId, now);
      return { kind: 'expired' };
    }
    if (authorization.status !== 'in_progress') {
      return { kind: 'unavailable' };
    }

    const active = await client.query(
      "SELECT 1 FROM supplier_activations WHERE authorization_id = $1 AND status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'sms_delivered', 'completion_confirming')",
      [authorizationId],
    );
    if (active.rowCount) return { kind: 'already-active' };

    const candidatesResult = await client.query<{ position: number; country_id: number }>(
      'SELECT position, country_id FROM authorization_candidate_countries WHERE authorization_id = $1 AND used_at IS NULL ORDER BY position',
      [authorizationId],
    );
    if (!candidatesResult.rowCount) return { kind: 'no-candidates' };

    const offerByCountry = new Map(
      offers
        .filter((offer) => offer.serviceCode === this.openAiServiceCode)
        .map((offer) => [offer.countryId, offer]),
    );
    const candidates: PreparedNumberCandidate[] = [];
    for (const candidate of candidatesResult.rows) {
      const offer = offerByCountry.get(candidate.country_id);
      const budgetStock = offer ? budgetStockAtPrice(offer.map, maxPrice) : 0;
      if (budgetStock === 0) continue;
      candidates.push({ position: candidate.position, countryId: candidate.country_id, requestedPrice: maxPrice });
    }
    return { kind: 'ready', candidates };
  }

  private async numberAcquisitionAvailability(
    authorizationId: string,
  ): Promise<'available' | 'expired' | 'unavailable'> {
    const result = await this.database.pool.query<{ status: string; number_acquisition_expires_at: Date | null }>(
      'SELECT status, number_acquisition_expires_at FROM activation_authorizations WHERE id = $1',
      [authorizationId],
    );
    const authorization = result.rows[0];
    const acquisitionExpiresAt = authorizationAcquisitionDeadline(authorization);
    if (!authorization || !acquisitionExpiresAt || acquisitionExpiresAt <= this.now()) return 'expired';
    if (!['in_progress', 'result_available'].includes(authorization.status)) return 'unavailable';
    return 'available';
  }

  private async acquireNumberForAuthorization(
    authorizationId: string,
    options: NumberAcquisitionOptions,
  ): Promise<NumberAcquisitionOutcome> {
    const clearPendingReplacement = async (): Promise<void> => {
      if (options.clearPendingReplacement) await this.clearPendingReplacement(authorizationId);
    };

    const eligibility = await this.database.pool.query<{ status: string; number_acquisition_expires_at: Date | null }>(
      'SELECT status, number_acquisition_expires_at FROM activation_authorizations WHERE id = $1',
      [authorizationId],
    );
    const authorization = eligibility.rows[0];
    const acquisitionExpiresAt = authorizationAcquisitionDeadline(authorization);
    if (!authorization || !acquisitionExpiresAt || acquisitionExpiresAt <= this.now()) {
      await clearPendingReplacement();
      return 'expired';
    }
    if (authorization.status !== 'in_progress') {
      await clearPendingReplacement();
      return 'unavailable';
    }

    try {
      return await this.withAcquisitionLock(async (client) => {
        const unresolved = await client.query<{ authorization_id: string }>(
          "SELECT authorization_id FROM number_acquisition_requests WHERE status IN ('requesting', 'reconciling', 'manual') ORDER BY requested_at LIMIT 1",
        );
        const pending = unresolved.rows[0];
        if (pending) return pending.authorization_id === authorizationId ? 'confirming' : 'paused';

        const currentResult = await client.query<{ status: string; number_acquisition_expires_at: Date | null }>(
          'SELECT status, number_acquisition_expires_at FROM activation_authorizations WHERE id = $1',
          [authorizationId],
        );
        const current = currentResult.rows[0];
        const currentDeadline = authorizationAcquisitionDeadline(current);
        const currentNow = this.now();
        if (!current || !currentDeadline || currentDeadline <= currentNow) {
          if (current && currentDeadline !== null && currentDeadline <= currentNow) await this.expireAuthorization(client, authorizationId, currentNow);
          await clearPendingReplacement();
          return 'expired';
        }
        if (current.status !== 'in_progress') {
          await clearPendingReplacement();
          return 'unavailable';
        }

        let offers: HeroSmsOffer[];
        let maxPrice: number;
        try {
          [offers, maxPrice] = await Promise.all([
            this.heroSms.offers(),
            this.database.maxPricePerNumber(),
          ]);
        } catch {
          await clearPendingReplacement();
          return 'error';
        }

        let prepared: PreparedNumberAcquisition;
        await client.query('BEGIN');
        try {
          prepared = await this.prepareNumberAcquisition(client, authorizationId, offers, maxPrice);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }

        if (prepared.kind !== 'ready') {
          if (prepared.kind === 'configuration-error') {
            await clearPendingReplacement();
            return 'error';
          }
          if (prepared.kind === 'no-candidates') {
            await this.endForExhaustedQuota(client, authorizationId, this.now());
            await clearPendingReplacement();
            return 'no-numbers';
          }
          if (prepared.kind !== 'already-active' || options.clearPendingReplacement) await clearPendingReplacement();
          return prepared.kind;
        }

        if (prepared.candidates.length === 0) {
          await clearPendingReplacement();
          return 'no-numbers';
        }

        for (const candidate of prepared.candidates) {
          const requestedAt = this.now();
          const request = await client.query<{ id: string }>(
            `INSERT INTO number_acquisition_requests
              (authorization_id, candidate_position, country_id, requested_price, status, requested_at, updated_at)
             SELECT auth.id, $2, $3, $4, 'requesting', $5, $5
             FROM activation_authorizations auth
             WHERE auth.id = $1 AND auth.status = 'in_progress'
               AND auth.number_acquisition_expires_at > $5
             RETURNING id`,
            [authorizationId, candidate.position, candidate.countryId, candidate.requestedPrice, requestedAt],
          );
          const requestId = request.rows[0]?.id;
          if (!requestId) {
            const currentResult = await client.query<{ status: string; number_acquisition_expires_at: Date | null }>(
              'SELECT status, number_acquisition_expires_at FROM activation_authorizations WHERE id = $1',
              [authorizationId],
            );
            const current = currentResult.rows[0];
            const currentTime = this.now();
            const currentAcquisitionExpiresAt = authorizationAcquisitionDeadline(current);
            if (!current || !currentAcquisitionExpiresAt || currentAcquisitionExpiresAt <= currentTime) {
              if (current && currentAcquisitionExpiresAt !== null && currentAcquisitionExpiresAt <= currentTime) await this.expireAuthorization(client, authorizationId, currentTime);
              await clearPendingReplacement();
              return 'expired';
            }
            if (current.status !== 'in_progress') {
              await clearPendingReplacement();
              return 'unavailable';
            }
            await clearPendingReplacement();
            return 'error';
          }

          const currentAuthorization = await client.query<{ status: string; number_acquisition_expires_at: Date | null }>(
            'SELECT status, number_acquisition_expires_at FROM activation_authorizations WHERE id = $1',
            [authorizationId],
          );
          const current = currentAuthorization.rows[0];
          const providerCallAt = this.now();
          const currentAcquisitionExpiresAt = authorizationAcquisitionDeadline(current);
          if (!current || !currentAcquisitionExpiresAt || currentAcquisitionExpiresAt <= providerCallAt) {
            await client.query(
              "UPDATE number_acquisition_requests SET status = 'failed', error_kind = 'authorization-expired', updated_at = $2 WHERE id = $1",
              [requestId, providerCallAt],
            );
            if (current && currentAcquisitionExpiresAt !== null && currentAcquisitionExpiresAt <= providerCallAt) await this.expireAuthorization(client, authorizationId, providerCallAt);
            await clearPendingReplacement();
            return 'expired';
          }
          if (current.status !== 'in_progress') {
            await client.query(
              "UPDATE number_acquisition_requests SET status = 'failed', error_kind = 'authorization-unavailable', updated_at = $2 WHERE id = $1",
              [requestId, providerCallAt],
            );
            await clearPendingReplacement();
            return 'unavailable';
          }
          const active = await client.query(
            "SELECT 1 FROM supplier_activations WHERE authorization_id = $1 AND status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'sms_delivered', 'completion_confirming')",
            [authorizationId],
          );
          if (active.rowCount) {
            await client.query(
              "UPDATE number_acquisition_requests SET status = 'failed', error_kind = 'active-activation', updated_at = $2 WHERE id = $1",
              [requestId, providerCallAt],
            );
            await clearPendingReplacement();
            return 'already-active';
          }

          await clearPendingReplacement();

          let number: HeroSmsNumber;
          try {
            number = await this.heroSms.getNumber(this.openAiServiceCode, candidate.countryId, candidate.requestedPrice);
          } catch (error) {
            if (error instanceof HeroSmsResponseError && error.kind === 'uncertain') {
              await client.query(
                "UPDATE number_acquisition_requests SET status = 'reconciling', error_kind = 'uncertain', updated_at = $2 WHERE id = $1",
                [requestId, this.now()],
              );
              const reconciled = await this.reconcileRequestWithoutLock(requestId);
              if (!reconciled) return 'confirming';
              const availability = await this.numberAcquisitionAvailability(authorizationId);
              return availability === 'available' ? 'acquired' : availability;
            }
            await client.query(
              "UPDATE number_acquisition_requests SET status = 'failed', error_kind = $2, updated_at = $3 WHERE id = $1",
              [requestId, error instanceof HeroSmsResponseError ? error.kind : 'provider', this.now()],
            );
            if (error instanceof HeroSmsResponseError && error.kind === 'no-numbers') continue;
            return 'error';
          }

          try {
            const deliverable = await this.persistSuccessfulAcquisition(
              client, requestId, authorizationId, candidate.position, candidate.countryId, candidate.requestedPrice, number,
            );
            return deliverable ? 'acquired' : 'expired';
          } catch {
            try {
              await client.query(
                "UPDATE number_acquisition_requests SET status = 'reconciling', error_kind = 'persistence', updated_at = $2 WHERE id = $1",
                [requestId, this.now()],
              );
              const reconciled = await this.reconcileRequestWithoutLock(requestId);
              if (!reconciled) return 'confirming';
              const availability = await this.numberAcquisitionAvailability(authorizationId);
              return availability === 'available' ? 'acquired' : availability;
            } catch {
              return 'confirming';
            }
          }
        }

        await clearPendingReplacement();
        return 'no-numbers';
      });
    } catch {
      await clearPendingReplacement();
      return 'error';
    }
  }

  private async acquireReplacementNumber(authorizationId: string): Promise<{ state: 'replaced' | 'confirming' | 'no-numbers' | 'error' }> {
    try {
      const outcome = await this.acquireNumberForAuthorization(authorizationId, { clearPendingReplacement: true });
      if (outcome === 'acquired') return { state: 'replaced' };
      if (outcome === 'confirming' || outcome === 'paused' || outcome === 'already-active') return { state: 'confirming' };
      if (outcome === 'no-numbers') return { state: 'no-numbers' };
      return { state: 'error' };
    } catch {
      await this.clearPendingReplacement(authorizationId);
      return { state: 'error' };
    }
  }

  async claimAndGetNumber(token: string): Promise<ClaimResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found' };
    const target = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM activation_authorizations WHERE token_hash = $1', [tokenHash(token)],
    );
    if (!target.rows[0]) return { state: 'not-found' };
    await this.expireResultView(target.rows[0].id);
    await this.reconcileTimedOutActivations(target.rows[0].id);
    const authorizationId = await this.database.transaction(async (client) => {
      const result = await client.query<{
        id: string; status: string; number_acquisition_expires_at: Date | null;
      }>(
        'SELECT id, status, number_acquisition_expires_at FROM activation_authorizations WHERE token_hash = $1 FOR UPDATE',
        [tokenHash(token)],
      );
      const authorization = result.rows[0];
      const now = this.now();
      const acquisitionExpiresAt = authorizationAcquisitionDeadline(authorization);
      if (!authorization || (acquisitionExpiresAt !== null && acquisitionExpiresAt <= now)) {
        if (authorization && acquisitionExpiresAt !== null && acquisitionExpiresAt <= now) {
          await this.expireAuthorization(client, authorization.id, now);
        }
        return undefined;
      }
      if (authorization.status === 'unclaimed') {
        const configuredLocations = await this.database.completeDefaultCandidateLocationsFor(client);
        if (!configuredLocations) return 'claim-failed' as const;
        const numberAcquisitionExpiresAt = new Date(now.getTime() + CLAIM_ACQUISITION_LIFETIME_MS);
        for (const location of configuredLocations) {
          await client.query(
            `INSERT INTO authorization_candidate_countries
              (authorization_id, position, country_id, country_name)
             VALUES ($1, $2, $3, $4)`,
            [authorization.id, location.position, location.countryId, location.countryName],
          );
        }
        await client.query(
          `UPDATE activation_authorizations
           SET status = 'in_progress', claimed_at = $2, number_acquisition_expires_at = $3,
               last_activity_at = $2
           WHERE id = $1 AND status = 'unclaimed'`,
          [authorization.id, now, numberAcquisitionExpiresAt],
        );
        return authorization.id;
      }
      return authorization.status === 'in_progress' ? authorization.id : null;
    });
    if (authorizationId === undefined) return { state: 'not-found' };
    if (authorizationId === 'claim-failed') return { state: 'claim-failed' };
    if (authorizationId === null) return { state: 'unavailable' };

    try {
      const outcome = await this.acquireNumberForAuthorization(authorizationId, {
        clearPendingReplacement: false,
      });
      if (outcome === 'expired') {
        await this.cancelAcquisitionsConfirmedAfterAuthorizationExpiry();
        return { state: 'not-found' };
      }
      if (outcome === 'unavailable') return { state: 'unavailable' };
      if (outcome === 'paused' || outcome === 'error') return { state: 'error' };
      if (outcome === 'already-active' || outcome === 'acquired') return { state: 'claimed' };
      if (outcome === 'confirming') return { state: 'confirming' };
      return { state: 'no-numbers' };
    } catch {
      return { state: 'error' };
    }
  }

  async listAcquisitionReconciliations(): Promise<AcquisitionReconciliation[]> {
    const requests = await this.database.pool.query<{
      id: string; token_suffix: string | null; country_name: string; status: 'requesting' | 'reconciling' | 'manual'; requested_at: Date;
    }>(
      `SELECT request.id, auth.token_suffix, candidate.country_name, request.status, request.requested_at
       FROM number_acquisition_requests request
       JOIN activation_authorizations auth ON auth.id = request.authorization_id
       JOIN authorization_candidate_countries candidate ON candidate.authorization_id = request.authorization_id AND candidate.position = request.candidate_position
       WHERE request.status IN ('requesting', 'reconciling', 'manual') ORDER BY request.requested_at`,
    );
    const result: AcquisitionReconciliation[] = [];
    for (const request of requests.rows) {
      const candidates = await this.database.pool.query<{ provider_activation_id: string; country_id: number | null; activation_time: Date | null }>(
        'SELECT provider_activation_id, country_id, activation_time FROM number_acquisition_candidates WHERE request_id = $1 ORDER BY provider_activation_id',
        [request.id],
      );
      result.push({
        id: request.id,
        ...(request.token_suffix !== null ? { tokenSuffix: request.token_suffix } : {}),
        countryName: request.country_name,
        status: request.status === 'manual' ? '结果待人工对账' : '获取结果确认中',
        requestedAt: request.requested_at,
        candidates: candidates.rows.map((candidate) => ({
          activationId: candidate.provider_activation_id,
          ...(candidate.country_id !== null ? { countryId: candidate.country_id } : {}),
          ...(candidate.activation_time ? { activationTime: candidate.activation_time } : {}),
        })),
      });
    }
    return result;
  }

  async reconcilePendingRequests(): Promise<void> {
    await this.withAcquisitionLock(async () => {
      const result = await this.database.pool.query<{ id: string }>(
        `SELECT request.id FROM number_acquisition_requests request
         JOIN activation_authorizations auth ON auth.id = request.authorization_id
         WHERE request.status IN ('requesting', 'reconciling')
            OR (request.status = 'manual' AND auth.status = 'ended' AND auth.ended_reason = 'admin_revoked')
         ORDER BY request.requested_at`,
      );
      for (const request of result.rows) await this.reconcileRequestWithoutLock(request.id);
    });
  }

  async reconcileAcquisitionRequest(id: string): Promise<boolean> {
    return this.withAcquisitionLock(async () => this.reconcileRequestWithoutLock(id));
  }

  async linkAcquisitionCandidate(id: string, providerActivationId: string): Promise<boolean> {
    return this.withAcquisitionLock(async () => this.resolveCandidate(id, providerActivationId));
  }

  async confirmAcquisitionAbsent(id: string): Promise<boolean> {
    return this.withAcquisitionLock(async (client) => {
      await client.query('BEGIN');
      try {
        const updated = await client.query<{ authorization_id: string }>(
          `UPDATE number_acquisition_requests SET status = 'confirmed_absent', updated_at = $2
           WHERE id = $1 AND status IN ('requesting', 'reconciling', 'manual')
           RETURNING authorization_id`,
          [id, this.now()],
        );
        if (updated.rowCount) {
          await client.query('DELETE FROM number_acquisition_candidates WHERE request_id = $1', [id]);
          // 管理员确认未产生激活是真实业务事实，推动父授权排序。
          await this.touchLastActivity(client, updated.rows[0]!.authorization_id, this.now());
        }
        await client.query('COMMIT');
        return updated.rowCount === 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async withAcquisitionLock<Result>(action: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.database.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [874_321_904]);
      return await action(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [874_321_904]).catch(() => undefined);
      client.release();
    }
  }

  private async reconcileRequestWithoutLock(id: string): Promise<boolean> {
    const requestResult = await this.database.pool.query<{
      authorization_id: string; candidate_position: number; country_id: number; requested_price: string; requested_at: Date; status: string;
    }>(
      "SELECT authorization_id, candidate_position, country_id, requested_price::text, requested_at, status FROM number_acquisition_requests WHERE id = $1 AND status IN ('requesting', 'reconciling', 'manual')",
      [id],
    );
    const request = requestResult.rows[0];
    if (!request) return false;

    const authorizationResult = await this.database.pool.query<{ status: string; ended_reason: string | null }>(
      'SELECT status, ended_reason FROM activation_authorizations WHERE id = $1',
      [request.authorization_id],
    );
    const authorization = authorizationResult.rows[0];
    // 撤销后的请求只保留供应商激活 ID、时间、费用和状态等对账事实，不重新保存完整号码。
    const terminalAccess = Boolean(authorization && authorization.status === 'ended' && authorization.ended_reason === 'admin_revoked');

    const windowStart = new Date(request.requested_at.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(this.now().getTime() + 5 * 60 * 1000);
    const alreadyPersisted = await this.database.pool.query<{ provider_activation_id: string }>(
      `SELECT provider_activation_id FROM supplier_activations
       WHERE authorization_id = $1 AND candidate_position = $2`,
      [request.authorization_id, request.candidate_position],
    );
    if (alreadyPersisted.rowCount === 1) {
      await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE authorization_candidate_countries SET used_at = COALESCE(used_at, $3)
           WHERE authorization_id = $1 AND position = $2`,
          [request.authorization_id, request.candidate_position, this.now()],
        );
        await client.query("UPDATE number_acquisition_requests SET status = 'resolved', updated_at = $2 WHERE id = $1", [id, this.now()]);
        await client.query('DELETE FROM number_acquisition_candidates WHERE request_id = $1', [id]);
        // 对账确认已有供应商激活是真实业务事实，推动父授权排序。
        await this.touchLastActivity(client, request.authorization_id, this.now());
      });
      return true;
    }

    let records: HeroSmsActivationRecord[];
    try {
      const [active, history] = await Promise.all([
        this.heroSms.activeActivations(),
        this.heroSms.activationHistory(windowStart, windowEnd),
      ]);
      const byId = new Map<string, HeroSmsActivationRecord>();
      for (const record of history) byId.set(record.activationId, record);
      for (const record of active) byId.set(record.activationId, record);
      const known = await this.database.pool.query<{ provider_activation_id: string }>('SELECT provider_activation_id FROM supplier_activations');
      const knownIds = new Set(known.rows.map((row) => row.provider_activation_id));
      records = [...byId.values()].filter((record) => {
        if (knownIds.has(record.activationId)) return false;
        if (record.serviceCode && record.serviceCode !== this.openAiServiceCode) return false;
        if (record.countryId !== undefined && record.countryId !== request.country_id) return false;
        if (!record.serviceCode && record.countryId === undefined && !record.activationTime) return false;
        return !record.activationTime
          || (record.activationTime >= windowStart && record.activationTime <= windowEnd);
      });
    } catch {
      await this.database.pool.query(
        "UPDATE number_acquisition_requests SET status = 'reconciling', updated_at = $2 WHERE id = $1 AND status IN ('requesting', 'reconciling', 'manual')",
        [id, this.now()],
      );
      return false;
    }

    await this.database.transaction(async (client) => {
      await client.query('DELETE FROM number_acquisition_candidates WHERE request_id = $1', [id]);
      for (const record of records) {
        await client.query(
          `INSERT INTO number_acquisition_candidates
            (request_id, provider_activation_id, phone_number, activation_cost, currency, service_code, country_id, activation_time, provider_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, record.activationId, terminalAccess ? null : record.phoneNumber, record.activationCost, record.currency,
            record.serviceCode ?? null, record.countryId ?? null, record.activationTime ?? null, record.status],
        );
      }
      await client.query(
        "UPDATE number_acquisition_requests SET status = $2, updated_at = $3 WHERE id = $1 AND status IN ('requesting', 'reconciling', 'manual')",
        [id, records.length === 1 ? 'reconciling' : 'manual', this.now()],
      );
    });
    return records.length === 1 ? this.resolveCandidate(id, records[0]!.activationId) : false;
  }

  private async resolveCandidate(id: string, providerActivationId: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        authorization_id: string; candidate_position: number; request_country_id: number; requested_price: string; phone_number: string | null; activation_cost: string;
        currency: string; activation_time: Date | null; candidate_country_id: number | null;
      }>(
        `SELECT request.authorization_id, request.candidate_position, request.country_id AS request_country_id, request.requested_price::text,
                candidate.phone_number, candidate.activation_cost::text, candidate.currency, candidate.activation_time,
                candidate.country_id AS candidate_country_id
         FROM number_acquisition_requests request
         JOIN number_acquisition_candidates candidate ON candidate.request_id = request.id
         WHERE request.id = $1 AND candidate.provider_activation_id = $2
           AND request.status IN ('requesting', 'reconciling', 'manual') FOR UPDATE OF request`,
        [id, providerActivationId],
      );
      const candidate = result.rows[0];
      if (!candidate) return false;
      const countryId = candidate.candidate_country_id ?? candidate.request_country_id;
      if (countryId !== candidate.request_country_id) return false;
      await this.insertSupplierActivation(client, candidate.authorization_id, candidate.candidate_position, countryId, {
        activationId: providerActivationId,
        ...(candidate.phone_number !== null ? { phoneNumber: candidate.phone_number } : {}),
        activationCost: Number(candidate.activation_cost), currency: candidate.currency,
        ...(candidate.activation_time ? { activationTime: candidate.activation_time } : {}),
      }, Number(candidate.requested_price));
      await client.query(
        `UPDATE authorization_candidate_countries SET used_at = $3
         WHERE authorization_id = $1 AND position = $2 AND used_at IS NULL`,
        [candidate.authorization_id, candidate.candidate_position, this.now()],
      );
      await client.query("UPDATE number_acquisition_requests SET status = 'resolved', updated_at = $2 WHERE id = $1", [id, this.now()]);
      await client.query('DELETE FROM number_acquisition_candidates WHERE request_id = $1', [id]);
      return true;
    });
  }

  private async persistSuccessfulAcquisition(
    client: PoolClient,
    requestId: string,
    authorizationId: string,
    candidatePosition: number,
    countryId: number,
    requestedPrice: number,
    number: HeroSmsNumber,
  ): Promise<boolean> {
    await client.query('BEGIN');
    try {
      const deliverable = await this.insertSupplierActivation(client, authorizationId, candidatePosition, countryId, number, requestedPrice);
      await client.query(
        `UPDATE authorization_candidate_countries SET used_at = $3
         WHERE authorization_id = $1 AND position = $2 AND used_at IS NULL`,
        [authorizationId, candidatePosition, this.now()],
      );
      await client.query("UPDATE number_acquisition_requests SET status = 'resolved', updated_at = $2 WHERE id = $1", [requestId, this.now()]);
      await client.query('COMMIT');
      return deliverable;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  private async insertSupplierActivation(
    client: PoolClient,
    authorizationId: string,
    candidatePosition: number,
    countryId: number,
    number: HeroSmsNumber,
    fallbackPrice: number,
  ): Promise<boolean> {
    const authorization = await client.query<{ number_acquisition_expires_at: Date | null; status: string; ended_reason: string | null }>(
      'SELECT number_acquisition_expires_at, status, ended_reason FROM activation_authorizations WHERE id = $1 FOR UPDATE',
      [authorizationId],
    );
    const acquisitionExpiresAt = authorizationAcquisitionDeadline(authorization.rows[0]);
    const authorizationStatus = authorization.rows[0]?.status;
    const terminalAccess = authorizationStatus === 'ended' && authorization.rows[0]?.ended_reason === 'admin_revoked';
    if (!authorizationStatus || (!acquisitionExpiresAt && !terminalAccess)) throw new Error('激活授权不存在');
    const confirmedAt = this.now();
    const normalizedTimes = normalizeProviderActivationTimes(number, confirmedAt);
    const deliverable = acquisitionExpiresAt !== null && acquisitionExpiresAt > normalizedTimes.acquiredAt
      && normalizedTimes.expiresAt > confirmedAt
      && authorizationStatus === 'in_progress';
    if (!deliverable && !terminalAccess) {
      await this.expireAuthorization(client, authorizationId, confirmedAt);
    }
    await client.query(
      `INSERT INTO supplier_activations
        (authorization_id, candidate_position, country_id, provider_activation_id, status, phone_number, activation_cost, currency, acquired_at, cancel_available_at, expires_at, sms_poll_after, authorization_expiry_cancellation_pending, authorization_revocation_cancellation_pending)
       VALUES ($1, $2, $3, $4, 'waiting_sms', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [authorizationId, candidatePosition, countryId, number.activationId,
        deliverable && number.phoneNumber !== undefined ? number.phoneNumber : null,
        number.activationCost ?? fallbackPrice, number.currency ?? 'UNKNOWN', normalizedTimes.acquiredAt,
        new Date(normalizedTimes.acquiredAt.getTime() + 2 * 60 * 1000), normalizedTimes.expiresAt,
        deliverable ? normalizedTimes.acquiredAt : null, !deliverable && !terminalAccess, terminalAccess],
    );
    // 成功取得供应商激活（含同步获取与异步对账唯一归属）是推动列表排序的真实业务事实。
    await this.touchLastActivity(client, authorizationId, confirmedAt);
    return deliverable;
  }
}
