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
}
