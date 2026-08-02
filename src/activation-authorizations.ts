import { createHash, randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';

import { AUTHORIZATION_STATUS_LABELS, Database, type AuthorizationStatus } from './database.js';
import { HeroSmsResponseError, type HeroSms, type HeroSmsActivationRecord, type HeroSmsCountry, type HeroSmsNumber, type HeroSmsQuote } from './herosms.js';

const CLAIM_ACQUISITION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const AUTHORIZATION_LIFETIME_MS = CLAIM_ACQUISITION_LIFETIME_MS;

export interface CreatedAuthorization {
  id: string;
  token: string;
  tokenSuffix: string;
  expiresAt?: Date;
}

export interface AuthorizationPreflight {
  recipientIdentifier: string;
  normalizedRecipientIdentifier: string;
  internalNote?: string;
  balance: number;
  candidates: Array<{ countryId: number; countryName: string; price: number; stock: number }>;
}

export interface AuthorizationSummary {
  id: string;
  recipientIdentifier?: string;
  tokenSuffix?: string;
  internalNote?: string;
  status: '待领取' | '进行中' | '结果可查看' | '已结束' | '短信已送达' | '额度已用尽' | '已撤销' | '已到期';
  createdAt: Date;
  expiresAt?: Date;
  lastActivityAt: Date;
  canRevoke: boolean;
  currentActivationStatus?: string;
  hasPendingException: boolean;
}

export interface AuthorizationDetail {
  id: string;
  recipientIdentifier?: string;
  tokenSuffix?: string;
  status: AuthorizationSummary['status'];
  createdAt: Date;
  claimedAt?: Date;
  expiresAt?: Date;
  numberAcquisitionExpiresAt?: Date;
  resultViewUntil?: Date;
  endPromptUntil?: Date;
  endedAt?: Date;
  endedReason?: string;
  lastActivityAt?: Date;
  revokedAt?: Date;
  acquisitionCount: number;
  canRevoke: boolean;
  revocationConsequence?: string;
  acquisition?: {
    countryName: string;
    status: '获取结果确认中' | '结果待人工对账';
  };
  activation?: {
    countryName: string;
    status: 'acquisition_confirming' | 'waiting_sms' | 'cancellation_confirming' | 'cancelled' | 'manual_reconciliation' | 'sms_delivered' | 'completion_confirming' | 'completed' | 'timed_out';
    numberExpiresAt: Date;
    /** 仅非终态（waiting_sms、cancellation_confirming、sms_delivered 等）时为 true，前端据此决定是否显示倒计时。 */
    numberExpiresAtCountdown: boolean;
    phoneNumber?: string;
    verificationCode?: string;
    unrecognizedSmsText?: string;
  };
  candidates: Array<{ countryName: string; quotedPrice?: number; quotedStock?: number; used: boolean }>;
  activations: Array<{
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
  expiresAt?: Date;
  countryName?: string;
  phoneNumber?: string;
  acquiredAt?: Date;
  cancelAvailableAt?: Date;
  numberExpiresAt?: Date;
  remainingNumberCount?: number;
  acquisitionState?: 'confirming' | 'manual';
  replacementAvailable?: boolean;
  replacementInProgress?: boolean;
  activationTimeoutInProgress?: boolean;
  nextNumberAvailable?: boolean;
  smsDelivered?: boolean;
  verificationCode?: string;
}

export type ReplacementResult =
  | { state: 'replaced' | 'confirming' | 'no-numbers' | 'error' }
  | { state: 'too-early' | 'unavailable' | 'not-found' };

type ReplacementTransition =
  | { kind: 'not-found' | 'unavailable' | 'too-early' | 'no-numbers' }
  | { kind: 'cancel'; activationId: string };

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
  sessionToken?: string;
  clearPendingReplacement: boolean;
}

type PreparedNumberCandidate = {
  position: number;
  countryId: number;
  requestedPrice: number;
};

type PreparedNumberAcquisition =
  | { kind: 'expired' | 'unavailable' | 'already-active' | 'no-candidates' }
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
  | { state: 'claimed'; sessionToken: string }
  | { state: 'confirming'; sessionToken: string }
  | { state: 'no-numbers'; sessionToken: string }
  | { state: 'unavailable' }
  | { state: 'not-found' }
  | { state: 'error'; sessionToken: string };

export interface AcquisitionReconciliation {
  id: string;
  tokenSuffix?: string;
  recipientIdentifier?: string;
  countryName: string;
  status: '获取结果确认中' | '结果待人工对账';
  requestedAt: Date;
  candidates: Array<{ activationId: string; countryId?: number; activationTime?: Date }>;
}

export class AuthorizationValidationError extends Error {}
export class DuplicateActiveAuthorizationError extends Error {
  constructor() {
    super('同一接收者标识已有一条未结束激活授权。');
  }
}

function normalizeRecipientIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

function candidateSnapshots(
  configuredCountryIds: number[],
  countries: HeroSmsCountry[],
  quotes: HeroSmsQuote[],
): AuthorizationPreflight['candidates'] {
  const countryById = new Map(countries.map((country) => [country.id, country]));
  const quoteById = new Map(quotes.map((quote) => [quote.countryId, quote]));
  return configuredCountryIds.map((countryId) => {
    const country = countryById.get(countryId);
    const quote = quoteById.get(countryId);
    if (!country || !quote || quote.stock < 1) {
      throw new AuthorizationValidationError('任一候选地区无库存或无法查询，不能创建激活授权。');
    }
    return { countryId, countryName: country.name, price: quote.price, stock: quote.stock };
  });
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isAuthorizationAccessible(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt > now;
}

function optionalDate(value: Date | null): Date | undefined {
  return value ?? undefined;
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

export class ActivationAuthorizations {
  constructor(
    private readonly database: Database,
    private readonly heroSms: HeroSms,
    private readonly openAiServiceCode: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async expireDue(): Promise<void> {
    await this.database.expireDueAuthorizations(this.now());
  }

  async nextRecipientAccessExpiry(): Promise<Date | undefined> {
    const result = await this.database.pool.query<{ expires_at: Date | null }>(
      `SELECT min(expires_at) AS expires_at FROM activation_authorizations
       WHERE token_hash IS NOT NULL OR recipient_session_hash IS NOT NULL`,
    );
    return result.rows[0]?.expires_at ?? undefined;
  }

  async nextPendingRevocationCancellation(): Promise<Date | undefined> {
    const now = this.now();
    const result = await this.database.pool.query<{ cancel_available_at: Date | null }>(
      `SELECT min(GREATEST(cancel_available_at, COALESCE(authorization_revocation_cancellation_retry_after, cancel_available_at))) AS cancel_available_at FROM supplier_activations
       WHERE status = 'waiting_sms' AND authorization_revocation_cancellation_pending AND expires_at > $1`,
      [now],
    );
    return result.rows[0]?.cancel_available_at ?? undefined;
  }

  async preflight(recipientIdentifierValue: string, internalNoteValue?: string): Promise<AuthorizationPreflight> {
    const recipientIdentifier = recipientIdentifierValue.trim();
    const normalizedRecipientIdentifier = normalizeRecipientIdentifier(recipientIdentifierValue);
    const internalNote = internalNoteValue?.trim() || undefined;
    if (!recipientIdentifier || recipientIdentifier.length > 200 || (internalNote?.length ?? 0) > 2000) {
      throw new AuthorizationValidationError('请填写有效的接收者标识，备注最多 2000 个字符。');
    }

    const configuredCountryIds = await this.database.defaultCandidateCountryIds();
    if (configuredCountryIds.length !== 3) {
      throw new AuthorizationValidationError('请先配置三个默认候选地区。');
    }

    const [balance, services, countries, quotes] = await Promise.all([
      this.heroSms.balance(),
      this.heroSms.services(),
      this.heroSms.countries(),
      this.heroSms.quotes(this.openAiServiceCode),
    ]);
    if (!services.some((service) => service.code === this.openAiServiceCode)) {
      throw new AuthorizationValidationError('HeroSMS 无法提供 OpenAI 服务。');
    }
    const candidates = candidateSnapshots(configuredCountryIds, countries, quotes);
    const highestPrice = Math.max(...candidates.map((candidate) => candidate.price));
    if (balance < highestPrice) {
      throw new AuthorizationValidationError('HeroSMS 余额不足以覆盖候选地区的当前最高价格。');
    }
    if (await this.database.hasUnendedAuthorization(normalizedRecipientIdentifier, this.now())) {
      throw new DuplicateActiveAuthorizationError();
    }
    return { recipientIdentifier, normalizedRecipientIdentifier, internalNote, balance, candidates };
  }

  async create(preflight: AuthorizationPreflight): Promise<CreatedAuthorization> {
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + AUTHORIZATION_LIFETIME_MS);
    try {
      const id = await this.database.createActivationAuthorization({
        recipientIdentifier: preflight.recipientIdentifier,
        normalizedRecipientIdentifier: preflight.normalizedRecipientIdentifier,
        internalNote: preflight.internalNote,
        tokenHash: tokenHash(token),
        tokenSuffix: token.slice(-8),
        createdAt,
        expiresAt,
        candidates: preflight.candidates,
      });
      return { id, token, tokenSuffix: token.slice(-8), expiresAt };
    } catch (error) {
      if (error && typeof error === 'object' && 'constraint' in error && error.constraint === 'activation_authorizations_unended_recipient_idx') {
        throw new DuplicateActiveAuthorizationError();
      }
      throw error;
    }
  }

  async list(): Promise<AuthorizationSummary[]> {
    return this.database.listActivationAuthorizations(this.now());
  }

  async revoke(id: string): Promise<boolean> {
    const cancellation = await this.database.transaction(async (client) => {
      const result = await client.query<{ status: AuthorizationStatus; expires_at: Date | null }>('SELECT status, expires_at FROM activation_authorizations WHERE id = $1 FOR UPDATE', [id]);
      const authorization = result.rows[0];
      const now = this.now();
      if (!authorization || !isAuthorizationAccessible(authorization.expires_at, now)
        || !['unclaimed', 'in_progress', 'result_available', 'sms_delivered'].includes(authorization.status)) return undefined;
      await client.query(
        `UPDATE activation_authorizations
         SET status = CASE WHEN expires_at IS NULL THEN 'ended' ELSE 'revoked' END,
             revoked_at = $2, ended_at = $2, ended_reason = 'admin_revoked', last_activity_at = $2,
             token_hash = CASE WHEN expires_at IS NULL THEN NULL ELSE token_hash END,
             recipient_session_hash = NULL
         WHERE id = $1`,
        [id, now],
      );
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
         WHERE authorization_id = $1 AND status IN ('waiting_sms', 'cancellation_confirming')
         ORDER BY acquired_at DESC LIMIT 1 FOR UPDATE`,
        [id],
      );
      const activation = activationResult.rows[0];
      if (!activation || activation.expires_at <= now) return null;
      if (activation.status === 'cancellation_confirming' || activation.cancel_available_at > now) {
        await client.query(
          "UPDATE supplier_activations SET replacement_pending = false, authorization_revocation_cancellation_pending = true WHERE provider_activation_id = $1",
          [activation.provider_activation_id],
        );
        return null;
      }
      await client.query(
        "UPDATE supplier_activations SET status = 'cancellation_confirming', replacement_pending = false, authorization_revocation_cancellation_pending = true WHERE provider_activation_id = $1",
        [activation.provider_activation_id],
      );
      return activation.provider_activation_id;
    });
    if (cancellation === undefined) return false;
    if (cancellation) await this.cancelRevokedActivation(cancellation);
    return true;
  }

  private async cancelRevokedActivation(providerActivationId: string): Promise<void> {
    try {
      const result = await this.heroSms.cancelActivation(providerActivationId);
      if (result === 'cancelled') {
        await this.confirmCancellation(providerActivationId);
      } else if (result === 'too-early') {
        await this.database.pool.query(
          `UPDATE supplier_activations SET status = 'waiting_sms', authorization_revocation_cancellation_pending = true,
             authorization_revocation_cancellation_retry_after = $2
           WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'`,
          [providerActivationId, new Date(this.now().getTime() + 60_000)],
        );
      } else {
        await this.reconcileCancellationConfirmations();
      }
    } catch { /* 保留取消确认状态，由持久任务继续供应商对账。 */ }
  }

  async detail(id: string): Promise<AuthorizationDetail | undefined> {
    const result = await this.database.pool.query<{
      id: string; recipient_identifier: string | null; token_suffix: string | null; authorization_status: AuthorizationStatus;
      created_at: Date; claimed_at: Date | null; authorization_expires_at: Date | null; number_acquisition_expires_at: Date | null;
      result_view_until: Date | null; end_prompt_until: Date | null; ended_at: Date | null; ended_reason: string | null; last_activity_at: Date | null;
      revoked_at: Date | null; country_name: string | null; activation_status: NonNullable<AuthorizationDetail['activation']>['status'] | null; number_expires_at: Date | null;
      sms_code: string | null; sms_text: string | null; phone_number: string | null; used_count: string; acquisition_status: 'requesting' | 'reconciling' | 'manual' | null;
      acquisition_country_name: string | null; cancel_available_at: Date | null;
    }>(
      `SELECT auth.id, auth.recipient_identifier, auth.token_suffix, auth.status AS authorization_status,
              auth.created_at, auth.claimed_at, auth.expires_at AS authorization_expires_at,
              auth.number_acquisition_expires_at, auth.result_view_until, auth.end_prompt_until,
              auth.ended_at, auth.ended_reason, auth.last_activity_at, auth.revoked_at,
              candidate.country_name, activation.status AS activation_status, activation.expires_at AS number_expires_at,
              activation.phone_number, activation.sms_code, activation.sms_text,
              (SELECT count(*) FROM authorization_candidate_countries candidate WHERE candidate.authorization_id = auth.id AND candidate.used_at IS NOT NULL)::text AS used_count,
              acquisition.status AS acquisition_status, acquisition.country_name AS acquisition_country_name,
              activation.cancel_available_at
       FROM activation_authorizations auth
       LEFT JOIN LATERAL (
         SELECT * FROM supplier_activations item WHERE item.authorization_id = auth.id ORDER BY item.acquired_at DESC LIMIT 1
       ) activation ON true
       LEFT JOIN LATERAL (
         SELECT request.status, candidate.country_name
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
      this.database.pool.query<{ country_name: string; quoted_price: string | null; quoted_stock: string | null; used_at: Date | null }>(
        'SELECT country_name, quoted_price::text, quoted_stock::text, used_at FROM authorization_candidate_countries WHERE authorization_id = $1 ORDER BY position', [id],
      ),
      this.database.pool.query<{
        country_name: string; provider_activation_id: string; status: NonNullable<AuthorizationDetail['activation']>['status']; activation_cost: string; currency: string;
        acquired_at: Date; refund_amount: string | null; refund_reconciliation_status: 'pending' | 'resolved';
      }>(
        `SELECT candidate.country_name, activation.provider_activation_id, activation.status, activation.activation_cost::text, activation.currency, activation.acquired_at,
                refund.amount::text AS refund_amount, activation.refund_reconciliation_status
         FROM supplier_activations activation
         JOIN authorization_candidate_countries candidate
           ON candidate.authorization_id = activation.authorization_id AND candidate.position = activation.candidate_position
         LEFT JOIN supplier_activation_refunds refund ON refund.supplier_activation_id = activation.id
         WHERE activation.authorization_id = $1 ORDER BY activation.acquired_at`, [id],
      ),
    ]);
    const activations = activationResult.rows.map((activation) => ({
      countryName: activation.country_name, providerActivationId: activation.provider_activation_id, status: activation.status, activationCost: Number(activation.activation_cost),
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
    const canRevoke = isAuthorizationAccessible(row.authorization_expires_at, this.now())
      && ['unclaimed', 'in_progress', 'result_available', 'sms_delivered'].includes(row.authorization_status);
    const revocationConsequence = !canRevoke ? undefined
      : row.acquisition_status ? '先完成供应商对账，确认号码后取消。'
        : row.activation_status === 'waiting_sms'
          ? (row.cancel_available_at && row.cancel_available_at > this.now() ? '将在可取消时请求取消当前供应商激活。'
            : row.number_expires_at && row.number_expires_at <= this.now() ? '当前激活已结束，仅终止接收者访问。' : '立即请求取消当前供应商激活。')
          : row.authorization_status === 'result_available' || row.authorization_status === 'sms_delivered' ? '只终止接收者访问，不请求供应商取消。'
            : '立即终止接收者访问。';
    const ACTIVE_ACTIVATION_STATUSES = new Set(['acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'sms_delivered', 'completion_confirming']);
    return {
      id: row.id,
      ...(row.recipient_identifier !== null ? { recipientIdentifier: row.recipient_identifier } : {}),
      ...(row.token_suffix !== null ? { tokenSuffix: row.token_suffix } : {}),
      status: AUTHORIZATION_STATUS_LABELS[row.authorization_status],
      createdAt: row.created_at,
      ...(optionalDate(row.claimed_at) ? { claimedAt: row.claimed_at! } : {}),
      ...(optionalDate(row.authorization_expires_at) ? { expiresAt: row.authorization_expires_at! } : {}),
      ...(optionalDate(row.number_acquisition_expires_at) ? { numberAcquisitionExpiresAt: row.number_acquisition_expires_at! } : {}),
      ...(optionalDate(row.result_view_until) ? { resultViewUntil: row.result_view_until! } : {}),
      ...(optionalDate(row.end_prompt_until) ? { endPromptUntil: row.end_prompt_until! } : {}),
      ...(optionalDate(row.ended_at) ? { endedAt: row.ended_at! } : {}),
      ...(row.ended_reason ? { endedReason: row.ended_reason } : {}),
      ...(optionalDate(row.last_activity_at) ? { lastActivityAt: row.last_activity_at! } : {}),
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      acquisitionCount: Number(row.used_count), canRevoke,
      candidates: candidateResult.rows.map((candidate) => ({
        countryName: candidate.country_name,
        ...(candidate.quoted_price !== null ? { quotedPrice: Number(candidate.quoted_price) } : {}),
        ...(candidate.quoted_stock !== null ? { quotedStock: Number(candidate.quoted_stock) } : {}),
        used: candidate.used_at !== null,
      })),
      activations,
      costs,
      ...(revocationConsequence ? { revocationConsequence } : {}),
      ...(row.acquisition_status && row.acquisition_country_name ? { acquisition: {
        countryName: row.acquisition_country_name,
        status: row.acquisition_status === 'manual' ? '结果待人工对账' as const : '获取结果确认中' as const,
      } } : {}),
      ...(row.country_name && row.activation_status && row.number_expires_at ? { activation: {
        countryName: row.country_name, status: row.activation_status, numberExpiresAt: row.number_expires_at,
        numberExpiresAtCountdown: ACTIVE_ACTIVATION_STATUSES.has(row.activation_status),
        ...(row.number_expires_at > this.now() && row.phone_number ? { phoneNumber: row.phone_number } : {}),
        ...(row.number_expires_at > this.now() && row.sms_code ? { verificationCode: row.sms_code } : {}),
        ...(!row.sms_code && row.sms_text && row.number_expires_at > this.now() ? { unrecognizedSmsText: row.sms_text } : {}),
      } } : {}),
    };
  }

  async recipientState(token: string, sessionToken?: string): Promise<RecipientAuthorizationView> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found' };
    const target = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM activation_authorizations WHERE token_hash = $1', [tokenHash(token)],
    );
    if (!target.rows[0]) return { state: 'not-found' };
    // 页面访问也必须让二十分钟边界生效，不能等待下一次分钟扫描继续交付旧号码。
    await this.reconcileTimedOutActivations(target.rows[0].id);
    const result = await this.database.pool.query<{
      id: string; status: AuthorizationStatus;
      expires_at: Date | null; recipient_session_hash: string | null; country_name: string | null; phone_number: string | null;
      acquired_at: Date | null; cancel_available_at: Date | null; number_expires_at: Date | null; used_count: string;
      acquisition_status: 'requesting' | 'reconciling' | 'manual' | null; activation_status: string | null; sms_code: string | null;
      last_activation_status: string | null; last_activation_timed_out_at: Date | null;
    }>(
      `SELECT auth.id, auth.status, auth.expires_at, auth.recipient_session_hash,
              candidate.country_name, activation.phone_number, activation.acquired_at,
              activation.cancel_available_at, activation.expires_at AS number_expires_at,
              activation.status AS activation_status, activation.sms_code,
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
    if (!authorization) return { state: 'not-found' };
    const now = this.now();
    if (authorization.expires_at !== null && authorization.expires_at <= now) {
      await this.database.expireAuthorization(authorization.id, now);
      return { state: 'not-found' };
    }
    const expiresAt = optionalDate(authorization.expires_at);
    if (authorization.status === 'revoked') return { state: 'unavailable', ...(expiresAt ? { expiresAt } : {}) };
    if (authorization.status === 'unclaimed') return { state: 'available', ...(expiresAt ? { expiresAt } : {}) };
    if (!sessionToken || !authorization.recipient_session_hash || tokenHash(sessionToken) !== authorization.recipient_session_hash) {
      return { state: 'unavailable', ...(expiresAt ? { expiresAt } : {}) };
    }
    return {
      state: 'claimed', ...(expiresAt ? { expiresAt } : {}),
      ...(authorization.country_name ? { countryName: authorization.country_name } : {}),
      ...(authorization.phone_number ? { phoneNumber: authorization.phone_number } : {}),
      ...(authorization.acquired_at ? { acquiredAt: authorization.acquired_at } : {}),
      ...(authorization.cancel_available_at ? { cancelAvailableAt: authorization.cancel_available_at } : {}),
      ...(authorization.number_expires_at ? { numberExpiresAt: authorization.number_expires_at } : {}),
      remainingNumberCount: 3 - Number(authorization.used_count),
      ...(authorization.acquisition_status ? { acquisitionState: authorization.acquisition_status === 'manual' ? 'manual' as const : 'confirming' as const } : {}),
      ...(authorization.activation_status === 'waiting_sms' && authorization.cancel_available_at && authorization.cancel_available_at <= now && Number(authorization.used_count) < 3 ? { replacementAvailable: true } : {}),
      ...(authorization.activation_status === 'cancellation_confirming' ? { replacementInProgress: true } : {}),
      ...(authorization.last_activation_status === 'manual_reconciliation' && authorization.last_activation_timed_out_at ? { activationTimeoutInProgress: true } : {}),
      ...(authorization.last_activation_status === 'timed_out' && Number(authorization.used_count) < 3 ? { nextNumberAvailable: true } : {}),
      ...(authorization.status === 'sms_delivered' ? { smsDelivered: true } : {}),
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
      await client.query('SELECT id FROM activation_authorizations WHERE id = $1 FOR UPDATE', [candidate.authorization_id]);
      const activation = await client.query<{ id: string; authorization_id: string; country_id: number; status: string; expires_at: Date }>(
        'SELECT id, authorization_id, country_id, status, expires_at FROM supplier_activations WHERE provider_activation_id = $1 FOR UPDATE',
        [event.activationId],
      );
      const current = activation.rows[0];
      if (!current || current.country_id !== event.countryId || event.serviceCode !== this.openAiServiceCode) return 'ignored';
      const inserted = await client.query(
        `INSERT INTO hero_sms_events (provider_activation_id, received_at, payload_digest, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [event.activationId, event.receivedAt, payloadDigest, this.now()],
      );
      if (!inserted.rowCount || current.expires_at <= this.now()) return 'accepted';
      if (current.status === 'waiting_sms' || current.status === 'cancellation_confirming') {
        await client.query(
          `UPDATE supplier_activations
           SET status = 'completion_confirming', sms_code = $2, sms_text = $3, sms_received_at = $4, sms_poll_after = NULL,
               replacement_pending = false, authorization_expiry_cancellation_pending = false,
               authorization_revocation_cancellation_pending = false,
               authorization_revocation_cancellation_retry_after = NULL
           WHERE id = $1 AND status IN ('waiting_sms', 'cancellation_confirming')`,
          [current.id, event.code ?? null, event.text, event.receivedAt],
        );
        await client.query("UPDATE activation_authorizations SET status = 'sms_delivered' WHERE id = $1 AND status = 'in_progress'", [current.authorization_id]);
      } else if (event.code && ['completion_confirming', 'completed'].includes(current.status)) {
        // 轮询可能先取得正文，后续才取得供应商提供的结构化验证码。
        await client.query(
          `UPDATE supplier_activations SET sms_code = COALESCE(sms_code, $2), sms_text = COALESCE(sms_text, $3), sms_received_at = COALESCE(sms_received_at, $4), sms_poll_after = NULL
           WHERE id = $1 AND status IN ('completion_confirming', 'completed')`,
          [current.id, event.code, event.text, event.receivedAt],
        );
      }
      return 'accepted';
    });
  }

  async finishDeliveredActivations(): Promise<void> {
    for (;;) {
      const claimed = await this.database.pool.query<{ id: string; provider_activation_id: string }>(
        `UPDATE supplier_activations SET completion_claimed_at = $1
         WHERE id = (
           SELECT id FROM supplier_activations
           WHERE status = 'completion_confirming'
             AND (completion_claimed_at IS NULL OR completion_claimed_at <= $2)
           ORDER BY sms_received_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING id, provider_activation_id`,
        [this.now(), new Date(this.now().getTime() - 5 * 60 * 1000)],
      );
      const activation = claimed.rows[0];
      if (!activation) return;
      try {
        await this.heroSms.finishActivation(activation.provider_activation_id);
        await this.database.pool.query(
          "UPDATE supplier_activations SET status = 'completed', completed_at = $2, completion_claimed_at = NULL WHERE id = $1 AND status = 'completion_confirming'",
          [activation.id, this.now()],
        );
      } catch (error) {
        if (error instanceof HeroSmsResponseError && error.kind === 'uncertain') {
          // 完成请求结果不明确时读取供应商状态；已结束则确认完成，仍可查询短信则保留任务重试。
          const reconciled = await this.heroSms.activationStatus(activation.provider_activation_id).catch(() => undefined);
          if (reconciled?.providerStatus === 'cancelled') {
            await this.database.pool.query(
              "UPDATE supplier_activations SET status = 'manual_reconciliation', completion_claimed_at = NULL WHERE id = $1 AND status = 'completion_confirming'",
              [activation.id],
            );
            continue;
          }
        }
        await this.database.pool.query(
          "UPDATE supplier_activations SET completion_claimed_at = NULL WHERE id = $1 AND status = 'completion_confirming'",
          [activation.id],
        );
        return;
      }
    }
  }

  async pollWaitingActivations(): Promise<void> {
    const now = this.now();
    const polled = await this.database.pool.query<{ provider_activation_id: string; country_id: number }>(
      `UPDATE supplier_activations SET sms_poll_after = $2
       WHERE id IN (
         SELECT id FROM supplier_activations
         WHERE status IN ('waiting_sms', 'completion_confirming', 'completed')
           AND expires_at > $1 AND (sms_code IS NULL OR status = 'waiting_sms')
           AND (sms_poll_after IS NULL OR sms_poll_after <= $1)
         ORDER BY acquired_at FOR UPDATE SKIP LOCKED
       )
       RETURNING provider_activation_id, country_id`,
      [now, new Date(now.getTime() + 60_000)],
    );
    for (const activation of polled.rows) {
      try {
        const status = await this.heroSms.activationStatus(activation.provider_activation_id);
        if (status.delivered && status.text) {
          await this.receiveHeroSmsWebhook({
            activationId: activation.provider_activation_id, serviceCode: this.openAiServiceCode, countryId: activation.country_id,
            receivedAt: status.receivedAt ?? this.now(), text: status.text, ...(status.code ? { code: status.code } : {}),
          });
        }
      } catch { /* 轮询是 Webhook 的恢复机制，失败留待下次任务。 */ }
    }
  }

  async deleteExpiredSensitiveDeliveryData(): Promise<void> {
    await this.database.pool.query(
      `UPDATE supplier_activations SET phone_number = NULL, sms_code = NULL, sms_text = NULL
       WHERE expires_at <= $1 AND (phone_number IS NOT NULL OR sms_code IS NOT NULL OR sms_text IS NOT NULL)`,
      [this.now()],
    );
  }

  async reconcileTimedOutActivations(authorizationId?: string): Promise<void> {
    const now = this.now();
    // 号码有效窗口到期后先进入供应商对账；只有确认窗口内未送达，才进入“已超时”明确终态。
    await this.database.pool.query(
      `UPDATE supplier_activations
       SET status = 'manual_reconciliation', timed_out_at = COALESCE(timed_out_at, $1),
           refund_reconciliation_status = 'pending', timeout_reconciliation_claimed_at = NULL,
           timeout_reconciliation_claim_token = NULL, replacement_pending = false,
           authorization_expiry_cancellation_pending = false,
           authorization_revocation_cancellation_pending = false,
           authorization_revocation_cancellation_retry_after = NULL,
           phone_number = NULL, sms_code = NULL, sms_text = NULL, sms_poll_after = NULL
       WHERE id IN (
         SELECT id FROM supplier_activations
         WHERE status IN ('waiting_sms', 'cancellation_confirming') AND expires_at <= $1
           AND ($2::uuid IS NULL OR authorization_id = $2)
         ORDER BY expires_at FOR UPDATE SKIP LOCKED
       )`,
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
      } catch {
        await this.releaseTimeoutReconciliation(activation.id, reconciliationClaimToken);
        continue;
      }

      if (finalStatus.delivered) {
        if (!finalStatus.receivedAt) {
          // 无法证明短信在号码有效窗口内送达时，保持供应商对账，不能凭猜测改变后继资格。
          await this.releaseTimeoutReconciliation(activation.id, reconciliationClaimToken);
        } else if (finalStatus.receivedAt < activation.expires_at) {
          // 窗口内已送达的短信必须胜过超时，禁止再开放后继号码；窗口已结束，敏感数据仍立即删除。
          await this.recordTimedOutDelivery(activation.id, reconciliationClaimToken);
        } else {
          // 临界点及窗口后的迟到短信不改变已经发生的激活超时，也不能恢复敏感交付数据。
          await this.confirmTimedOutFinalStatus(activation.id, reconciliationClaimToken);
          await this.resolveTimeoutRefund(activation.id, reconciliationClaimToken, false);
        }
        continue;
      }
      if (finalStatus.providerStatus !== 'cancelled') {
        // STATUS_WAIT_CODE 不是最终状态，必须继续供应商对账，不能抢先开放后继号码。
        await this.releaseTimeoutReconciliation(activation.id, reconciliationClaimToken);
        continue;
      }
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
      const confirmed = await client.query<{ authorization_id: string }>(
        `UPDATE supplier_activations
         SET status = 'timed_out', timeout_final_status_confirmed_at = COALESCE(timeout_final_status_confirmed_at, $3)
         WHERE id = $1 AND status = 'manual_reconciliation' AND timed_out_at IS NOT NULL
           AND timeout_reconciliation_claim_token = $2
         RETURNING authorization_id`,
        [activationId, claimToken, this.now()],
      );
      const authorizationId = confirmed.rows[0]?.authorization_id;
      if (!authorizationId) return;
      await client.query(
        `UPDATE activation_authorizations auth
         SET status = 'quota_exhausted'
         WHERE auth.id = $1 AND auth.status = 'in_progress'
           AND NOT EXISTS (
             SELECT 1 FROM authorization_candidate_countries candidate
             WHERE candidate.authorization_id = auth.id AND candidate.used_at IS NULL
           )`,
        [authorizationId],
      );
    });
  }

  private async recordTimedOutDelivery(activationId: string, claimToken: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query<{ authorization_id: string }>(
        `UPDATE supplier_activations
         SET status = 'completion_confirming', refund_reconciliation_status = 'resolved',
             timeout_reconciliation_claimed_at = NULL, timeout_reconciliation_claim_token = NULL
         WHERE id = $1 AND status = 'manual_reconciliation' AND timed_out_at IS NOT NULL
           AND timeout_reconciliation_claim_token = $2
         RETURNING authorization_id`,
        [activationId, claimToken],
      );
      const authorizationId = result.rows[0]?.authorization_id;
      if (authorizationId) {
        await client.query(
          "UPDATE activation_authorizations SET status = 'sms_delivered' WHERE id = $1 AND status = 'in_progress'",
          [authorizationId],
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
      const result = await client.query<{ activation_cost: string; currency: string }>(
        `SELECT activation_cost::text, currency FROM supplier_activations
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

  private async expireAuthorization(client: PoolClient, authorizationId: string, now: Date): Promise<void> {
    await client.query(
      "UPDATE activation_authorizations SET status = 'expired', token_hash = NULL, recipient_session_hash = NULL WHERE id = $1 AND expires_at <= $2",
      [authorizationId, now],
    );
  }

  async requestNumberReplacement(token: string, sessionToken?: string): Promise<ReplacementResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found' };
    const target = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM activation_authorizations WHERE token_hash = $1', [tokenHash(token)],
    );
    if (!target.rows[0]) return { state: 'not-found' };
    await this.reconcileTimedOutActivations(target.rows[0].id);
    const transition = await this.database.transaction(async (client): Promise<ReplacementTransition> => {
      const authorizationResult = await client.query<{ id: string; status: string; expires_at: Date; recipient_session_hash: string | null }>(
        'SELECT id, status, expires_at, recipient_session_hash FROM activation_authorizations WHERE token_hash = $1 FOR UPDATE',
        [tokenHash(token)],
      );
      const authorization = authorizationResult.rows[0];
      const now = this.now();
      if (!authorization || authorization.expires_at <= now) {
        if (authorization) await this.expireAuthorization(client, authorization.id, now);
        return { kind: 'not-found' };
      }
      if (authorization.status !== 'in_progress' || !sessionToken || authorization.recipient_session_hash !== tokenHash(sessionToken)) return { kind: 'unavailable' };
      const used = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM authorization_candidate_countries WHERE authorization_id = $1 AND used_at IS NOT NULL',
        [authorization.id],
      );
      if (Number(used.rows[0]?.count) >= 3) return { kind: 'no-numbers' };
      const currentResult = await client.query<{ provider_activation_id: string; cancel_available_at: Date }>(
        `SELECT provider_activation_id, cancel_available_at FROM supplier_activations
         WHERE authorization_id = $1 AND status = 'waiting_sms' FOR UPDATE`,
        [authorization.id],
      );
      const current = currentResult.rows[0];
      if (!current || current.cancel_available_at > now) return { kind: 'too-early' };
      const updated = await client.query(
        "UPDATE supplier_activations SET status = 'cancellation_confirming', replacement_pending = true WHERE authorization_id = $1 AND status = 'waiting_sms'",
        [authorization.id],
      );
      return updated.rowCount === 1 ? { kind: 'cancel', activationId: current.provider_activation_id } : { kind: 'unavailable' };
    });
    if (transition.kind !== 'cancel') return { state: transition.kind };

    try {
      const cancellation = await this.heroSms.cancelActivation(transition.activationId);
      if (cancellation === 'too-early') {
        await this.database.pool.query(
          "UPDATE supplier_activations SET status = 'waiting_sms', replacement_pending = false WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'",
          [transition.activationId],
        );
        return { state: 'too-early' };
      }
      if (cancellation === 'sms-delivered') {
        await this.reconcileCancellationConfirmations();
        return { state: 'confirming' };
      }
      const confirmed = await this.confirmCancellation(transition.activationId);
      return confirmed?.replacementAllowed ? this.acquireReplacementNumber(confirmed.authorizationId) : { state: 'confirming' };
    } catch {
      // 请求结果不明确时必须保留取消确认状态，等待供应商状态对账。
      return { state: 'confirming' };
    }
  }

  async reconcileCancellationConfirmations(): Promise<void> {
    const pending = await this.database.pool.query<{ provider_activation_id: string; country_id: number }>(
      "SELECT provider_activation_id, country_id FROM supplier_activations WHERE status = 'cancellation_confirming' ORDER BY acquired_at",
    );
    for (const activation of pending.rows) {
      try {
        const status = await this.heroSms.activationStatus(activation.provider_activation_id);
        if (status.providerStatus === 'cancelled') {
          const confirmed = await this.confirmCancellation(activation.provider_activation_id);
          if (confirmed?.replacementAllowed) await this.acquireReplacementNumber(confirmed.authorizationId);
        } else if (status.delivered && status.text) {
          await this.receiveHeroSmsWebhook({
            activationId: activation.provider_activation_id,
            serviceCode: this.openAiServiceCode,
            countryId: activation.country_id,
            receivedAt: status.receivedAt ?? this.now(),
            text: status.text,
            ...(status.code ? { code: status.code } : {}),
          });
        }
      } catch { /* 保持取消确认状态，下一次持久任务继续对账。 */ }
    }
  }

  async cancelRevokedActivations(): Promise<void> {
    for (;;) {
      const claimed = await this.database.pool.query<{ provider_activation_id: string }>(
        `UPDATE supplier_activations SET status = 'cancellation_confirming', replacement_pending = false
         WHERE id = (
           SELECT id FROM supplier_activations
           WHERE status = 'waiting_sms' AND authorization_revocation_cancellation_pending AND cancel_available_at <= $1
             AND (authorization_revocation_cancellation_retry_after IS NULL OR authorization_revocation_cancellation_retry_after <= $1)
             AND expires_at > $1
           ORDER BY cancel_available_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING provider_activation_id`,
        [this.now()],
      );
      const activation = claimed.rows[0];
      if (!activation) return;
      await this.cancelRevokedActivation(activation.provider_activation_id);
    }
  }

  async cancelAcquisitionsConfirmedAfterAuthorizationExpiry(): Promise<void> {
    for (;;) {
      const claimed = await this.database.pool.query<{ provider_activation_id: string }>(
        `UPDATE supplier_activations SET status = 'cancellation_confirming', authorization_expiry_cancellation_pending = false
         WHERE id = (
           SELECT id FROM supplier_activations
           WHERE status = 'waiting_sms' AND authorization_expiry_cancellation_pending AND cancel_available_at <= $1
           ORDER BY cancel_available_at LIMIT 1 FOR UPDATE SKIP LOCKED
         ) RETURNING provider_activation_id`,
        [this.now()],
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
          await this.database.pool.query(
            `UPDATE supplier_activations
             SET status = 'waiting_sms', authorization_expiry_cancellation_pending = true
             WHERE provider_activation_id = $1 AND status = 'cancellation_confirming'`,
            [activation.provider_activation_id],
          );
        }
        // 短信冲突和不明确结果均保留取消确认状态，交由供应商状态对账。
      } catch { /* 持久状态已记录，后续任务继续供应商对账。 */ }
    }
  }

  async runPendingReplacementAcquisitions(): Promise<void> {
    const now = this.now();
    await this.database.pool.query(
      `UPDATE supplier_activations activation SET replacement_pending = false
       FROM activation_authorizations auth
       WHERE activation.authorization_id = auth.id AND activation.status = 'cancelled' AND activation.replacement_pending
         AND (auth.status <> 'in_progress' OR auth.expires_at <= $1)`,
      [now],
    );
    const pending = await this.database.pool.query<{ authorization_id: string }>(
      `SELECT activation.authorization_id FROM supplier_activations activation
       JOIN activation_authorizations auth ON auth.id = activation.authorization_id
       WHERE activation.status = 'cancelled' AND activation.replacement_pending
         AND auth.status = 'in_progress' AND auth.expires_at > $1
       ORDER BY activation.acquired_at`,
      [now],
    );
    for (const replacement of pending.rows) await this.acquireReplacementNumber(replacement.authorization_id);
  }

  private async confirmCancellation(providerActivationId: string): Promise<{ authorizationId: string; replacementAllowed: boolean } | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        id: string; authorization_id: string; replacement_pending: boolean; authorization_status: string; authorization_expires_at: Date;
        activation_cost: string; currency: string;
      }>(
        `SELECT activation.id, activation.authorization_id, activation.replacement_pending,
                auth.status AS authorization_status, auth.expires_at AS authorization_expires_at,
                activation.activation_cost::text, activation.currency
         FROM supplier_activations activation
         JOIN activation_authorizations auth ON auth.id = activation.authorization_id
         WHERE activation.provider_activation_id = $1 AND activation.status = 'cancellation_confirming'
           AND activation.expires_at > $2
         FOR UPDATE OF activation, auth`,
        [providerActivationId, this.now()],
      );
      const activation = result.rows[0];
      if (!activation) return undefined;
      const replacementAllowed = activation.replacement_pending
        && activation.authorization_status === 'in_progress'
        && activation.authorization_expires_at > this.now();
      await client.query(
        `UPDATE supplier_activations
         SET status = 'cancelled', supplier_cancelled_at = COALESCE(supplier_cancelled_at, $2),
             phone_number = NULL, sms_code = NULL, sms_text = NULL, sms_poll_after = NULL,
             replacement_pending = $3, authorization_expiry_cancellation_pending = false,
             authorization_revocation_cancellation_pending = false,
             authorization_revocation_cancellation_retry_after = NULL
         WHERE id = $1`,
        [activation.id, this.now(), replacementAllowed],
      );
      await client.query(
        `INSERT INTO supplier_activation_refunds (supplier_activation_id, amount, currency, confirmed_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (supplier_activation_id) DO NOTHING`,
        [activation.id, activation.activation_cost, activation.currency, this.now()],
      );
      return { authorizationId: activation.authorization_id, replacementAllowed };
    });
  }

  private async clearPendingReplacement(authorizationId: string): Promise<void> {
    await this.database.pool.query(
      "UPDATE supplier_activations SET replacement_pending = false WHERE authorization_id = $1 AND status = 'cancelled' AND replacement_pending",
      [authorizationId],
    );
  }

  private async prepareNumberAcquisition(
    client: PoolClient,
    authorizationId: string,
    sessionHash: string | undefined,
    quotes: HeroSmsQuote[],
  ): Promise<PreparedNumberAcquisition> {
    const authorizationResult = await client.query<{ status: string; expires_at: Date | null; recipient_session_hash: string | null }>(
      'SELECT status, expires_at, recipient_session_hash FROM activation_authorizations WHERE id = $1 FOR UPDATE',
      [authorizationId],
    );
    const authorization = authorizationResult.rows[0];
    const now = this.now();
    if (!authorization || !authorization.expires_at || authorization.expires_at <= now) {
      if (authorization) await this.expireAuthorization(client, authorizationId, now);
      return { kind: 'expired' };
    }
    if (authorization.status !== 'in_progress'
      || (sessionHash !== undefined && authorization.recipient_session_hash !== sessionHash)) {
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

    const quoteByCountry = new Map(quotes.map((quote) => [quote.countryId, quote]));
    const candidates = candidatesResult.rows
      .map((candidate) => ({
        position: candidate.position,
        countryId: candidate.country_id,
        quote: quoteByCountry.get(candidate.country_id),
      }))
      .filter((candidate): candidate is { position: number; countryId: number; quote: HeroSmsQuote } => Boolean(candidate.quote && candidate.quote.stock > 0))
      .sort((left, right) => left.quote.price - right.quote.price || left.countryId - right.countryId || left.position - right.position)
      .map((candidate) => ({ position: candidate.position, countryId: candidate.countryId, requestedPrice: candidate.quote.price }));
    return { kind: 'ready', candidates };
  }

  private async numberAcquisitionAvailability(
    authorizationId: string,
    sessionHash: string | undefined,
  ): Promise<'available' | 'expired' | 'unavailable'> {
    const result = await this.database.pool.query<{ status: string; expires_at: Date | null; recipient_session_hash: string | null }>(
      'SELECT status, expires_at, recipient_session_hash FROM activation_authorizations WHERE id = $1',
      [authorizationId],
    );
    const authorization = result.rows[0];
    if (!authorization || !authorization.expires_at || authorization.expires_at <= this.now()) return 'expired';
    if (!['in_progress', 'sms_delivered', 'result_available'].includes(authorization.status)
      || (sessionHash !== undefined && authorization.recipient_session_hash !== sessionHash)) return 'unavailable';
    return 'available';
  }

  private async acquireNumberForAuthorization(
    authorizationId: string,
    options: NumberAcquisitionOptions,
  ): Promise<NumberAcquisitionOutcome> {
    const sessionHash = options.sessionToken ? tokenHash(options.sessionToken) : undefined;
    const clearPendingReplacement = async (): Promise<void> => {
      if (options.clearPendingReplacement) await this.clearPendingReplacement(authorizationId);
    };

    const eligibility = await this.database.pool.query<{ status: string; expires_at: Date | null }>(
      'SELECT status, expires_at FROM activation_authorizations WHERE id = $1',
      [authorizationId],
    );
    const authorization = eligibility.rows[0];
    if (!authorization || !authorization.expires_at || authorization.expires_at <= this.now()) {
      await clearPendingReplacement();
      return 'expired';
    }
    if (authorization.status !== 'in_progress') {
      await clearPendingReplacement();
      return 'unavailable';
    }

    let quotes: HeroSmsQuote[];
    try {
      quotes = await this.heroSms.quotes(this.openAiServiceCode);
    } catch {
      await clearPendingReplacement();
      return 'error';
    }

    try {
      return await this.withAcquisitionLock(async (client) => {
        const unresolved = await client.query<{ authorization_id: string }>(
          "SELECT authorization_id FROM number_acquisition_requests WHERE status IN ('requesting', 'reconciling', 'manual') ORDER BY requested_at LIMIT 1",
        );
        const pending = unresolved.rows[0];
        if (pending) return pending.authorization_id === authorizationId ? 'confirming' : 'paused';

        let prepared: PreparedNumberAcquisition;
        await client.query('BEGIN');
        try {
          prepared = await this.prepareNumberAcquisition(client, authorizationId, sessionHash, quotes);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }

        if (prepared.kind !== 'ready') {
          if (prepared.kind === 'no-candidates') {
            await client.query("UPDATE activation_authorizations SET status = 'quota_exhausted' WHERE id = $1 AND status = 'in_progress'", [authorizationId]);
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
             WHERE auth.id = $1 AND auth.status = 'in_progress' AND auth.expires_at > $5
               AND ($6::text IS NULL OR auth.recipient_session_hash = $6)
             RETURNING id`,
            [authorizationId, candidate.position, candidate.countryId, candidate.requestedPrice, requestedAt, sessionHash ?? null],
          );
          const requestId = request.rows[0]?.id;
          if (!requestId) {
            const currentResult = await client.query<{ status: string; expires_at: Date | null; recipient_session_hash: string | null }>(
              'SELECT status, expires_at, recipient_session_hash FROM activation_authorizations WHERE id = $1',
              [authorizationId],
            );
            const current = currentResult.rows[0];
            const currentTime = this.now();
            if (!current || !current.expires_at || current.expires_at <= currentTime) {
              if (current?.status === 'in_progress') await this.expireAuthorization(client, authorizationId, currentTime);
              await clearPendingReplacement();
              return 'expired';
            }
            if (current.status !== 'in_progress' || (sessionHash !== undefined && current.recipient_session_hash !== sessionHash)) {
              await clearPendingReplacement();
              return 'unavailable';
            }
            await clearPendingReplacement();
            return 'error';
          }

          const currentAuthorization = await client.query<{ status: string; expires_at: Date | null; recipient_session_hash: string | null }>(
            'SELECT status, expires_at, recipient_session_hash FROM activation_authorizations WHERE id = $1',
            [authorizationId],
          );
          const current = currentAuthorization.rows[0];
          const providerCallAt = this.now();
          if (!current || !current.expires_at || current.expires_at <= providerCallAt) {
            await client.query(
              "UPDATE number_acquisition_requests SET status = 'failed', error_kind = 'authorization-expired', updated_at = $2 WHERE id = $1",
              [requestId, providerCallAt],
            );
            if (current?.status === 'in_progress') await this.expireAuthorization(client, authorizationId, providerCallAt);
            await clearPendingReplacement();
            return 'expired';
          }
          if (current.status !== 'in_progress' || (sessionHash !== undefined && current.recipient_session_hash !== sessionHash)) {
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
            number = await this.heroSms.getNumber(this.openAiServiceCode, candidate.countryId);
          } catch (error) {
            if (error instanceof HeroSmsResponseError && error.kind === 'uncertain') {
              await client.query(
                "UPDATE number_acquisition_requests SET status = 'reconciling', error_kind = 'uncertain', updated_at = $2 WHERE id = $1",
                [requestId, this.now()],
              );
              const reconciled = await this.reconcileRequestWithoutLock(requestId);
              if (!reconciled) return 'confirming';
              const availability = await this.numberAcquisitionAvailability(authorizationId, sessionHash);
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
              const availability = await this.numberAcquisitionAvailability(authorizationId, sessionHash);
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

  private async acquireReplacementNumber(authorizationId: string): Promise<Extract<ReplacementResult, { state: 'replaced' | 'confirming' | 'no-numbers' | 'error' }>> {
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

  async claimAndGetNumber(token: string, existingSessionToken?: string): Promise<ClaimResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found' };
    const target = await this.database.pool.query<{ id: string }>(
      'SELECT id FROM activation_authorizations WHERE token_hash = $1', [tokenHash(token)],
    );
    if (!target.rows[0]) return { state: 'not-found' };
    await this.reconcileTimedOutActivations(target.rows[0].id);
    const sessionToken = existingSessionToken ?? randomBytes(32).toString('base64url');
    const authorizationId = await this.database.transaction(async (client) => {
      const result = await client.query<{ id: string; status: string; expires_at: Date; recipient_session_hash: string | null }>(
        'SELECT id, status, expires_at, recipient_session_hash FROM activation_authorizations WHERE token_hash = $1 FOR UPDATE',
        [tokenHash(token)],
      );
      const authorization = result.rows[0];
      const now = this.now();
      if (!authorization || authorization.expires_at <= now) {
        if (authorization) await this.expireAuthorization(client, authorization.id, now);
        return undefined;
      }
      if (authorization.status === 'unclaimed') {
        await client.query(
          "UPDATE activation_authorizations SET status = 'in_progress', recipient_session_hash = $2 WHERE id = $1 AND status = 'unclaimed'",
          [authorization.id, tokenHash(sessionToken)],
        );
        return authorization.id;
      }
      return authorization.status === 'in_progress' && authorization.recipient_session_hash === tokenHash(sessionToken)
        ? authorization.id
        : null;
    });
    if (authorizationId === undefined) return { state: 'not-found' };
    if (authorizationId === null) return { state: 'unavailable' };

    try {
      const outcome = await this.acquireNumberForAuthorization(authorizationId, {
        sessionToken,
        clearPendingReplacement: false,
      });
      if (outcome === 'expired') {
        await this.cancelAcquisitionsConfirmedAfterAuthorizationExpiry();
        return { state: 'not-found' };
      }
      if (outcome === 'unavailable') return { state: 'unavailable' };
      if (outcome === 'paused' || outcome === 'error') return { state: 'error', sessionToken };
      if (outcome === 'already-active' || outcome === 'acquired') return { state: 'claimed', sessionToken };
      if (outcome === 'confirming') return { state: 'confirming', sessionToken };
      return { state: 'no-numbers', sessionToken };
    } catch {
      return { state: 'error', sessionToken };
    }
  }

  async listAcquisitionReconciliations(): Promise<AcquisitionReconciliation[]> {
    const requests = await this.database.pool.query<{
      id: string; recipient_identifier: string | null; token_suffix: string | null; country_name: string; status: 'requesting' | 'reconciling' | 'manual'; requested_at: Date;
    }>(
      `SELECT request.id, auth.recipient_identifier, auth.token_suffix, candidate.country_name, request.status, request.requested_at
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
        ...(request.recipient_identifier !== null ? { recipientIdentifier: request.recipient_identifier } : {}),
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
            OR (request.status = 'manual' AND auth.status = 'revoked')
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
        const updated = await client.query(
          `UPDATE number_acquisition_requests SET status = 'confirmed_absent', updated_at = $2
           WHERE id = $1 AND status IN ('requesting', 'reconciling', 'manual')`,
          [id, this.now()],
        );
        if (updated.rowCount) await client.query('DELETE FROM number_acquisition_candidates WHERE request_id = $1', [id]);
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
          [id, record.activationId, record.phoneNumber, record.activationCost, record.currency,
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
        authorization_id: string; candidate_position: number; request_country_id: number; requested_price: string; phone_number: string; activation_cost: string;
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
        activationId: providerActivationId, phoneNumber: candidate.phone_number,
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
    const authorization = await client.query<{ expires_at: Date; status: string }>(
      'SELECT expires_at, status FROM activation_authorizations WHERE id = $1 FOR UPDATE',
      [authorizationId],
    );
    const expiresAt = authorization.rows[0]?.expires_at;
    const authorizationStatus = authorization.rows[0]?.status;
    if (!expiresAt || !authorizationStatus) throw new Error('激活授权不存在');
    const confirmedAt = this.now();
    const deliverable = expiresAt > confirmedAt && authorizationStatus !== 'revoked';
    if (authorizationStatus !== 'revoked' && !deliverable) {
      await this.expireAuthorization(client, authorizationId, confirmedAt);
    }
    const normalizedTimes = normalizeProviderActivationTimes(number, confirmedAt);
    await client.query(
      `INSERT INTO supplier_activations
        (authorization_id, candidate_position, country_id, provider_activation_id, status, phone_number, activation_cost, currency, acquired_at, cancel_available_at, expires_at, sms_poll_after, authorization_expiry_cancellation_pending, authorization_revocation_cancellation_pending)
       VALUES ($1, $2, $3, $4, 'waiting_sms', $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [authorizationId, candidatePosition, countryId, number.activationId, deliverable ? number.phoneNumber : null,
        number.activationCost ?? fallbackPrice, number.currency ?? 'UNKNOWN', normalizedTimes.acquiredAt,
        new Date(normalizedTimes.acquiredAt.getTime() + 2 * 60 * 1000), normalizedTimes.expiresAt,
        deliverable ? normalizedTimes.acquiredAt : null, !deliverable && authorizationStatus !== 'revoked', authorizationStatus === 'revoked'],
    );
    return deliverable;
  }
}
