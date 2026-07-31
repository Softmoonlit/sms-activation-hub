import { createHash, randomBytes } from 'node:crypto';

import { Database } from './database.js';
import { HeroSmsResponseError, type HeroSms, type HeroSmsCountry, type HeroSmsQuote } from './herosms.js';

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
}

export type ClaimResult =
  | { state: 'claimed'; sessionToken: string }
  | { state: 'no-numbers'; sessionToken: string }
  | { state: 'unavailable' }
  | { state: 'not-found' }
  | { state: 'error'; sessionToken: string };

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
    }>(
      `SELECT auth.id, auth.status, auth.expires_at, auth.recipient_session_hash,
              candidate.country_name, activation.phone_number, activation.acquired_at,
              activation.cancel_available_at, activation.expires_at AS number_expires_at,
              (SELECT count(*) FROM authorization_candidate_countries used WHERE used.authorization_id = auth.id AND used.used_at IS NOT NULL)::text AS used_count
       FROM activation_authorizations auth
       LEFT JOIN supplier_activations activation ON activation.authorization_id = auth.id AND activation.status = 'waiting_sms'
       LEFT JOIN authorization_candidate_countries candidate ON candidate.authorization_id = auth.id AND candidate.country_id = activation.country_id
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
    };
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
      const outcome = await this.database.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [874_321_904]);
        const authorizationResult = await client.query<{ status: string; expires_at: Date; recipient_session_hash: string | null }>(
          'SELECT status, expires_at, recipient_session_hash FROM activation_authorizations WHERE id = $1 FOR UPDATE',
          [authorizationId],
        );
        const authorization = authorizationResult.rows[0];
        const now = this.now();
        if (!authorization || authorization.expires_at <= now) {
          if (authorization) await client.query("UPDATE activation_authorizations SET status = 'expired', token_hash = NULL WHERE id = $1", [authorizationId]);
          return 'not-found' as const;
        }
        if (authorization.status !== 'in_progress' || authorization.recipient_session_hash !== tokenHash(sessionToken)) return 'unavailable' as const;
        const current = await client.query('SELECT 1 FROM supplier_activations WHERE authorization_id = $1 AND status = \'waiting_sms\'', [authorizationId]);
        if (current.rowCount) return 'claimed' as const;
        const candidatesResult = await client.query<{ country_id: number; country_name: string }>(
          'SELECT country_id, country_name FROM authorization_candidate_countries WHERE authorization_id = $1 AND used_at IS NULL',
          [authorizationId],
        );
        const quoteByCountry = new Map(quotes.map((quote) => [quote.countryId, quote]));
        const candidates = candidatesResult.rows
          .map((candidate) => ({ ...candidate, quote: quoteByCountry.get(candidate.country_id) }))
          .filter((candidate): candidate is typeof candidate & { quote: HeroSmsQuote } => Boolean(candidate.quote && candidate.quote.stock > 0))
          .sort((left, right) => left.quote.price - right.quote.price || left.country_id - right.country_id);
        for (const candidate of candidates) {
          try {
            const number = await this.heroSms.getNumber(this.openAiServiceCode, candidate.country_id);
            const acquiredAt = number.activationTime ?? now;
            const expiresAt = number.activationEndTime ?? new Date(acquiredAt.getTime() + 20 * 60 * 1000);
            await client.query(
              `INSERT INTO supplier_activations
                (authorization_id, country_id, provider_activation_id, status, phone_number, activation_cost, currency, acquired_at, cancel_available_at, expires_at)
               VALUES ($1, $2, $3, 'waiting_sms', $4, $5, $6, $7, $8, $9)`,
              [authorizationId, candidate.country_id, number.activationId, number.phoneNumber,
                number.activationCost ?? candidate.quote.price, number.currency ?? 'UNKNOWN', acquiredAt,
                new Date(acquiredAt.getTime() + 2 * 60 * 1000), expiresAt],
            );
            await client.query(
              'UPDATE authorization_candidate_countries SET used_at = $3 WHERE authorization_id = $1 AND country_id = $2 AND used_at IS NULL',
              [authorizationId, candidate.country_id, now],
            );
            return 'claimed' as const;
          } catch (error) {
            if (error instanceof HeroSmsResponseError && error.kind === 'no-numbers') continue;
            throw error;
          }
        }
        return 'no-numbers' as const;
      });
      if (outcome === 'not-found' || outcome === 'unavailable') return { state: outcome };
      return { state: outcome, sessionToken };
    } catch {
      return { state: 'error', sessionToken };
    }
  }
}
