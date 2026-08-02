import { Pool, type PoolClient } from 'pg';

export type CanonicalAuthorizationStatus = 'unclaimed' | 'in_progress' | 'result_available' | 'ended';

export type AuthorizationStatus =
  | CanonicalAuthorizationStatus
  | 'sms_delivered'
  | 'quota_exhausted'
  | 'revoked'
  | 'expired';

export interface AuthorizationListOptions {
  page: number;
  status?: CanonicalAuthorizationStatus;
  tokenSuffix?: string;
  order?: 'activity' | 'created';
}

export type AuthorizationListDisplayStatus = '待领取' | '进行中' | '结果可查看' | '已结束' | '短信已送达' | '额度已用尽' | '已撤销' | '已到期';

export interface AuthorizationListItem {
  id: string;
  recipientIdentifier?: string;
  tokenSuffix?: string;
  internalNote?: string;
  status: AuthorizationListDisplayStatus;
  createdAt: Date;
  expiresAt?: Date;
  lastActivityAt: Date;
  canRevoke: boolean;
  currentActivationStatus?: string;
  hasPendingException: boolean;
}

export interface AuthorizationListPageResult {
  items: AuthorizationListItem[];
  total: number;
  page: number;
  pageCount: number;
}

export const AUTHORIZATION_STATUS_LABELS: Record<AuthorizationStatus, AuthorizationListDisplayStatus> = {
  unclaimed: '待领取', in_progress: '进行中', result_available: '结果可查看', ended: '已结束',
  sms_delivered: '短信已送达', quota_exhausted: '额度已用尽', revoked: '已撤销', expired: '已到期',
};

export class Database {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        password_fingerprint TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        invalidated_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS admin_sessions_active_idx
        ON admin_sessions (expires_at)
        WHERE invalidated_at IS NULL;

      CREATE TABLE IF NOT EXISTS admin_login_attempts (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS admin_login_attempts_source_idx
        ON admin_login_attempts (source_fingerprint, attempted_at DESC);

      CREATE TABLE IF NOT EXISTS default_candidate_countries (
        position SMALLINT PRIMARY KEY CHECK (position BETWEEN 1 AND 3),
        country_id INTEGER NOT NULL CHECK (country_id >= 0),
        country_name TEXT
      );

      ALTER TABLE default_candidate_countries
        ADD COLUMN IF NOT EXISTS country_name TEXT;

      ALTER TABLE default_candidate_countries
        DROP CONSTRAINT IF EXISTS default_candidate_countries_country_id_key;

      CREATE TABLE IF NOT EXISTS activation_authorizations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_identifier TEXT,
        normalized_recipient_identifier TEXT,
        internal_note TEXT,
        token_hash TEXT,
        token_suffix TEXT,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        number_acquisition_expires_at TIMESTAMPTZ,
        result_view_until TIMESTAMPTZ,
        end_prompt_until TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        ended_reason TEXT,
        last_activity_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );

      ALTER TABLE activation_authorizations
        ALTER COLUMN recipient_identifier DROP NOT NULL;
      ALTER TABLE activation_authorizations
        ALTER COLUMN normalized_recipient_identifier DROP NOT NULL;
      ALTER TABLE activation_authorizations
        ALTER COLUMN expires_at DROP NOT NULL;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS token_suffix TEXT;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS number_acquisition_expires_at TIMESTAMPTZ;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS result_view_until TIMESTAMPTZ;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS end_prompt_until TIMESTAMPTZ;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS ended_reason TEXT;
      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS recipient_session_hash TEXT;

      ALTER TABLE activation_authorizations DROP CONSTRAINT IF EXISTS activation_authorizations_status_check;
      UPDATE activation_authorizations
        SET recipient_session_hash = NULL
        WHERE status IN ('revoked', 'expired')
           OR (status = 'ended' AND ended_reason = 'admin_revoked');
      ALTER TABLE activation_authorizations ADD CONSTRAINT activation_authorizations_status_check
        CHECK (status IN ('unclaimed', 'in_progress', 'result_available', 'ended', 'sms_delivered', 'quota_exhausted', 'revoked', 'expired'));

      ALTER TABLE activation_authorizations DROP CONSTRAINT IF EXISTS activation_authorizations_expires_at_check;
      ALTER TABLE activation_authorizations DROP CONSTRAINT IF EXISTS activation_authorizations_check;
      ALTER TABLE activation_authorizations DROP CONSTRAINT IF EXISTS activation_authorizations_token_suffix_check;
      ALTER TABLE activation_authorizations ADD CONSTRAINT activation_authorizations_token_suffix_check
        CHECK (token_suffix IS NULL OR length(token_suffix) = 8);

      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_token_hash_idx
        ON activation_authorizations (token_hash)
        WHERE token_hash IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_token_suffix_idx
        ON activation_authorizations (token_suffix)
        WHERE token_suffix IS NOT NULL;

      DROP INDEX IF EXISTS activation_authorizations_unclaimed_recipient_idx;
      DROP INDEX IF EXISTS activation_authorizations_unended_recipient_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_unended_recipient_idx
        ON activation_authorizations (normalized_recipient_identifier)
        WHERE normalized_recipient_identifier IS NOT NULL AND status IN ('unclaimed', 'in_progress');

      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_recipient_session_idx
        ON activation_authorizations (recipient_session_hash)
        WHERE recipient_session_hash IS NOT NULL;

      UPDATE activation_authorizations
        SET last_activity_at = COALESCE(last_activity_at, created_at)
        WHERE last_activity_at IS NULL;

      CREATE TABLE IF NOT EXISTS authorization_candidate_countries (
        authorization_id UUID NOT NULL REFERENCES activation_authorizations(id) ON DELETE RESTRICT,
        position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 3),
        country_id INTEGER NOT NULL CHECK (country_id >= 0),
        country_name TEXT NOT NULL,
        quoted_price NUMERIC CHECK (quoted_price >= 0),
        quoted_stock INTEGER CHECK (quoted_stock > 0),
        used_at TIMESTAMPTZ,
        PRIMARY KEY (authorization_id, position)
      );

      ALTER TABLE authorization_candidate_countries
        ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
      ALTER TABLE authorization_candidate_countries
        ALTER COLUMN quoted_price DROP NOT NULL;
      ALTER TABLE authorization_candidate_countries
        ALTER COLUMN quoted_stock DROP NOT NULL;
      ALTER TABLE authorization_candidate_countries
        DROP CONSTRAINT IF EXISTS authorization_candidate_countri_authorization_id_country_id_key;

      CREATE UNIQUE INDEX IF NOT EXISTS authorization_candidate_countries_position_country_idx
        ON authorization_candidate_countries (authorization_id, position, country_id);

      CREATE TABLE IF NOT EXISTS supplier_activations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        authorization_id UUID NOT NULL REFERENCES activation_authorizations(id) ON DELETE RESTRICT,
        candidate_position SMALLINT NOT NULL CHECK (candidate_position BETWEEN 1 AND 3),
        country_id INTEGER NOT NULL,
        provider_activation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'cancelled', 'manual_reconciliation', 'sms_delivered', 'completion_confirming', 'completed', 'timed_out')),
        phone_number TEXT,
        activation_cost NUMERIC NOT NULL CHECK (activation_cost >= 0),
        currency TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL,
        cancel_available_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        CHECK (expires_at > acquired_at),
        CHECK (cancel_available_at >= acquired_at),
        CONSTRAINT supplier_activations_candidate_position_fkey
          FOREIGN KEY (authorization_id, candidate_position, country_id)
          REFERENCES authorization_candidate_countries (authorization_id, position, country_id) ON DELETE RESTRICT
      );

      ALTER TABLE supplier_activations
        ADD COLUMN IF NOT EXISTS candidate_position SMALLINT;
      UPDATE supplier_activations activation
        SET candidate_position = candidate.position
        FROM authorization_candidate_countries candidate
        WHERE activation.candidate_position IS NULL
          AND candidate.authorization_id = activation.authorization_id
          AND candidate.country_id = activation.country_id;
      ALTER TABLE supplier_activations ALTER COLUMN candidate_position SET NOT NULL;
      ALTER TABLE supplier_activations DROP CONSTRAINT IF EXISTS supplier_activations_candidate_position_check;
      ALTER TABLE supplier_activations ADD CONSTRAINT supplier_activations_candidate_position_check
        CHECK (candidate_position BETWEEN 1 AND 3);
      ALTER TABLE supplier_activations DROP CONSTRAINT IF EXISTS supplier_activations_candidate_position_fkey;
      ALTER TABLE supplier_activations ADD CONSTRAINT supplier_activations_candidate_position_fkey
        FOREIGN KEY (authorization_id, candidate_position, country_id)
        REFERENCES authorization_candidate_countries (authorization_id, position, country_id) ON DELETE RESTRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS supplier_activations_candidate_position_idx
        ON supplier_activations (authorization_id, candidate_position);

      ALTER TABLE supplier_activations DROP CONSTRAINT IF EXISTS supplier_activations_status_check;
      ALTER TABLE supplier_activations ADD CONSTRAINT supplier_activations_status_check
        CHECK (status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'cancelled', 'manual_reconciliation', 'sms_delivered', 'completion_confirming', 'completed', 'timed_out'));
      ALTER TABLE supplier_activations ALTER COLUMN phone_number DROP NOT NULL;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS sms_code TEXT;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS sms_text TEXT;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS sms_received_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS completion_claimed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS sms_poll_after TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS replacement_pending BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS supplier_cancelled_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timed_out_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS refund_reconciliation_status TEXT NOT NULL DEFAULT 'resolved';
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timeout_final_status_confirmed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timeout_reconciliation_claimed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timeout_reconciliation_claim_token TEXT;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS authorization_expiry_cancellation_pending BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS authorization_revocation_cancellation_pending BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS authorization_revocation_cancellation_retry_after TIMESTAMPTZ;
      ALTER TABLE supplier_activations DROP CONSTRAINT IF EXISTS supplier_activations_refund_reconciliation_status_check;
      ALTER TABLE supplier_activations ADD CONSTRAINT supplier_activations_refund_reconciliation_status_check
        CHECK (refund_reconciliation_status IN ('pending', 'resolved'));

      UPDATE supplier_activations
        SET status = 'manual_reconciliation'
        WHERE status = 'timed_out' AND timeout_final_status_confirmed_at IS NULL;

      UPDATE activation_authorizations auth
        SET status = 'quota_exhausted'
        WHERE auth.status = 'in_progress'
          AND NOT EXISTS (
            SELECT 1 FROM authorization_candidate_countries candidate
            WHERE candidate.authorization_id = auth.id AND candidate.used_at IS NULL
          )
          AND (
            SELECT activation.status FROM supplier_activations activation
            WHERE activation.authorization_id = auth.id
            ORDER BY activation.acquired_at DESC LIMIT 1
          ) = 'timed_out';

      DROP INDEX IF EXISTS supplier_activations_current_idx;
      CREATE UNIQUE INDEX supplier_activations_current_idx
        ON supplier_activations (authorization_id)
        WHERE status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'sms_delivered', 'completion_confirming');

      CREATE INDEX IF NOT EXISTS supplier_activations_replacement_pending_idx
        ON supplier_activations (acquired_at)
        WHERE status = 'cancelled' AND replacement_pending;

      DROP INDEX IF EXISTS supplier_activations_timeout_reconciliation_idx;
      CREATE INDEX supplier_activations_timeout_reconciliation_idx
        ON supplier_activations (expires_at)
        WHERE status IN ('manual_reconciliation', 'timed_out') AND timed_out_at IS NOT NULL
          AND refund_reconciliation_status = 'pending';

      CREATE INDEX IF NOT EXISTS supplier_activations_authorization_expiry_cancellation_idx
        ON supplier_activations (cancel_available_at)
        WHERE status = 'waiting_sms' AND authorization_expiry_cancellation_pending;

      CREATE INDEX IF NOT EXISTS supplier_activations_authorization_revocation_cancellation_idx
        ON supplier_activations (cancel_available_at)
        WHERE status = 'waiting_sms' AND authorization_revocation_cancellation_pending;

      CREATE TABLE IF NOT EXISTS supplier_activation_refunds (
        supplier_activation_id UUID PRIMARY KEY REFERENCES supplier_activations(id) ON DELETE RESTRICT,
        amount NUMERIC NOT NULL CHECK (amount >= 0),
        currency TEXT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lifecycle_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        authorization_id UUID NOT NULL REFERENCES activation_authorizations(id) ON DELETE RESTRICT,
        supplier_activation_id UUID REFERENCES supplier_activations(id) ON DELETE RESTRICT,
        event_kind TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS lifecycle_events_authorization_idx
        ON lifecycle_events (authorization_id, occurred_at);

      CREATE OR REPLACE FUNCTION record_authorization_status_change() RETURNS trigger AS $$
      BEGIN
        INSERT INTO lifecycle_events (authorization_id, event_kind)
        VALUES (NEW.id, 'authorization_status:' || NEW.status);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION record_supplier_activation_status_change() RETURNS trigger AS $$
      BEGIN
        INSERT INTO lifecycle_events (authorization_id, supplier_activation_id, event_kind)
        VALUES (NEW.authorization_id, NEW.id, 'supplier_activation_status:' || NEW.status);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION record_number_acquisition_status_change() RETURNS trigger AS $$
      BEGIN
        INSERT INTO lifecycle_events (authorization_id, event_kind)
        VALUES (NEW.authorization_id, 'number_acquisition_status:' || NEW.status);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS activation_authorization_status_event ON activation_authorizations;
      CREATE TRIGGER activation_authorization_status_event
        AFTER INSERT OR UPDATE OF status ON activation_authorizations
        FOR EACH ROW EXECUTE FUNCTION record_authorization_status_change();

      DROP TRIGGER IF EXISTS supplier_activation_status_event ON supplier_activations;
      CREATE TRIGGER supplier_activation_status_event
        AFTER INSERT OR UPDATE OF status ON supplier_activations
        FOR EACH ROW EXECUTE FUNCTION record_supplier_activation_status_change();

      CREATE TABLE IF NOT EXISTS hero_sms_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        provider_activation_id TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        payload_digest TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (provider_activation_id, received_at, payload_digest)
      );

      CREATE TABLE IF NOT EXISTS number_acquisition_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        authorization_id UUID NOT NULL REFERENCES activation_authorizations(id) ON DELETE RESTRICT,
        candidate_position SMALLINT NOT NULL CHECK (candidate_position BETWEEN 1 AND 3),
        country_id INTEGER NOT NULL,
        requested_price NUMERIC NOT NULL CHECK (requested_price >= 0),
        status TEXT NOT NULL CHECK (status IN ('requesting', 'reconciling', 'manual', 'resolved', 'confirmed_absent', 'failed')),
        error_kind TEXT,
        requested_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT number_acquisition_requests_candidate_position_fkey
          FOREIGN KEY (authorization_id, candidate_position, country_id)
          REFERENCES authorization_candidate_countries (authorization_id, position, country_id) ON DELETE RESTRICT
      );

      ALTER TABLE number_acquisition_requests
        ADD COLUMN IF NOT EXISTS candidate_position SMALLINT;
      UPDATE number_acquisition_requests request
        SET candidate_position = candidate.position
        FROM authorization_candidate_countries candidate
        WHERE request.candidate_position IS NULL
          AND candidate.authorization_id = request.authorization_id
          AND candidate.country_id = request.country_id;
      ALTER TABLE number_acquisition_requests ALTER COLUMN candidate_position SET NOT NULL;
      ALTER TABLE number_acquisition_requests DROP CONSTRAINT IF EXISTS number_acquisition_requests_candidate_position_check;
      ALTER TABLE number_acquisition_requests ADD CONSTRAINT number_acquisition_requests_candidate_position_check
        CHECK (candidate_position BETWEEN 1 AND 3);

      ALTER TABLE number_acquisition_requests DROP CONSTRAINT IF EXISTS number_acquisition_requests_candidate_position_fkey;
      ALTER TABLE number_acquisition_requests ADD CONSTRAINT number_acquisition_requests_candidate_position_fkey
        FOREIGN KEY (authorization_id, candidate_position, country_id)
        REFERENCES authorization_candidate_countries (authorization_id, position, country_id) ON DELETE RESTRICT;

      CREATE INDEX IF NOT EXISTS number_acquisition_requests_unresolved_idx
        ON number_acquisition_requests (requested_at)
        WHERE status IN ('requesting', 'reconciling', 'manual');

      CREATE TABLE IF NOT EXISTS number_acquisition_candidates (
        request_id UUID NOT NULL REFERENCES number_acquisition_requests(id) ON DELETE CASCADE,
        provider_activation_id TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        activation_cost NUMERIC NOT NULL CHECK (activation_cost >= 0),
        currency TEXT NOT NULL,
        service_code TEXT,
        country_id INTEGER,
        activation_time TIMESTAMPTZ,
        provider_status TEXT NOT NULL,
        PRIMARY KEY (request_id, provider_activation_id)
      );

      DROP TRIGGER IF EXISTS number_acquisition_status_event ON number_acquisition_requests;
      CREATE TRIGGER number_acquisition_status_event
        AFTER INSERT OR UPDATE OF status ON number_acquisition_requests
        FOR EACH ROW EXECUTE FUNCTION record_number_acquisition_status_change();
    `);

    // 每次进程初始化都使旧 Cookie 失效，避免部署重启后保留管理权限。
    await this.pool.query('UPDATE admin_sessions SET invalidated_at = now() WHERE invalidated_at IS NULL');
  }

  async transaction<Result>(action: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async defaultCandidateCountryIds(): Promise<number[]> {
    const result = await this.pool.query<{ country_id: number }>(
      'SELECT country_id FROM default_candidate_countries ORDER BY position',
    );
    return result.rows.map((row) => row.country_id);
  }

  async defaultCandidateLocations(): Promise<Array<{ position: number; countryId: number; countryName?: string }>> {
    const result = await this.pool.query<{ position: number; country_id: number; country_name: string | null }>(
      'SELECT position, country_id, country_name FROM default_candidate_countries ORDER BY position',
    );
    return result.rows.map((row) => ({
      position: row.position,
      countryId: row.country_id,
      ...(row.country_name !== null ? { countryName: row.country_name } : {}),
    }));
  }

  async replaceDefaultCandidateLocations(locations: readonly { countryId: number; countryName: string }[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('DELETE FROM default_candidate_countries');
      for (const [index, location] of locations.entries()) {
        await client.query(
          'INSERT INTO default_candidate_countries (position, country_id, country_name) VALUES ($1, $2, $3)',
          [index + 1, location.countryId, location.countryName],
        );
      }
    });
  }

  async replaceDefaultCandidateCountryIds(countryIds: readonly number[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('DELETE FROM default_candidate_countries');
      for (const [index, countryId] of countryIds.entries()) {
        await client.query(
          'INSERT INTO default_candidate_countries (position, country_id) VALUES ($1, $2)',
          [index + 1, countryId],
        );
      }
    });
  }

  async hasUnendedAuthorization(normalizedRecipientIdentifier: string, now: Date): Promise<boolean> {
    await this.expireDueAuthorizations(now);
    const result = await this.pool.query(
      `SELECT 1 FROM activation_authorizations
       WHERE normalized_recipient_identifier = $1 AND status IN ('unclaimed', 'in_progress')
       LIMIT 1`,
      [normalizedRecipientIdentifier],
    );
    return result.rowCount === 1;
  }

  async createActivationAuthorization(input: {
    recipientIdentifier: string;
    normalizedRecipientIdentifier: string;
    internalNote?: string;
    tokenHash: string;
    tokenSuffix?: string;
    createdAt: Date;
    expiresAt: Date;
    candidates: Array<{ countryId: number; countryName: string; price: number; stock: number }>;
  }): Promise<string> {
    if (input.candidates.length !== 3) {
      throw new Error('激活授权必须包含三个候选位置');
    }
    return this.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO activation_authorizations
          (recipient_identifier, normalized_recipient_identifier, internal_note, token_hash, token_suffix, status, created_at, expires_at, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, 'unclaimed', $6, $7, $6)
         RETURNING id`,
        [input.recipientIdentifier, input.normalizedRecipientIdentifier, input.internalNote ?? null, input.tokenHash, input.tokenSuffix ?? null, input.createdAt, input.expiresAt],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('创建激活授权失败');
      for (const [index, candidate] of input.candidates.entries()) {
        await client.query(
          `INSERT INTO authorization_candidate_countries
            (authorization_id, position, country_id, country_name, quoted_price, quoted_stock)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, index + 1, candidate.countryId, candidate.countryName, candidate.price, candidate.stock],
        );
      }
      return id;
    });
  }

  async createActivationAuthorizations(inputs: readonly { tokenHash: string; tokenSuffix: string; createdAt: Date }[]): Promise<string[]> {
    if (inputs.length < 1 || inputs.length > 50) throw new Error('一次必须创建 1 至 50 条激活授权');
    return this.transaction(async (client) => {
      const ids: string[] = [];
      for (const input of inputs) {
        const result = await client.query<{ id: string }>(
          `INSERT INTO activation_authorizations
             (token_hash, token_suffix, status, created_at, expires_at, last_activity_at)
           VALUES ($1, $2, 'unclaimed', $3, NULL, $3)
           RETURNING id`,
          [input.tokenHash, input.tokenSuffix, input.createdAt],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('创建激活授权失败');
        ids.push(id);
      }
      return ids;
    });
  }

  async listActivationAuthorizations(now: Date): Promise<AuthorizationListItem[]>;
  async listActivationAuthorizations(options: AuthorizationListOptions, now?: Date): Promise<AuthorizationListPageResult>;
  async listActivationAuthorizations(
    optionsOrNow: AuthorizationListOptions | Date,
    now = new Date(),
  ): Promise<AuthorizationListItem[] | AuthorizationListPageResult> {
    const legacyCall = optionsOrNow instanceof Date;
    const options = legacyCall ? { page: 1, order: 'created' as const } : optionsOrNow;
    const effectiveNow = legacyCall ? optionsOrNow : now;
    if (legacyCall) await this.expireDueAuthorizations(effectiveNow);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.status) {
      parameters.push(options.status);
      clauses.push(`auth.status = $${parameters.length}`);
    }
    if (options.tokenSuffix) {
      parameters.push(options.tokenSuffix);
      clauses.push(`auth.token_suffix = $${parameters.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM activation_authorizations auth ${where}`,
      parameters,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    const pageCount = Math.max(1, Math.ceil(total / 20));
    const page = Math.min(Math.max(1, options.page), pageCount);
    const listParameters = [...parameters, 20, (page - 1) * 20];
    const orderBy = options.order === 'created'
      ? 'auth.created_at DESC, auth.id DESC'
      : 'COALESCE(auth.last_activity_at, auth.created_at) DESC, auth.id DESC';
    const result = await this.pool.query<{
      id: string; recipient_identifier: string | null; token_suffix: string | null; internal_note: string | null;
      status: AuthorizationStatus; created_at: Date; expires_at: Date | null; last_activity_at: Date;
      activation_status: string | null; acquisition_status: string | null; has_pending_exception: boolean;
    }>(
      `SELECT auth.id, auth.recipient_identifier, auth.token_suffix, auth.internal_note, auth.status, auth.created_at, auth.expires_at,
              COALESCE(auth.last_activity_at, auth.created_at) AS last_activity_at,
              activation.status AS activation_status, acquisition.status AS acquisition_status,
              EXISTS (
                SELECT 1 FROM supplier_activations item
                WHERE item.authorization_id = auth.id
                  AND (item.status = 'manual_reconciliation' OR item.refund_reconciliation_status = 'pending')
              ) AS has_pending_exception
       FROM activation_authorizations auth
       LEFT JOIN LATERAL (
         SELECT status FROM supplier_activations WHERE authorization_id = auth.id ORDER BY acquired_at DESC LIMIT 1
       ) activation ON true
       LEFT JOIN LATERAL (
         SELECT status FROM number_acquisition_requests
         WHERE authorization_id = auth.id AND status IN ('requesting', 'reconciling', 'manual')
         ORDER BY requested_at DESC LIMIT 1
       ) acquisition ON true
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      listParameters,
    );
    const pageResult: AuthorizationListPageResult = {
      items: result.rows.map((row) => ({
        id: row.id,
        ...(row.recipient_identifier !== null ? { recipientIdentifier: row.recipient_identifier } : {}),
        ...(row.token_suffix !== null ? { tokenSuffix: row.token_suffix } : {}),
        ...(row.internal_note ? { internalNote: row.internal_note } : {}),
        status: AUTHORIZATION_STATUS_LABELS[row.status],
        createdAt: row.created_at,
        ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
        lastActivityAt: row.last_activity_at,
        canRevoke: ['unclaimed', 'in_progress', 'result_available', 'sms_delivered'].includes(row.status)
          && (row.expires_at === null || row.expires_at > effectiveNow),
        ...(row.activation_status ? { currentActivationStatus: row.activation_status } : {}),
        hasPendingException: row.has_pending_exception || row.acquisition_status === 'reconciling' || row.acquisition_status === 'manual',
      })),
      total,
      page,
      pageCount,
    };
    return legacyCall ? pageResult.items : pageResult;
  }

  async authorizationByTokenHash(hash: string): Promise<{ id: string; status: AuthorizationStatus; expiresAt: Date | null } | undefined> {
    const result = await this.pool.query<{ id: string; status: AuthorizationStatus; expires_at: Date | null }>(
      'SELECT id, status, expires_at FROM activation_authorizations WHERE token_hash = $1',
      [hash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, status: row.status, expiresAt: row.expires_at } : undefined;
  }

  async expireDueAuthorizations(now: Date): Promise<void> {
    await this.transaction(async (client) => {
      const due = await client.query<{ id: string; status: AuthorizationStatus }>(
        `SELECT id, status FROM activation_authorizations
         WHERE expires_at IS NOT NULL AND expires_at <= $1
           AND (token_hash IS NOT NULL OR recipient_session_hash IS NOT NULL)
         FOR UPDATE`,
        [now],
      );
      if (!due.rowCount) return;
      const ids = due.rows.map((row) => row.id);
      await client.query(
        `UPDATE activation_authorizations
         SET status = CASE
               WHEN status IN ('unclaimed', 'in_progress', 'sms_delivered', 'quota_exhausted', 'revoked', 'expired') THEN 'expired'
               ELSE 'ended'
             END,
             ended_at = COALESCE(ended_at, $2),
             ended_reason = COALESCE(ended_reason, 'claim_window_ended'),
             token_hash = NULL, recipient_session_hash = NULL, last_activity_at = $2
         WHERE id = ANY($1::uuid[])`,
        [ids, now],
      );
    });
  }

  async expireAuthorization(id: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE activation_authorizations
       SET status = CASE
             WHEN status IN ('unclaimed', 'in_progress', 'sms_delivered', 'quota_exhausted', 'revoked', 'expired') THEN 'expired'
             ELSE 'ended'
           END,
           ended_at = COALESCE(ended_at, $2),
           ended_reason = COALESCE(ended_reason, 'claim_window_ended'),
           token_hash = NULL, recipient_session_hash = NULL, last_activity_at = $2
       WHERE id = $1 AND expires_at IS NOT NULL AND expires_at <= $2`,
      [id, now],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
