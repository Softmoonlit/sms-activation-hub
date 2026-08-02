import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import { Database } from '../src/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  test('数据库迁移集成测试需要 TEST_DATABASE_URL', () => {
    throw new Error('未设置 TEST_DATABASE_URL；请通过 npm test 运行完整测试');
  });
} else {
  test('旧数据库升级后回填候选位置并移除地区唯一约束', async () => {
    const schemaName = `migration_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());
    try {
      await database.initialize();
      const authorizationId = randomUUID();
      const createdAt = new Date('2026-08-01T00:00:00.000Z');
      const expiresAt = new Date('2026-08-02T00:00:00.000Z');
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, status, created_at, expires_at)
         VALUES ($1, '迁移测试', '迁移测试', 'revoked', $2, $3)`,
        [authorizationId, createdAt, expiresAt],
      );
      for (const position of [1, 2, 3]) {
        await database.pool.query(
          `INSERT INTO authorization_candidate_countries
             (authorization_id, position, country_id, country_name, quoted_price, quoted_stock)
           VALUES ($1, $2, $3, $4, 0.8, 1)`,
          [authorizationId, position, position, `地区${position}`],
        );
      }
      await database.pool.query(
        `INSERT INTO supplier_activations
           (authorization_id, candidate_position, country_id, provider_activation_id, status, activation_cost, currency, acquired_at, cancel_available_at, expires_at)
         VALUES ($1, 1, 1, $2, 'cancelled', 0.8, 'USD', $3, $3, $4)`,
        [authorizationId, `migration-${randomUUID()}`, createdAt, new Date('2026-08-01T00:20:00.000Z')],
      );
      await database.pool.query(
        `INSERT INTO number_acquisition_requests
           (authorization_id, candidate_position, country_id, requested_price, status, requested_at, updated_at)
         VALUES ($1, 2, 2, 0.8, 'manual', $2, $2)`,
        [authorizationId, createdAt],
      );

      await database.pool.query(`
        ALTER TABLE supplier_activations DROP CONSTRAINT supplier_activations_candidate_position_fkey;
        DROP INDEX supplier_activations_candidate_position_idx;
        ALTER TABLE supplier_activations DROP COLUMN candidate_position;
        ALTER TABLE number_acquisition_requests DROP CONSTRAINT number_acquisition_requests_candidate_position_fkey;
        ALTER TABLE number_acquisition_requests DROP COLUMN candidate_position;
        DROP INDEX authorization_candidate_countries_position_country_idx;
        ALTER TABLE default_candidate_countries
          ADD CONSTRAINT default_candidate_countries_country_id_key UNIQUE (country_id);
        ALTER TABLE authorization_candidate_countries
          ADD CONSTRAINT authorization_candidate_countri_authorization_id_country_id_key UNIQUE (authorization_id, country_id);
      `);

      await database.initialize();

      const migratedActivation = await database.pool.query<{ candidate_position: number }>(
        'SELECT candidate_position FROM supplier_activations WHERE authorization_id = $1', [authorizationId],
      );
      const migratedRequest = await database.pool.query<{ candidate_position: number }>(
        'SELECT candidate_position FROM number_acquisition_requests WHERE authorization_id = $1', [authorizationId],
      );
      assert.equal(migratedActivation.rows[0]?.candidate_position, 1);
      assert.equal(migratedRequest.rows[0]?.candidate_position, 2);
      await assert.rejects(
        database.pool.query(
          `INSERT INTO number_acquisition_requests
             (authorization_id, candidate_position, country_id, requested_price, status, requested_at, updated_at)
           VALUES ($1, 3, 1, 0.8, 'failed', $2, $2)`,
          [authorizationId, createdAt],
        ),
        (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23503'),
      );

      await database.replaceDefaultCandidateCountryIds([1, 1, 1]);
      assert.deepEqual(await database.defaultCandidateCountryIds(), [1, 1, 1]);

      const duplicateAuthorizationId = await database.createActivationAuthorization({
        recipientIdentifier: `迁移后重复地区-${randomUUID()}`,
        normalizedRecipientIdentifier: randomUUID(),
        tokenHash: randomUUID(),
        createdAt,
        expiresAt,
        candidates: [1, 2, 3].map(() => ({ countryId: 1, countryName: '美国', price: 0.8, stock: 1 })),
      });
      assert.ok(duplicateAuthorizationId);
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });

  test('扩展授权模型可重复迁移并兼容永久待领取与旧撤销记录', async () => {
    const schemaName = `authorization_model_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());
    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    const legacyAuthorizationId = randomUUID();
    try {
      await database.initialize();
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, token_hash, recipient_session_hash, status, created_at, expires_at)
         VALUES ($1, '旧撤销记录', '旧撤销记录', 'legacy-token-hash', 'legacy-session-hash', 'revoked', $2, $3)`,
        [legacyAuthorizationId, createdAt, new Date('2026-08-02T00:00:00.000Z')],
      );

      await database.pool.query(`
        DROP INDEX activation_authorizations_token_suffix_idx;
        ALTER TABLE activation_authorizations
          DROP CONSTRAINT activation_authorizations_token_suffix_check,
          DROP CONSTRAINT activation_authorizations_status_check,
          DROP COLUMN token_suffix,
          DROP COLUMN claimed_at,
          DROP COLUMN number_acquisition_expires_at,
          DROP COLUMN result_view_until,
          DROP COLUMN end_prompt_until,
          DROP COLUMN ended_at,
          DROP COLUMN ended_reason,
          DROP COLUMN last_activity_at,
          ALTER COLUMN recipient_identifier SET NOT NULL,
          ALTER COLUMN normalized_recipient_identifier SET NOT NULL,
          ALTER COLUMN expires_at SET NOT NULL;
        ALTER TABLE authorization_candidate_countries
          ALTER COLUMN quoted_price SET NOT NULL,
          ALTER COLUMN quoted_stock SET NOT NULL;
        ALTER TABLE default_candidate_countries DROP COLUMN country_name;
      `);
      await database.pool.query(
        `ALTER TABLE activation_authorizations ADD CONSTRAINT activation_authorizations_status_check
           CHECK (status IN ('unclaimed', 'in_progress', 'sms_delivered', 'quota_exhausted', 'revoked', 'expired'))`,
      );
      await database.pool.query(
        `ALTER TABLE activation_authorizations ADD CONSTRAINT activation_authorizations_check
           CHECK (expires_at = created_at + INTERVAL '24 hours')`,
      );

      await database.initialize();

      const columns = await database.pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'activation_authorizations'
           AND column_name = ANY($2::text[])`,
        [schemaName, ['token_suffix', 'claimed_at', 'number_acquisition_expires_at', 'result_view_until', 'end_prompt_until', 'ended_at', 'ended_reason', 'last_activity_at']],
      );
      assert.deepEqual(
        new Map(columns.rows.map((row) => [row.column_name, row.is_nullable])),
        new Map([
          ['token_suffix', 'YES'], ['claimed_at', 'YES'], ['number_acquisition_expires_at', 'YES'], ['result_view_until', 'YES'],
          ['end_prompt_until', 'YES'], ['ended_at', 'YES'], ['ended_reason', 'YES'], ['last_activity_at', 'YES'],
        ]),
      );

      const legacy = await database.pool.query<{ token_hash: string | null; recipient_session_hash: string | null; status: string }>(
        'SELECT token_hash, recipient_session_hash, status FROM activation_authorizations WHERE id = $1', [legacyAuthorizationId],
      );
      assert.deepEqual(legacy.rows[0], { token_hash: 'legacy-token-hash', recipient_session_hash: null, status: 'revoked' });
      assert.equal((await database.authorizationByTokenHash('legacy-token-hash'))?.status, 'revoked');

      const permanentId = randomUUID();
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, token_hash, token_suffix, status, created_at, claimed_at, number_acquisition_expires_at, result_view_until, end_prompt_until, ended_at, ended_reason, last_activity_at)
         VALUES ($1, 'permanent-token-hash', 'AB12_cd3', 'result_available', $2, $2, $3, $4, $5, NULL, NULL, $2)`,
        [permanentId, createdAt, new Date('2026-08-02T00:00:00.000Z'), new Date('2026-08-02T00:05:00.000Z'), new Date('2026-08-02T00:07:00.000Z')],
      );
      await database.pool.query(
        `INSERT INTO authorization_candidate_countries
           (authorization_id, position, country_id, country_name, quoted_price, quoted_stock)
         VALUES ($1, 1, 1, '美国', NULL, NULL)`,
        [permanentId],
      );
      const permanent = await database.pool.query<{
        recipient_identifier: string | null; normalized_recipient_identifier: string | null; expires_at: Date | null;
        token_suffix: string; status: string; quoted_price: string | null; quoted_stock: number | null;
      }>(
        `SELECT auth.recipient_identifier, auth.normalized_recipient_identifier, auth.expires_at, auth.token_suffix, auth.status,
                candidate.quoted_price::text, candidate.quoted_stock
         FROM activation_authorizations auth
         JOIN authorization_candidate_countries candidate ON candidate.authorization_id = auth.id
         WHERE auth.id = $1`,
        [permanentId],
      );
      assert.deepEqual(permanent.rows[0], {
        recipient_identifier: null, normalized_recipient_identifier: null, expires_at: null,
        token_suffix: 'AB12_cd3', status: 'result_available', quoted_price: null, quoted_stock: null,
      });

      await assert.rejects(
        database.pool.query(
          `INSERT INTO activation_authorizations (token_suffix, status, created_at)
           VALUES ('AB12_cd3', 'ended', $1)`,
          [createdAt],
        ),
        (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'),
      );
      await database.pool.query(
        'INSERT INTO default_candidate_countries (position, country_id) VALUES (1, 99)',
      );
      const legacyLocation = await database.pool.query<{ country_id: number; country_name: string | null }>(
        'SELECT country_id, country_name FROM default_candidate_countries WHERE position = 1',
      );
      assert.deepEqual(legacyLocation.rows[0], { country_id: 99, country_name: null });
      assert.deepEqual(await database.defaultCandidateLocations(), [
        { position: 1, countryId: 99 },
      ]);
      assert.equal(await database.completeDefaultCandidateLocations(), undefined);

      const legacyDeliveredId = randomUUID();
      const legacyReceivedAt = new Date('2026-08-10T00:03:00.000Z');
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, token_hash, status, created_at, expires_at)
         VALUES ($1, '旧短信记录', '旧短信记录', 'legacy-sms-token-hash', 'sms_delivered', $2, $3)`,
        [legacyDeliveredId, createdAt, new Date('2026-08-11T00:00:00.000Z')],
      );
      await database.pool.query(
        `INSERT INTO authorization_candidate_countries
           (authorization_id, position, country_id, country_name, quoted_price, quoted_stock)
         VALUES ($1, 1, 1, '美国', NULL, NULL)`,
        [legacyDeliveredId],
      );
      await database.pool.query(
        `INSERT INTO supplier_activations
           (authorization_id, candidate_position, country_id, provider_activation_id, status, phone_number, activation_cost, currency, acquired_at, cancel_available_at, expires_at, sms_code, sms_text, sms_received_at)
         VALUES ($1, 1, 1, $2, 'sms_delivered', '+14155550123', 0.8, 'USD', $3, $3, $4, '482913', 'legacy body', $5)`,
        [legacyDeliveredId, `legacy-sms-${randomUUID()}`, createdAt, new Date('2026-08-01T00:20:00.000Z'), legacyReceivedAt],
      );
      await database.initialize();
      const legacyDelivered = await database.pool.query<{ status: string; result_view_until: Date | null }>(
        'SELECT status, result_view_until FROM activation_authorizations WHERE id = $1', [legacyDeliveredId],
      );
      assert.equal(legacyDelivered.rows[0]?.status, 'sms_delivered');
      assert.equal(legacyDelivered.rows[0]?.result_view_until?.toISOString(), '2026-08-10T00:08:00.000Z');

      await database.initialize();
      const persisted = await database.pool.query<{ status: string; token_suffix: string; country_name: string | null }>(
        `SELECT auth.status, auth.token_suffix, candidate.country_name
         FROM activation_authorizations auth
         JOIN authorization_candidate_countries candidate ON candidate.authorization_id = auth.id
         WHERE auth.id = $1`,
        [permanentId],
      );
      assert.deepEqual(persisted.rows[0], { status: 'result_available', token_suffix: 'AB12_cd3', country_name: '美国' });
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });
}
