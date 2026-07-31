import { createHash, randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';

import { Database } from './database.js';
import { HeroSmsResponseError, type HeroSms, type HeroSmsActivationRecord, type HeroSmsCountry, type HeroSmsNumber, type HeroSmsQuote } from './herosms.js';

const AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface AuthorizationPreflight {
  recipientIdentifier: string;
  normalizedRecipientIdentifier: string;
  internalNote?: string;
  balance: number;
  candidates: Array<{ countryId: number; countryName: string; price: number; stock: number }>;
}

export interface CreatedAuthorization {
  id: string;
  token: string;
  expiresAt: Date;
}

export interface AuthorizationSummary {
  id: string;
  recipientIdentifier: string;
  internalNote?: string;
  status: '待领取' | '进行中' | '短信已送达' | '额度已用尽' | '已撤销' | '已到期';
  createdAt: Date;
  expiresAt: Date;
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
  smsDelivered?: boolean;
  verificationCode?: string;
}

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
  recipientIdentifier: string;
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

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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

export class ActivationAuthorizations {
  constructor(
    private readonly database: Database,
    private readonly heroSms: HeroSms,
    private readonly openAiServiceCode: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
        createdAt,
        expiresAt,
        candidates: preflight.candidates,
      });
      return { id, token, expiresAt };
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
    return this.database.revokeUnclaimedAuthorization(id, this.now());
  }

  async recipientState(token: string, sessionToken?: string): Promise<RecipientAuthorizationView> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found' };
    const result = await this.database.pool.query<{
      id: string; status: 'unclaimed' | 'in_progress' | 'sms_delivered' | 'quota_exhausted' | 'revoked' | 'expired';
      expires_at: Date; recipient_session_hash: string | null; country_name: string | null; phone_number: string | null;
      acquired_at: Date | null; cancel_available_at: Date | null; number_expires_at: Date | null; used_count: string;
      acquisition_status: 'requesting' | 'reconciling' | 'manual' | null; activation_status: string | null; sms_code: string | null;
    }>(
      `SELECT auth.id, auth.status, auth.expires_at, auth.recipient_session_hash,
              candidate.country_name, activation.phone_number, activation.acquired_at,
              activation.cancel_available_at, activation.expires_at AS number_expires_at,
              activation.status AS activation_status, activation.sms_code,
              (SELECT count(*) FROM authorization_candidate_countries used WHERE used.authorization_id = auth.id AND used.used_at IS NOT NULL)::text AS used_count,
              acquisition.status AS acquisition_status
       FROM activation_authorizations auth
       LEFT JOIN supplier_activations activation ON activation.authorization_id = auth.id AND activation.status IN ('waiting_sms', 'sms_delivered', 'completion_confirming', 'completed')
       LEFT JOIN authorization_candidate_countries candidate ON candidate.authorization_id = auth.id AND candidate.country_id = activation.country_id
       LEFT JOIN LATERAL (
         SELECT status FROM number_acquisition_requests request
         WHERE request.authorization_id = auth.id AND request.status IN ('requesting', 'reconciling', 'manual')
         ORDER BY request.requested_at DESC LIMIT 1
       ) acquisition ON true
       WHERE auth.token_hash = $1`,
      [tokenHash(token)],
    );
    const authorization = result.rows[0];
    if (!authorization) return { state: 'not-found' };
    const now = this.now();
    if (authorization.expires_at <= now) {
      await this.database.expireAuthorization(authorization.id, now);
      return { state: 'not-found' };
    }
    if (authorization.status === 'unclaimed') return { state: 'available', expiresAt: authorization.expires_at };
    if (!sessionToken || !authorization.recipient_session_hash || tokenHash(sessionToken) !== authorization.recipient_session_hash) {
      return { state: 'unavailable', expiresAt: authorization.expires_at };
    }
    return {
      state: 'claimed', expiresAt: authorization.expires_at,
      ...(authorization.country_name ? { countryName: authorization.country_name } : {}),
      ...(authorization.phone_number ? { phoneNumber: authorization.phone_number } : {}),
      ...(authorization.acquired_at ? { acquiredAt: authorization.acquired_at } : {}),
      ...(authorization.cancel_available_at ? { cancelAvailableAt: authorization.cancel_available_at } : {}),
      ...(authorization.number_expires_at ? { numberExpiresAt: authorization.number_expires_at } : {}),
      remainingNumberCount: 3 - Number(authorization.used_count),
      ...(authorization.acquisition_status ? { acquisitionState: authorization.acquisition_status === 'manual' ? 'manual' as const : 'confirming' as const } : {}),
      ...(authorization.activation_status && authorization.activation_status !== 'waiting_sms' ? { smsDelivered: true } : {}),
      ...(authorization.sms_code ? { verificationCode: authorization.sms_code } : {}),
    };
  }

  async receiveHeroSmsWebhook(event: HeroSmsWebhookEvent): Promise<'accepted' | 'ignored'> {
    const payloadDigest = createHash('sha256').update(JSON.stringify({
      activationId: event.activationId, serviceCode: event.serviceCode, countryId: event.countryId,
      receivedAt: event.receivedAt.toISOString(), text: event.text, code: event.code ?? null,
    })).digest('hex');
    return this.database.transaction(async (client) => {
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
      if (current.status === 'waiting_sms') {
        await client.query(
          `UPDATE supplier_activations SET status = 'completion_confirming', sms_code = $2, sms_text = $3, sms_received_at = $4
           WHERE id = $1 AND status = 'waiting_sms'`,
          [current.id, event.code ?? null, event.text, event.receivedAt],
        );
        await client.query("UPDATE activation_authorizations SET status = 'sms_delivered' WHERE id = $1 AND status = 'in_progress'", [current.authorization_id]);
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
      } catch {
        await this.database.pool.query(
          "UPDATE supplier_activations SET completion_claimed_at = NULL WHERE id = $1 AND status = 'completion_confirming'",
          [activation.id],
        );
        return;
      }
    }
  }

  async pollWaitingActivations(): Promise<void> {
    const waiting = await this.database.pool.query<{ provider_activation_id: string; country_id: number }>(
      "SELECT provider_activation_id, country_id FROM supplier_activations WHERE status = 'waiting_sms' ORDER BY acquired_at",
    );
    for (const activation of waiting.rows) {
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

  async claimAndGetNumber(token: string, existingSessionToken?: string): Promise<ClaimResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'not-found' };
    const sessionToken = existingSessionToken ?? randomBytes(32).toString('base64url');
    const authorizationId = await this.database.transaction(async (client) => {
      const result = await client.query<{ id: string; status: string; expires_at: Date; recipient_session_hash: string | null }>(
        'SELECT id, status, expires_at, recipient_session_hash FROM activation_authorizations WHERE token_hash = $1 FOR UPDATE',
        [tokenHash(token)],
      );
      const authorization = result.rows[0];
      const now = this.now();
      if (!authorization || authorization.expires_at <= now) {
        if (authorization) await client.query("UPDATE activation_authorizations SET status = 'expired', token_hash = NULL WHERE id = $1", [authorization.id]);
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

    let quotes: HeroSmsQuote[];
    try {
      quotes = await this.heroSms.quotes(this.openAiServiceCode);
    } catch {
      return { state: 'error', sessionToken };
    }

    try {
      const outcome = await this.withAcquisitionLock(async (client) => {
        const unresolved = await client.query<{ authorization_id: string; status: string }>(
          "SELECT authorization_id, status FROM number_acquisition_requests WHERE status IN ('requesting', 'reconciling', 'manual') ORDER BY requested_at LIMIT 1",
        );
        const pending = unresolved.rows[0];
        if (pending) return pending.authorization_id === authorizationId ? 'confirming' as const : 'paused' as const;

        await client.query('BEGIN');
        try {
          const authorizationResult = await client.query<{ status: string; expires_at: Date; recipient_session_hash: string | null }>(
            'SELECT status, expires_at, recipient_session_hash FROM activation_authorizations WHERE id = $1 FOR UPDATE',
            [authorizationId],
          );
          const authorization = authorizationResult.rows[0];
          const now = this.now();
          if (!authorization || authorization.expires_at <= now) {
            if (authorization) await client.query("UPDATE activation_authorizations SET status = 'expired', token_hash = NULL WHERE id = $1", [authorizationId]);
            await client.query('COMMIT');
            return 'not-found' as const;
          }
          if (authorization.status !== 'in_progress' || authorization.recipient_session_hash !== tokenHash(sessionToken)) {
            await client.query('COMMIT');
            return 'unavailable' as const;
          }
          const current = await client.query("SELECT 1 FROM supplier_activations WHERE authorization_id = $1 AND status = 'waiting_sms'", [authorizationId]);
          if (current.rowCount) {
            await client.query('COMMIT');
            return 'claimed' as const;
          }
          const candidatesResult = await client.query<{ country_id: number; country_name: string }>(
            'SELECT country_id, country_name FROM authorization_candidate_countries WHERE authorization_id = $1 AND used_at IS NULL',
            [authorizationId],
          );
          await client.query('COMMIT');

          const quoteByCountry = new Map(quotes.map((quote) => [quote.countryId, quote]));
          const candidates = candidatesResult.rows
            .map((candidate) => ({ ...candidate, quote: quoteByCountry.get(candidate.country_id) }))
            .filter((candidate): candidate is typeof candidate & { quote: HeroSmsQuote } => Boolean(candidate.quote && candidate.quote.stock > 0))
            .sort((left, right) => left.quote.price - right.quote.price || left.country_id - right.country_id);

          for (const candidate of candidates) {
            const beforeCall = await client.query<{ status: string; expires_at: Date; recipient_session_hash: string | null }>(
              'SELECT status, expires_at, recipient_session_hash FROM activation_authorizations WHERE id = $1',
              [authorizationId],
            );
            const currentAuthorization = beforeCall.rows[0];
            const requestedAt = this.now();
            if (!currentAuthorization || currentAuthorization.expires_at <= requestedAt) {
              if (currentAuthorization) {
                await client.query("UPDATE activation_authorizations SET status = 'expired', token_hash = NULL WHERE id = $1", [authorizationId]);
              }
              return 'not-found' as const;
            }
            if (currentAuthorization.status !== 'in_progress' || currentAuthorization.recipient_session_hash !== tokenHash(sessionToken)) {
              return 'unavailable' as const;
            }

            const request = await client.query<{ id: string }>(
              `INSERT INTO number_acquisition_requests
                (authorization_id, country_id, requested_price, status, requested_at, updated_at)
               VALUES ($1, $2, $3, 'requesting', $4, $4) RETURNING id`,
              [authorizationId, candidate.country_id, candidate.quote.price, requestedAt],
            );
            const requestId = request.rows[0]?.id;
            if (!requestId) throw new Error('无法持久化号码获取请求');

            let number: HeroSmsNumber;
            try {
              number = await this.heroSms.getNumber(this.openAiServiceCode, candidate.country_id);
            } catch (error) {
              if (error instanceof HeroSmsResponseError && error.kind === 'uncertain') {
                await client.query(
                  "UPDATE number_acquisition_requests SET status = 'reconciling', error_kind = $2, updated_at = $3 WHERE id = $1",
                  [requestId, error.kind, this.now()],
                );
                const reconciled = await this.reconcileRequestWithoutLock(requestId);
                return reconciled ? 'claimed' as const : 'confirming' as const;
              }
              await client.query(
                "UPDATE number_acquisition_requests SET status = 'failed', error_kind = $2, updated_at = $3 WHERE id = $1",
                [requestId, error instanceof HeroSmsResponseError ? error.kind : 'provider', this.now()],
              );
              if (error instanceof HeroSmsResponseError && error.kind === 'no-numbers') continue;
              return 'error' as const;
            }

            try {
              await this.persistSuccessfulAcquisition(client, requestId, authorizationId, candidate.country_id, candidate.quote.price, number);
              return 'claimed' as const;
            } catch {
              try {
                await client.query(
                  "UPDATE number_acquisition_requests SET status = 'reconciling', error_kind = 'persistence', updated_at = $2 WHERE id = $1",
                  [requestId, this.now()],
                );
                const reconciled = await this.reconcileRequestWithoutLock(requestId);
                return reconciled ? 'claimed' as const : 'confirming' as const;
              } catch {
                return 'confirming' as const;
              }
            }
          }
          return 'no-numbers' as const;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
      if (outcome === 'not-found' || outcome === 'unavailable') return { state: outcome };
      if (outcome === 'paused' || outcome === 'error') return { state: 'error', sessionToken };
      return { state: outcome, sessionToken };
    } catch {
      return { state: 'error', sessionToken };
    }
  }

  async listAcquisitionReconciliations(): Promise<AcquisitionReconciliation[]> {
    const requests = await this.database.pool.query<{
      id: string; recipient_identifier: string; country_name: string; status: 'requesting' | 'reconciling' | 'manual'; requested_at: Date;
    }>(
      `SELECT request.id, auth.recipient_identifier, candidate.country_name, request.status, request.requested_at
       FROM number_acquisition_requests request
       JOIN activation_authorizations auth ON auth.id = request.authorization_id
       JOIN authorization_candidate_countries candidate ON candidate.authorization_id = request.authorization_id AND candidate.country_id = request.country_id
       WHERE request.status IN ('requesting', 'reconciling', 'manual') ORDER BY request.requested_at`,
    );
    const result: AcquisitionReconciliation[] = [];
    for (const request of requests.rows) {
      const candidates = await this.database.pool.query<{ provider_activation_id: string; country_id: number | null; activation_time: Date | null }>(
        'SELECT provider_activation_id, country_id, activation_time FROM number_acquisition_candidates WHERE request_id = $1 ORDER BY provider_activation_id',
        [request.id],
      );
      result.push({
        id: request.id, recipientIdentifier: request.recipient_identifier, countryName: request.country_name,
        status: request.status === 'manual' ? '结果待人工对账' : '获取结果确认中', requestedAt: request.requested_at,
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
        "SELECT id FROM number_acquisition_requests WHERE status IN ('requesting', 'reconciling') ORDER BY requested_at",
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
      authorization_id: string; country_id: number; requested_price: string; requested_at: Date; status: string;
    }>(
      "SELECT authorization_id, country_id, requested_price::text, requested_at, status FROM number_acquisition_requests WHERE id = $1 AND status IN ('requesting', 'reconciling', 'manual')",
      [id],
    );
    const request = requestResult.rows[0];
    if (!request) return false;

    const windowStart = new Date(request.requested_at.getTime() - 5 * 60 * 1000);
    const windowEnd = new Date(this.now().getTime() + 5 * 60 * 1000);
    const alreadyPersisted = await this.database.pool.query<{ provider_activation_id: string }>(
      `SELECT provider_activation_id FROM supplier_activations
       WHERE authorization_id = $1 AND country_id = $2 AND acquired_at BETWEEN $3 AND $4`,
      [request.authorization_id, request.country_id, windowStart, windowEnd],
    );
    if (alreadyPersisted.rowCount === 1) {
      await this.database.transaction(async (client) => {
        await client.query(
          'UPDATE authorization_candidate_countries SET used_at = COALESCE(used_at, $3) WHERE authorization_id = $1 AND country_id = $2',
          [request.authorization_id, request.country_id, this.now()],
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
        authorization_id: string; request_country_id: number; requested_price: string; phone_number: string; activation_cost: string;
        currency: string; activation_time: Date | null; candidate_country_id: number | null;
      }>(
        `SELECT request.authorization_id, request.country_id AS request_country_id, request.requested_price::text,
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
      const acquiredAt = candidate.activation_time ?? this.now();
      await this.insertSupplierActivation(client, candidate.authorization_id, countryId, {
        activationId: providerActivationId, phoneNumber: candidate.phone_number,
        activationCost: Number(candidate.activation_cost), currency: candidate.currency, activationTime: acquiredAt,
      }, Number(candidate.requested_price));
      await client.query(
        'UPDATE authorization_candidate_countries SET used_at = $3 WHERE authorization_id = $1 AND country_id = $2 AND used_at IS NULL',
        [candidate.authorization_id, countryId, this.now()],
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
    countryId: number,
    requestedPrice: number,
    number: HeroSmsNumber,
  ): Promise<void> {
    await client.query('BEGIN');
    try {
      await this.insertSupplierActivation(client, authorizationId, countryId, number, requestedPrice);
      await client.query(
        'UPDATE authorization_candidate_countries SET used_at = $3 WHERE authorization_id = $1 AND country_id = $2 AND used_at IS NULL',
        [authorizationId, countryId, this.now()],
      );
      await client.query("UPDATE number_acquisition_requests SET status = 'resolved', updated_at = $2 WHERE id = $1", [requestId, this.now()]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  private async insertSupplierActivation(
    client: PoolClient,
    authorizationId: string,
    countryId: number,
    number: HeroSmsNumber,
    fallbackPrice: number,
  ): Promise<void> {
    const acquiredAt = number.activationTime ?? this.now();
    const expiresAt = number.activationEndTime ?? new Date(acquiredAt.getTime() + 20 * 60 * 1000);
    await client.query(
      `INSERT INTO supplier_activations
        (authorization_id, country_id, provider_activation_id, status, phone_number, activation_cost, currency, acquired_at, cancel_available_at, expires_at)
       VALUES ($1, $2, $3, 'waiting_sms', $4, $5, $6, $7, $8, $9)`,
      [authorizationId, countryId, number.activationId, number.phoneNumber,
        number.activationCost ?? fallbackPrice, number.currency ?? 'UNKNOWN', acquiredAt,
        new Date(acquiredAt.getTime() + 2 * 60 * 1000), expiresAt],
    );
  }
}
