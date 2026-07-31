import { Pool, type PoolClient } from 'pg';

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
        country_id INTEGER NOT NULL UNIQUE CHECK (country_id >= 0)
      );

      CREATE TABLE IF NOT EXISTS activation_authorizations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_identifier TEXT NOT NULL,
        normalized_recipient_identifier TEXT NOT NULL,
        internal_note TEXT,
        token_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('unclaimed', 'in_progress', 'sms_delivered', 'quota_exhausted', 'revoked', 'expired')),
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        CHECK (expires_at = created_at + INTERVAL '24 hours')
      );

      ALTER TABLE activation_authorizations DROP CONSTRAINT IF EXISTS activation_authorizations_status_check;
      ALTER TABLE activation_authorizations ADD CONSTRAINT activation_authorizations_status_check
        CHECK (status IN ('unclaimed', 'in_progress', 'sms_delivered', 'quota_exhausted', 'revoked', 'expired'));

      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_token_hash_idx
        ON activation_authorizations (token_hash)
        WHERE token_hash IS NOT NULL;

      DROP INDEX IF EXISTS activation_authorizations_unclaimed_recipient_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_unended_recipient_idx
        ON activation_authorizations (normalized_recipient_identifier)
        WHERE status IN ('unclaimed', 'in_progress');

      ALTER TABLE activation_authorizations
        ADD COLUMN IF NOT EXISTS recipient_session_hash TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_recipient_session_idx
        ON activation_authorizations (recipient_session_hash)
        WHERE recipient_session_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS authorization_candidate_countries (
        authorization_id UUID NOT NULL REFERENCES activation_authorizations(id) ON DELETE RESTRICT,
        position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 3),
        country_id INTEGER NOT NULL CHECK (country_id >= 0),
        country_name TEXT NOT NULL,
        quoted_price NUMERIC NOT NULL CHECK (quoted_price >= 0),
        quoted_stock INTEGER NOT NULL CHECK (quoted_stock > 0),
        used_at TIMESTAMPTZ,
        PRIMARY KEY (authorization_id, position),
        UNIQUE (authorization_id, country_id)
      );

      ALTER TABLE authorization_candidate_countries
        ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS supplier_activations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        authorization_id UUID NOT NULL REFERENCES activation_authorizations(id) ON DELETE RESTRICT,
        country_id INTEGER NOT NULL,
        provider_activation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('acquisition_confirming', 'waiting_sms', 'manual_reconciliation', 'sms_delivered', 'completion_confirming', 'completed')),
        phone_number TEXT,
        activation_cost NUMERIC NOT NULL CHECK (activation_cost >= 0),
        currency TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL,
        cancel_available_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        CHECK (expires_at > acquired_at),
        CHECK (cancel_available_at >= acquired_at)
      );

      ALTER TABLE supplier_activations DROP CONSTRAINT IF EXISTS supplier_activations_status_check;
      ALTER TABLE supplier_activations ADD CONSTRAINT supplier_activations_status_check
        CHECK (status IN ('acquisition_confirming', 'waiting_sms', 'manual_reconciliation', 'sms_delivered', 'completion_confirming', 'completed'));
      ALTER TABLE supplier_activations ALTER COLUMN phone_number DROP NOT NULL;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS sms_code TEXT;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS sms_text TEXT;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS sms_received_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS completion_claimed_at TIMESTAMPTZ;

      DROP INDEX IF EXISTS supplier_activations_current_idx;
      CREATE UNIQUE INDEX supplier_activations_current_idx
        ON supplier_activations (authorization_id)
        WHERE status IN ('acquisition_confirming', 'waiting_sms', 'manual_reconciliation', 'sms_delivered', 'completion_confirming');

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
        country_id INTEGER NOT NULL,
        requested_price NUMERIC NOT NULL CHECK (requested_price >= 0),
        status TEXT NOT NULL CHECK (status IN ('requesting', 'reconciling', 'manual', 'resolved', 'confirmed_absent', 'failed')),
        error_kind TEXT,
        requested_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

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
    createdAt: Date;
    expiresAt: Date;
    candidates: Array<{ countryId: number; countryName: string; price: number; stock: number }>;
  }): Promise<string> {
    if (input.candidates.length !== 3 || new Set(input.candidates.map((candidate) => candidate.countryId)).size !== 3) {
      throw new Error('激活授权必须包含三个不同的候选地区');
    }
    return this.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO activation_authorizations
          (recipient_identifier, normalized_recipient_identifier, internal_note, token_hash, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'unclaimed', $5, $6)
         RETURNING id`,
        [input.recipientIdentifier, input.normalizedRecipientIdentifier, input.internalNote ?? null, input.tokenHash, input.createdAt, input.expiresAt],
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

  async listActivationAuthorizations(now: Date): Promise<Array<{
    id: string;
    recipientIdentifier: string;
    internalNote?: string;
    status: '待领取' | '进行中' | '短信已送达' | '额度已用尽' | '已撤销' | '已到期';
    createdAt: Date;
    expiresAt: Date;
  }>> {
    await this.expireDueAuthorizations(now);
    const result = await this.pool.query<{
      id: string; recipient_identifier: string; internal_note: string | null;
      status: 'unclaimed' | 'in_progress' | 'sms_delivered' | 'quota_exhausted' | 'revoked' | 'expired'; created_at: Date; expires_at: Date;
    }>(
      `SELECT id, recipient_identifier, internal_note, status, created_at, expires_at
       FROM activation_authorizations ORDER BY created_at DESC LIMIT 20`,
    );
    const labels = { unclaimed: '待领取', in_progress: '进行中', sms_delivered: '短信已送达', quota_exhausted: '额度已用尽', revoked: '已撤销', expired: '已到期' } as const;
    return result.rows.map((row) => ({
      id: row.id,
      recipientIdentifier: row.recipient_identifier,
      ...(row.internal_note ? { internalNote: row.internal_note } : {}),
      status: labels[row.status],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  async revokeUnclaimedAuthorization(id: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE activation_authorizations
       SET status = 'revoked', revoked_at = $2
       WHERE id = $1 AND status = 'unclaimed' AND expires_at > $2`,
      [id, now],
    );
    return result.rowCount === 1;
  }

  async authorizationByTokenHash(hash: string): Promise<{ id: string; status: 'unclaimed' | 'in_progress' | 'sms_delivered' | 'quota_exhausted' | 'revoked' | 'expired'; expiresAt: Date } | undefined> {
    const result = await this.pool.query<{ id: string; status: 'unclaimed' | 'in_progress' | 'sms_delivered' | 'quota_exhausted' | 'revoked' | 'expired'; expires_at: Date }>(
      'SELECT id, status, expires_at FROM activation_authorizations WHERE token_hash = $1',
      [hash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, status: row.status, expiresAt: row.expires_at } : undefined;
  }

  async expireDueAuthorizations(now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE activation_authorizations SET status = 'expired', token_hash = NULL
       WHERE status <> 'expired' AND expires_at <= $1`,
      [now],
    );
  }

  async expireAuthorization(id: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE activation_authorizations SET status = 'expired', token_hash = NULL
       WHERE id = $1 AND expires_at <= $2`,
      [id, now],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
