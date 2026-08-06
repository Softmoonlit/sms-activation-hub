import { Pool, type PoolClient } from 'pg';

export type AuthorizationStatus =
  | 'unclaimed'
  | 'in_progress'
  | 'result_available'
  | 'ended';

export type AuthorizationListDisplayStatus = '待领取' | '进行中' | '结果可查看' | '已结束';
export type AuthorizationListTopLevelStatus = 'unclaimed' | 'in_progress' | 'result_available' | 'ended';

export const AUTHORIZATION_LIST_PAGE_SIZE = 20;

export interface AuthorizationListQuery {
  page?: number;
  status?: AuthorizationListTopLevelStatus;
  tokenSuffix?: string;
}

export interface AuthorizationListRecord {
  id: string;
  tokenSuffix?: string;
  status: '待领取' | '进行中' | '结果可查看' | '已结束';
}

export interface AuthorizationListPage {
  items: AuthorizationListRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  status?: AuthorizationListTopLevelStatus;
  tokenSuffix?: string;
}

export interface AuthorizationListItem {
  id: string;
  tokenSuffix?: string;
  internalNote?: string;
  status: AuthorizationListDisplayStatus;
  createdAt: Date;
  lastActivityAt: Date;
  canRevoke: boolean;
  currentActivationStatus?: string;
  hasPendingException: boolean;
}

export const AUTHORIZATION_STATUS_LABELS: Record<AuthorizationStatus, AuthorizationListDisplayStatus> = {
  unclaimed: '待领取',
  in_progress: '进行中',
  result_available: '结果可查看',
  ended: '已结束',
};

export const AUTHORIZATION_LIST_STATUS_LABELS: Record<AuthorizationListTopLevelStatus, AuthorizationListRecord['status']> = {
  unclaimed: '待领取',
  in_progress: '进行中',
  result_available: '结果可查看',
  ended: '已结束',
};

export const AUTHORIZATION_LIST_STATUS_BUCKETS: Record<AuthorizationListTopLevelStatus, readonly AuthorizationStatus[]> = {
  unclaimed: ['unclaimed'],
  in_progress: ['in_progress'],
  result_available: ['result_available'],
  ended: ['ended'],
};

export function topLevelStatusOf(status: AuthorizationStatus): AuthorizationListTopLevelStatus {
  return status;
}

export interface DefaultCandidateLocation {
  position: number;
  countryId: number;
  countryName?: string;
}

export interface CompleteDefaultCandidateLocation {
  position: number;
  countryId: number;
  countryName: string;
}

const MIN_CANDIDATE_POSITION_COUNT = 3;
const MAX_CANDIDATE_POSITION_COUNT = 10;

function completeDefaultCandidateLocationsFromRows(
  locations: readonly { position: number; countryId: number; countryName?: string | null }[],
): CompleteDefaultCandidateLocation[] | undefined {
  if (locations.length < MIN_CANDIDATE_POSITION_COUNT
    || locations.length > MAX_CANDIDATE_POSITION_COUNT
    || locations.some((location, index) => (
    location.position !== index + 1 || !location.countryName || !location.countryName.trim()
  ))) {
    return undefined;
  }
  return locations.map((location) => ({
    position: location.position,
    countryId: location.countryId,
    countryName: location.countryName!,
  }));
}

export class AuthorizationTokenSuffixCollisionError extends Error {
  constructor(readonly suffix: string) {
    super(`授权链接末 8 位已存在：${suffix}`);
  }
}

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
        country_name TEXT NOT NULL
      );

      ALTER TABLE default_candidate_countries
        ADD COLUMN IF NOT EXISTS country_name TEXT;

      ALTER TABLE default_candidate_countries
        DROP CONSTRAINT IF EXISTS default_candidate_countries_country_id_key;

      ALTER TABLE default_candidate_countries
        DROP CONSTRAINT IF EXISTS default_candidate_countries_country_name_check;

      CREATE TABLE IF NOT EXISTS activation_authorizations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        internal_note TEXT,
        token_hash TEXT,
        token_suffix TEXT,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ,
        number_acquisition_expires_at TIMESTAMPTZ,
        result_view_until TIMESTAMPTZ,
        end_prompt_until TIMESTAMPTZ,
        ended_at TIMESTAMPTZ,
        ended_reason TEXT,
        last_activity_at TIMESTAMPTZ,
        recipient_session_hash TEXT
      );
    `);

    const existingDefaultLocations = await this.pool.query<{
      position: number; country_id: number; country_name: string | null;
    }>('SELECT position, country_id, country_name FROM default_candidate_countries ORDER BY position');
    const defaultPositionConstraints = await this.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'default_candidate_countries'::regclass AND contype = 'c'`,
    );
    const hasLegacyPositionConstraint = defaultPositionConstraints.rows.some(({ definition }) => (
      definition.includes('position') && definition.includes('position <= 3')
    ));
    const completeExistingDefaultLocations = completeDefaultCandidateLocationsFromRows(
      existingDefaultLocations.rows.map((location) => ({
        position: location.position,
        countryId: location.country_id,
        countryName: location.country_name,
      })),
    );
    if (existingDefaultLocations.rows.length > 0
      && (!completeExistingDefaultLocations
        || (hasLegacyPositionConstraint && completeExistingDefaultLocations.length !== 3))) {
      throw new Error('旧默认候选位置配置必须为空或完整包含位置一至三');
    }

    await this.pool.query(`
      ALTER TABLE default_candidate_countries
        DROP CONSTRAINT IF EXISTS default_candidate_countries_position_check;
      ALTER TABLE default_candidate_countries
        ADD CONSTRAINT default_candidate_countries_position_check
        CHECK (position BETWEEN 1 AND 10);
      ALTER TABLE default_candidate_countries
        ALTER COLUMN country_name SET NOT NULL;
      ALTER TABLE default_candidate_countries
        ADD CONSTRAINT default_candidate_countries_country_name_check
        CHECK (length(btrim(country_name)) > 0);
    `);

    // 补齐新模型列：必须先于旧模型记录检查执行（检查查询引用了 claimed_at 等新列，
    // 旧库升级时这些列可能尚不存在）
    await this.pool.query(`
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
    `);

    // 检查是否存在未完结的旧模型记录（限定当前 schema，避免跨 schema 误判其他库的旧表）
    const columnCheck = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'activation_authorizations'
         AND column_name = ANY($1::text[])`,
      [['recipient_identifier', 'expires_at']],
    );
    if (columnCheck.rows.length > 0) {
      const activeLegacyCheck = await this.pool.query(
        `SELECT id FROM activation_authorizations
         WHERE status IN ('unclaimed', 'in_progress', 'result_available', 'sms_delivered', 'quota_exhausted')
           AND (
             recipient_identifier IS NOT NULL
             OR expires_at IS NOT NULL
             OR (claimed_at IS NULL AND status <> 'unclaimed')
           )
         LIMIT 1`,
      );
      if (activeLegacyCheck.rows.length > 0) {
        throw new Error('存在未完结的旧模型激活授权，收缩迁移无法安全继续');
      }
    }

    // 旧库的状态约束不含 ended/result_available，必须先移除旧约束再收敛，
    // 否则 UPDATE 到新状态会违反旧 CHECK 约束
    await this.pool.query(`
      ALTER TABLE activation_authorizations DROP CONSTRAINT IF EXISTS activation_authorizations_status_check;

      UPDATE activation_authorizations
        SET status = 'ended',
            ended_reason = 'admin_revoked',
            ended_at = COALESCE(ended_at, created_at),
            token_hash = NULL,
            recipient_session_hash = NULL
        WHERE status = 'revoked';

      UPDATE activation_authorizations
        SET status = 'ended',
            ended_reason = COALESCE(ended_reason, 'acquisition_expired'),
            ended_at = COALESCE(ended_at, created_at),
            token_hash = NULL,
            recipient_session_hash = NULL
        WHERE status = 'expired';

      UPDATE activation_authorizations
        SET status = 'ended',
            ended_reason = COALESCE(ended_reason, 'quota_exhausted'),
            token_hash = NULL,
            recipient_session_hash = NULL
        WHERE status = 'quota_exhausted';

      UPDATE activation_authorizations
        SET status = CASE
              WHEN result_view_until IS NOT NULL AND result_view_until > now() THEN 'result_available'
              ELSE 'ended'
            END,
            ended_reason = CASE
              WHEN result_view_until IS NOT NULL AND result_view_until > now() THEN ended_reason
              ELSE 'result_view_expired'
            END,
            ended_at = CASE
              WHEN result_view_until IS NOT NULL AND result_view_until > now() THEN ended_at
              ELSE COALESCE(ended_at, result_view_until, now())
            END,
            token_hash = CASE
              WHEN result_view_until IS NOT NULL AND result_view_until > now() THEN token_hash
              ELSE NULL
            END,
            recipient_session_hash = CASE
              WHEN result_view_until IS NOT NULL AND result_view_until > now() THEN recipient_session_hash
              ELSE NULL
            END
        WHERE status = 'sms_delivered';

      ALTER TABLE activation_authorizations ADD CONSTRAINT activation_authorizations_status_check
        CHECK (status IN ('unclaimed', 'in_progress', 'result_available', 'ended'));

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

      ALTER TABLE activation_authorizations DROP COLUMN IF EXISTS recipient_identifier;
      ALTER TABLE activation_authorizations DROP COLUMN IF EXISTS normalized_recipient_identifier;
      ALTER TABLE activation_authorizations DROP COLUMN IF EXISTS expires_at;
      ALTER TABLE activation_authorizations DROP COLUMN IF EXISTS revoked_at;

      CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_recipient_session_idx
        ON activation_authorizations (recipient_session_hash)
        WHERE recipient_session_hash IS NOT NULL;

      UPDATE activation_authorizations
        SET last_activity_at = COALESCE(last_activity_at, created_at)
        WHERE last_activity_at IS NULL;

      CREATE INDEX IF NOT EXISTS activation_authorizations_inventory_activity_idx
        ON activation_authorizations (last_activity_at DESC, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS activation_authorizations_inventory_status_activity_idx
        ON activation_authorizations (status, last_activity_at DESC, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS authorization_candidate_countries (
        authorization_id UUID NOT NULL REFERENCES activation_authorizations(id) ON DELETE RESTRICT,
        position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 3),
        country_id INTEGER NOT NULL CHECK (country_id >= 0),
        country_name TEXT NOT NULL,
        used_at TIMESTAMPTZ,
        PRIMARY KEY (authorization_id, position)
      );

      ALTER TABLE authorization_candidate_countries
        ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
      -- 彻底删除领取时的报价和库存快照字段（ADR-0004），候选位置只保存稳定地区事实。
      ALTER TABLE authorization_candidate_countries
        DROP COLUMN IF EXISTS quoted_price;
      ALTER TABLE authorization_candidate_countries
        DROP COLUMN IF EXISTS quoted_stock;
      ALTER TABLE authorization_candidate_countries
        DROP CONSTRAINT IF EXISTS authorization_candidate_countri_authorization_id_country_id_key;
      ALTER TABLE authorization_candidate_countries
        DROP CONSTRAINT IF EXISTS authorization_candidate_countries_position_check;
      ALTER TABLE authorization_candidate_countries
        ADD CONSTRAINT authorization_candidate_countries_position_check
        CHECK (position BETWEEN 1 AND 10);

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
        CHECK (candidate_position BETWEEN 1 AND 10);
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
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS end_use_pending BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS supplier_cancelled_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timed_out_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS refund_reconciliation_status TEXT NOT NULL DEFAULT 'resolved';
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timeout_final_status_confirmed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timeout_reconciliation_claimed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS timeout_reconciliation_claim_token TEXT;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS authorization_expiry_cancellation_pending BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS authorization_revocation_cancellation_pending BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS cancellation_retry_after TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS cancellation_reconciliation_claimed_at TIMESTAMPTZ;
      ALTER TABLE supplier_activations ADD COLUMN IF NOT EXISTS cancellation_reconciliation_claim_token TEXT;
      -- 旧列名只描述撤销来源，重试期限现在由换号、结束使用、撤销与授权到期四种来源共用；
      -- 旧库存在旧列时迁移数据，全新库直接跳过；迁移后删除旧列，不留兼容层。
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'supplier_activations'
            AND column_name = 'authorization_revocation_cancellation_retry_after'
        ) THEN
          UPDATE supplier_activations
            SET cancellation_retry_after = authorization_revocation_cancellation_retry_after
            WHERE cancellation_retry_after IS NULL AND authorization_revocation_cancellation_retry_after IS NOT NULL;
        END IF;
      END $$;
      ALTER TABLE supplier_activations DROP COLUMN IF EXISTS authorization_revocation_cancellation_retry_after;
      ALTER TABLE supplier_activations DROP CONSTRAINT IF EXISTS supplier_activations_refund_reconciliation_status_check;
      ALTER TABLE supplier_activations ADD CONSTRAINT supplier_activations_refund_reconciliation_status_check
        CHECK (refund_reconciliation_status IN ('pending', 'resolved'));

      UPDATE supplier_activations
        SET status = 'manual_reconciliation'
        WHERE status = 'timed_out' AND timeout_final_status_confirmed_at IS NULL;

      -- 旧运行时版本可能在三个候选位置都消耗且最后激活已超时后留下 in_progress 中间态；
      -- 收缩模型下收敛为已结束并记录额度用尽原因，提示窗口期内仍保留 token 与浏览器绑定。
      UPDATE activation_authorizations auth
        SET status = 'ended',
            ended_reason = COALESCE(ended_reason, 'quota_exhausted'),
            ended_at = COALESCE(ended_at, now()),
            end_prompt_until = COALESCE(end_prompt_until, now() + INTERVAL '2 minutes'),
            last_activity_at = now()
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
      CREATE INDEX IF NOT EXISTS supplier_activations_timeout_reconciliation_idx
        ON supplier_activations (expires_at)
        WHERE status IN ('manual_reconciliation', 'timed_out') AND timed_out_at IS NOT NULL
          AND refund_reconciliation_status = 'pending';

      CREATE INDEX IF NOT EXISTS supplier_activations_authorization_expiry_cancellation_idx
        ON supplier_activations (cancel_available_at)
        WHERE status = 'waiting_sms' AND authorization_expiry_cancellation_pending;

      DROP INDEX IF EXISTS supplier_activations_authorization_revocation_cancellation_idx;
      CREATE INDEX IF NOT EXISTS supplier_activations_authorization_revocation_cancellation_idx
        ON supplier_activations (cancel_available_at)
        WHERE status IN ('waiting_sms', 'manual_reconciliation') AND authorization_revocation_cancellation_pending;

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
        CHECK (candidate_position BETWEEN 1 AND 10);

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
        phone_number TEXT,
        activation_cost NUMERIC NOT NULL CHECK (activation_cost >= 0),
        currency TEXT NOT NULL,
        service_code TEXT,
        country_id INTEGER,
        activation_time TIMESTAMPTZ,
        provider_status TEXT NOT NULL,
        PRIMARY KEY (request_id, provider_activation_id)
      );

      ALTER TABLE number_acquisition_candidates
        ALTER COLUMN phone_number DROP NOT NULL;

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

  async defaultCandidateLocations(): Promise<DefaultCandidateLocation[]> {
    const result = await this.pool.query<{ position: number; country_id: number; country_name: string | null }>(
      'SELECT position, country_id, country_name FROM default_candidate_countries ORDER BY position',
    );
    return result.rows.map((row) => ({
      position: row.position,
      countryId: row.country_id,
      ...(row.country_name !== null ? { countryName: row.country_name } : {}),
    }));
  }

  async completeDefaultCandidateLocations(): Promise<CompleteDefaultCandidateLocation[] | undefined> {
    return completeDefaultCandidateLocationsFromRows(await this.defaultCandidateLocations());
  }

  async completeDefaultCandidateLocationsFor(client: PoolClient): Promise<CompleteDefaultCandidateLocation[] | undefined> {
    await client.query('LOCK TABLE default_candidate_countries IN SHARE MODE');
    const result = await client.query<{ position: number; country_id: number; country_name: string | null }>(
      'SELECT position, country_id, country_name FROM default_candidate_countries ORDER BY position',
    );
    return completeDefaultCandidateLocationsFromRows(result.rows.map((location) => ({
      position: location.position,
      countryId: location.country_id,
      countryName: location.country_name,
    })));
  }

  async replaceDefaultCandidateLocations(locations: readonly { countryId: number; countryName: string }[]): Promise<void> {
    if (locations.length < MIN_CANDIDATE_POSITION_COUNT
      || locations.length > MAX_CANDIDATE_POSITION_COUNT
      || locations.some((location) => (
      !Number.isSafeInteger(location.countryId) || location.countryId < 0 || !location.countryName.trim()
    ))) {
      throw new Error('默认候选地区必须包含三至十个完整位置');
    }
    await this.transaction(async (client) => {
      await client.query('LOCK TABLE default_candidate_countries IN EXCLUSIVE MODE');
      await client.query('DELETE FROM default_candidate_countries');
      for (const [index, location] of locations.entries()) {
        await client.query(
          'INSERT INTO default_candidate_countries (position, country_id, country_name) VALUES ($1, $2, $3)',
          [index + 1, location.countryId, location.countryName],
        );
      }
    });
  }

  async createUnclaimedAuthorizationBatch(input: readonly { tokenHash: string; tokenSuffix: string; createdAt: Date }[]): Promise<string[]> {
    if (input.length === 0) {
      throw new Error('批量创建至少需要一个授权链接');
    }
    const suffixes = input.map((record) => record.tokenSuffix);
    if (new Set(suffixes).size !== suffixes.length) {
      const duplicate = suffixes.find((suffix, index) => suffixes.indexOf(suffix) !== index);
      throw new AuthorizationTokenSuffixCollisionError(duplicate ?? suffixes[0]!);
    }
    return this.transaction(async (client) => {
      const existing = await client.query<{ token_suffix: string }>(
        'SELECT token_suffix FROM activation_authorizations WHERE token_suffix = ANY($1::text[]) LIMIT 1',
        [suffixes],
      );
      if (existing.rows[0]) {
        throw new AuthorizationTokenSuffixCollisionError(existing.rows[0].token_suffix);
      }

      const ids: string[] = [];
      for (const record of input) {
        const result = await client.query<{ id: string }>(
          `INSERT INTO activation_authorizations
            (internal_note, token_hash, token_suffix, status, created_at, last_activity_at)
           VALUES (NULL, $1, $2, 'unclaimed', $3, $3)
           RETURNING id`,
          [record.tokenHash, record.tokenSuffix, record.createdAt],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error('创建待领取激活授权失败');
        ids.push(id);
      }
      return ids;
    });
  }

  async listActivationAuthorizations(input: AuthorizationListQuery, now: Date): Promise<AuthorizationListPage> {
    await this.expireDueAuthorizations(now);

    const requestedPage = Number.isSafeInteger(input.page) && (input.page ?? 0) >= 1 ? input.page! : 1;
    const status = input.status;
    const tokenSuffix = input.tokenSuffix?.trim() || undefined;
    const where: string[] = [];
    const values: unknown[] = [];
    const addValue = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (status) where.push(`auth.status = ANY(${addValue(AUTHORIZATION_LIST_STATUS_BUCKETS[status])})`);
    if (tokenSuffix) where.push(`auth.token_suffix = ${addValue(tokenSuffix)}`);
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM activation_authorizations auth ${whereClause}`,
      values,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / AUTHORIZATION_LIST_PAGE_SIZE);
    const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
    const offset = (page - 1) * AUTHORIZATION_LIST_PAGE_SIZE;
    const offsetValue = addValue(offset);
    const limitValue = addValue(AUTHORIZATION_LIST_PAGE_SIZE);
    const result = await this.pool.query<{
      id: string; token_suffix: string | null; status: AuthorizationStatus;
    }>(
      `SELECT auth.id, auth.token_suffix, auth.status
       FROM activation_authorizations auth
       ${whereClause}
       ORDER BY COALESCE(auth.last_activity_at, auth.created_at) DESC, auth.created_at DESC, auth.id DESC
       LIMIT ${limitValue} OFFSET ${offsetValue}`,
      values,
    );

    const items = result.rows.map((row) => ({
      id: row.id,
      ...(row.token_suffix !== null ? { tokenSuffix: row.token_suffix } : {}),
      status: AUTHORIZATION_LIST_STATUS_LABELS[topLevelStatusOf(row.status)],
    }));
    return {
      items,
      page,
      pageSize: AUTHORIZATION_LIST_PAGE_SIZE,
      total,
      totalPages,
      hasPreviousPage: page > 1,
      hasNextPage: totalPages > 0 && page < totalPages,
      ...(status ? { status } : {}),
      ...(tokenSuffix ? { tokenSuffix } : {}),
    };
  }

  async authorizationByTokenHash(hash: string): Promise<{ id: string; status: AuthorizationStatus; numberAcquisitionExpiresAt: Date | null } | undefined> {
    const result = await this.pool.query<{ id: string; status: AuthorizationStatus; number_acquisition_expires_at: Date | null }>(
      'SELECT id, status, number_acquisition_expires_at FROM activation_authorizations WHERE token_hash = $1',
      [hash],
    );
    const row = result.rows[0];
    return row ? { id: row.id, status: row.status, numberAcquisitionExpiresAt: row.number_acquisition_expires_at } : undefined;
  }

  async expireDueAuthorizations(now: Date): Promise<void> {
    await this.transaction(async (client) => {
      const due = await client.query<{ id: string; status: AuthorizationStatus }>(
        `SELECT id, status FROM activation_authorizations
         WHERE number_acquisition_expires_at IS NOT NULL
           AND number_acquisition_expires_at <= $1
           AND status NOT IN ('result_available', 'ended')
           AND NOT (status = 'ended' AND end_prompt_until > $1)
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
           )
           AND (token_hash IS NOT NULL OR recipient_session_hash IS NOT NULL)
         FOR UPDATE`,
        [now],
      );
      if (!due.rowCount) return;
      const ids = due.rows.map((row) => row.id);
      await client.query(
        `UPDATE activation_authorizations
         SET status = 'ended',
             ended_at = COALESCE(ended_at, $2),
             ended_reason = COALESCE(ended_reason, 'acquisition_expired'),
             token_hash = NULL, recipient_session_hash = NULL, last_activity_at = $2
         WHERE id = ANY($1::uuid[])
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
        [ids, now],
      );
    });
  }

  async expireAuthorization(id: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE activation_authorizations
       SET status = 'ended',
           ended_at = COALESCE(ended_at, $2),
           ended_reason = COALESCE(ended_reason, 'acquisition_expired'),
           token_hash = NULL, recipient_session_hash = NULL, last_activity_at = $2
       WHERE id = $1 AND number_acquisition_expires_at IS NOT NULL
         AND number_acquisition_expires_at <= $2
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
      [id, now],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
