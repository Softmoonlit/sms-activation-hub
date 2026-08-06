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
  test('收缩迁移在存在未完结旧记录时显式拒绝，完成时把旧终态收敛到 4 种 final status 并丢弃旧字段', async () => {
    const schemaName = `contract_migration_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());
    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    const legacyRevokedId = randomUUID();
    const legacyActiveId = randomUUID();

    try {
      await database.initialize();

      // 模拟恢复旧数据库结构与限制
      await database.pool.query(`
        ALTER TABLE activation_authorizations
          ADD COLUMN IF NOT EXISTS recipient_identifier TEXT,
          ADD COLUMN IF NOT EXISTS normalized_recipient_identifier TEXT,
          ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS recipient_session_hash TEXT;
        ALTER TABLE authorization_candidate_countries
          ADD COLUMN IF NOT EXISTS quoted_price NUMERIC,
          ADD COLUMN IF NOT EXISTS quoted_stock INTEGER;
        ALTER TABLE activation_authorizations DROP CONSTRAINT IF EXISTS activation_authorizations_status_check;
        ALTER TABLE activation_authorizations ADD CONSTRAINT activation_authorizations_status_check
          CHECK (status IN ('unclaimed', 'in_progress', 'result_available', 'sms_delivered', 'quota_exhausted', 'revoked', 'expired', 'ended'));
      `);

      // 插入一条仍处于未完结状态的旧记录
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, token_hash, status, created_at, expires_at)
         VALUES ($1, '未完结记录', '未完结记录', 'active-token-hash', 'in_progress', $2, $3)`,
        [legacyActiveId, createdAt, new Date('2026-08-02T00:00:00.000Z')],
      );

      // 再次 initialize() 应当被安全护栏阻断
      await assert.rejects(
        database.initialize(),
        (error: unknown) => error instanceof Error && error.message.includes('存在未完结的旧模型激活授权，收缩迁移无法安全继续'),
      );

      // 清理未完结记录，插入已终结的 legacy revoked 记录
      await database.pool.query('DELETE FROM lifecycle_events WHERE authorization_id = $1', [legacyActiveId]);
      await database.pool.query('DELETE FROM activation_authorizations WHERE id = $1', [legacyActiveId]);
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, token_hash, recipient_session_hash, status, created_at, expires_at)
         VALUES ($1, '旧撤销记录', '旧撤销记录', 'legacy-revoked-token-hash', 'legacy-session-hash', 'revoked', $2, $3)`,
        [legacyRevokedId, createdAt, new Date('2026-08-02T00:00:00.000Z')],
      );

      // 再次执行收缩迁移，应当成功
      await database.initialize();

      // 验证收缩后的列结构：旧字段全被 DROP
      const columns = await database.pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'activation_authorizations'`,
        [schemaName],
      );
      const columnNames = new Set(columns.rows.map((row) => row.column_name));
      assert.equal(columnNames.has('recipient_identifier'), false);
      assert.equal(columnNames.has('normalized_recipient_identifier'), false);
      assert.equal(columnNames.has('expires_at'), false);
      assert.equal(columnNames.has('revoked_at'), false);
      assert.equal(columnNames.has('recipient_session_hash'), false);

      // 候选位置的领取时报价和库存快照字段一并彻底删除（ADR-0004）
      const candidateColumns = await database.pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'authorization_candidate_countries'`,
        [schemaName],
      );
      const candidateColumnNames = new Set(candidateColumns.rows.map((row) => row.column_name));
      assert.equal(candidateColumnNames.has('quoted_price'), false);
      assert.equal(candidateColumnNames.has('quoted_stock'), false);

      // 验证 legacy revoked 迁移到 ended
      const migrated = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null }>(
        'SELECT status, ended_reason, token_hash FROM activation_authorizations WHERE id = $1',
        [legacyRevokedId],
      );
      assert.deepEqual(migrated.rows[0], {
        status: 'ended',
        ended_reason: 'admin_revoked',
        token_hash: null,
      });

      // 验证可以在收缩后成功批量创建待领取授权
      const batchIds = await database.createUnclaimedAuthorizationBatch([
        { tokenHash: randomUUID(), tokenSuffix: '12345678', createdAt },
      ]);
      assert.equal(batchIds.length, 1);
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });

  test('全旧模型库从零迁移：未完结记录被护栏拒绝而非缺列崩溃，纯终态旧库完成收缩且旧状态约束不阻断', async () => {
    const schemaName = `legacy_migration_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());
    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    const legacyDeliveredId = randomUUID();
    const legacyRevokedId = randomUUID();
    const legacyExpiredId = randomUUID();

    try {
      // 手工构造真实旧库形态（claimed_at/token_suffix 等新列引入之前的部署）：
      // 无任何新模型列、旧状态约束只含 6 个旧状态（不含 ended/result_available）、
      // 另有"创建后 24 小时"有效期检查与旧未完结接收方唯一索引。
      await database.pool.query(`
        CREATE TABLE activation_authorizations (
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
        CREATE UNIQUE INDEX IF NOT EXISTS activation_authorizations_unended_recipient_idx
          ON activation_authorizations (normalized_recipient_identifier)
          WHERE normalized_recipient_identifier IS NOT NULL AND status IN ('unclaimed', 'in_progress', 'sms_delivered');
      `);

      // 旧库存在一条未完结的 sms_delivered 记录（带有效 token）
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, token_hash, status, created_at, expires_at)
         VALUES ($1, '1', '1', 'active-token-hash', 'sms_delivered', $2, $3)`,
        [legacyDeliveredId, createdAt, new Date('2026-08-02T00:00:00.000Z')],
      );

      // 应当被安全护栏显式拒绝；修复前这里会因缺列（column "claimed_at" does not exist）崩溃
      await assert.rejects(
        database.initialize(),
        (error: unknown) => error instanceof Error && error.message.includes('存在未完结的旧模型激活授权，收缩迁移无法安全继续'),
      );

      // 清理未完结记录，插入纯终态旧记录（revoked 与 expired）
      await database.pool.query('DELETE FROM activation_authorizations WHERE id = $1', [legacyDeliveredId]);
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, token_hash, status, created_at, expires_at, revoked_at)
         VALUES ($1, '1', '1', 'legacy-revoked-token-hash', 'revoked', $2, $3, $2)`,
        [legacyRevokedId, createdAt, new Date('2026-08-02T00:00:00.000Z')],
      );
      await database.pool.query(
        `INSERT INTO activation_authorizations
           (id, recipient_identifier, normalized_recipient_identifier, token_hash, status, created_at, expires_at)
         VALUES ($1, '2', '2', 'legacy-expired-token-hash', 'expired', $2, $3)`,
        [legacyExpiredId, createdAt, new Date('2026-08-02T00:00:00.000Z')],
      );

      // 收缩迁移应当成功（旧状态约束需在收敛前移除，否则 UPDATE 到 ended 会违反约束）
      await database.initialize();

      // 旧字段全被 DROP
      const columns = await database.pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'activation_authorizations'`,
        [schemaName],
      );
      const columnNames = new Set(columns.rows.map((row) => row.column_name));
      for (const legacyColumn of ['recipient_identifier', 'normalized_recipient_identifier', 'expires_at', 'revoked_at']) {
        assert.equal(columnNames.has(legacyColumn), false, `旧列 ${legacyColumn} 应被 DROP`);
      }

      // 旧记录收敛为 ended、凭据清除
      const revokedRow = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null }>(
        'SELECT status, ended_reason, token_hash FROM activation_authorizations WHERE id = $1',
        [legacyRevokedId],
      );
      assert.deepEqual(revokedRow.rows[0], {
        status: 'ended',
        ended_reason: 'admin_revoked',
        token_hash: null,
      });
      const expiredRow = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null }>(
        'SELECT status, ended_reason, token_hash FROM activation_authorizations WHERE id = $1',
        [legacyExpiredId],
      );
      assert.deepEqual(expiredRow.rows[0], {
        status: 'ended',
        ended_reason: 'acquisition_expired',
        token_hash: null,
      });

      // 新终态约束生效：ended 保留，旧状态被拒绝
      await assert.rejects(
        database.pool.query('UPDATE activation_authorizations SET status = $1 WHERE id = $2', ['sms_delivered', legacyRevokedId]),
        (error: unknown) => error instanceof Error && error.message.includes('violates check constraint'),
      );
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });

  test('旧三位置默认配置存在空洞时升级明确失败', async () => {
    const schemaName = `candidate_position_migration_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());

    try {
      await database.pool.query(`
        CREATE TABLE default_candidate_countries (
          position SMALLINT PRIMARY KEY CHECK (position BETWEEN 1 AND 3),
          country_id INTEGER NOT NULL CHECK (country_id >= 0),
          country_name TEXT NOT NULL
        );
        INSERT INTO default_candidate_countries (position, country_id, country_name)
        VALUES (1, 1, '美国'), (3, 3, '法国');
      `);

      await assert.rejects(
        database.initialize(),
        (error: unknown) => error instanceof Error
          && error.message.includes('旧默认候选位置配置必须为空或完整包含位置一至三'),
      );
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });

  test('完整旧三位置配置、已领取授权和号码历史升级后保持不变', async () => {
    const schemaName = `candidate_position_history_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());
    const authorizationId = randomUUID();
    const providerActivationId = `legacy-${randomUUID()}`;
    const createdAt = new Date('2026-08-01T00:00:00.000Z');

    try {
      await database.initialize();
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.11);
      await database.pool.query(
        `INSERT INTO activation_authorizations
          (id, token_hash, token_suffix, status, created_at, claimed_at,
           number_acquisition_expires_at, last_activity_at)
         VALUES ($1, 'legacy-token-hash', 'LEGACY01', 'in_progress', $2::timestamptz, $2::timestamptz,
                 $2::timestamptz + INTERVAL '24 hours', $2::timestamptz)`,
        [authorizationId, createdAt],
      );
      await database.pool.query(
        `INSERT INTO authorization_candidate_countries
          (authorization_id, position, country_id, country_name, used_at)
         VALUES
          ($1, 1, 1, '美国', $2),
          ($1, 2, 2, '英国', NULL),
          ($1, 3, 3, '法国', NULL)`,
        [authorizationId, createdAt],
      );
      await database.pool.query(
        `INSERT INTO supplier_activations
          (authorization_id, candidate_position, country_id, provider_activation_id,
           status, activation_cost, currency, acquired_at, cancel_available_at, expires_at)
         VALUES ($1, 1, 1, $2, 'cancelled', 0.8, 'USD', $3::timestamptz,
                 $3::timestamptz + INTERVAL '2 minutes', $3::timestamptz + INTERVAL '20 minutes')`,
        [authorizationId, providerActivationId, createdAt],
      );
      await database.pool.query(
        `INSERT INTO number_acquisition_requests
          (authorization_id, candidate_position, country_id, requested_price,
           status, error_kind, requested_at, updated_at)
         VALUES ($1, 2, 2, 1.2, 'failed', 'no-numbers', $2, $2)`,
        [authorizationId, createdAt],
      );

      await database.pool.query(`
        ALTER TABLE default_candidate_countries
          DROP CONSTRAINT default_candidate_countries_position_check,
          ADD CONSTRAINT default_candidate_countries_position_check CHECK (position BETWEEN 1 AND 3);
        ALTER TABLE authorization_candidate_countries
          DROP CONSTRAINT authorization_candidate_countries_position_check,
          ADD CONSTRAINT authorization_candidate_countries_position_check CHECK (position BETWEEN 1 AND 3);
        ALTER TABLE supplier_activations
          DROP CONSTRAINT supplier_activations_candidate_position_check,
          ADD CONSTRAINT supplier_activations_candidate_position_check CHECK (candidate_position BETWEEN 1 AND 3);
        ALTER TABLE number_acquisition_requests
          DROP CONSTRAINT number_acquisition_requests_candidate_position_check,
          ADD CONSTRAINT number_acquisition_requests_candidate_position_check CHECK (candidate_position BETWEEN 1 AND 3);
      `);

      await database.initialize();

      assert.deepEqual(await database.defaultCandidateLocations(), [
        { position: 1, countryId: 1, countryName: '美国' },
        { position: 2, countryId: 2, countryName: '英国' },
        { position: 3, countryId: 3, countryName: '法国' },
      ]);
      const history = await database.pool.query<{
        position: number; country_id: number; used: boolean;
        provider_activation_id: string | null; request_status: string | null;
      }>(
        `SELECT candidate.position, candidate.country_id, candidate.used_at IS NOT NULL AS used,
                activation.provider_activation_id, request.status AS request_status
         FROM authorization_candidate_countries candidate
         LEFT JOIN supplier_activations activation
           ON activation.authorization_id = candidate.authorization_id
          AND activation.candidate_position = candidate.position
         LEFT JOIN number_acquisition_requests request
           ON request.authorization_id = candidate.authorization_id
          AND request.candidate_position = candidate.position
         WHERE candidate.authorization_id = $1
         ORDER BY candidate.position`,
        [authorizationId],
      );
      assert.deepEqual(history.rows, [
        { position: 1, country_id: 1, used: true, provider_activation_id: providerActivationId, request_status: null },
        { position: 2, country_id: 2, used: false, provider_activation_id: null, request_status: 'failed' },
        { position: 3, country_id: 3, used: false, provider_activation_id: null, request_status: null },
      ]);
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });

  test('每号最高价配置表初始化幂等：默认值 0.11，重复启动不报错也不覆盖已保存值', async () => {
    const schemaName = `max_price_settings_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());
    try {
      await database.initialize();
      assert.equal(await database.maxPricePerNumber(), 0.11);
      await database.initialize();
      assert.equal(await database.maxPricePerNumber(), 0.11);

      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.18);
      await database.initialize();
      assert.equal(await database.maxPricePerNumber(), 0.18);
      assert.deepEqual(await database.completeDefaultCandidateLocations(), [
        { position: 1, countryId: 1, countryName: '美国' },
        { position: 2, countryId: 2, countryName: '英国' },
        { position: 3, countryId: 3, countryName: '法国' },
      ]);
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });

  test('自检确认时间列以 ADD COLUMN IF NOT EXISTS 可达：新建库与存在表两种起点均不丢失既有数据', async () => {
    const schemaName = `self_check_column_${randomUUID().replaceAll('-', '')}`;
    const adminDatabase = new Database(databaseUrl);
    await adminDatabase.pool.query(`CREATE SCHEMA ${schemaName}`);

    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
    const database = new Database(scopedUrl.toString());
    const createdAt = new Date('2026-08-01T00:00:00.000Z');
    const legacyAuthorizationId = randomUUID();

    try {
      // 起点一：全新库初始化即包含自检确认时间列。
      await database.initialize();
      const freshColumns = await database.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'activation_authorizations'`,
        [schemaName],
      );
      assert.ok(freshColumns.rows.some((row) => row.column_name === 'self_check_confirmed_at'), '新建库应包含自检确认时间列');

      // 模拟旧部署形态：存在表但缺少自检确认列，且已有业务数据。
      await database.pool.query('ALTER TABLE activation_authorizations DROP COLUMN self_check_confirmed_at');
      await database.pool.query(
        `INSERT INTO activation_authorizations
          (id, token_hash, token_suffix, status, created_at, last_activity_at)
         VALUES ($1, 'legacy-self-check-token-hash', 'SELFCH01', 'unclaimed', $2, $2)`,
        [legacyAuthorizationId, createdAt],
      );

      // 起点二：存在表重新初始化，列以 ADD COLUMN IF NOT EXISTS 补齐且既有数据不丢失。
      await database.initialize();
      const upgradedColumns = await database.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'activation_authorizations'`,
        [schemaName],
      );
      assert.ok(upgradedColumns.rows.some((row) => row.column_name === 'self_check_confirmed_at'), '存在表升级后应补齐自检确认时间列');
      const preserved = await database.pool.query<{ token_suffix: string; status: string; self_check_confirmed_at: Date | null }>(
        'SELECT token_suffix, status, self_check_confirmed_at FROM activation_authorizations WHERE id = $1',
        [legacyAuthorizationId],
      );
      assert.deepEqual(preserved.rows[0], {
        token_suffix: 'SELFCH01', status: 'unclaimed', self_check_confirmed_at: null,
      });
      await database.pool.query(
        'UPDATE activation_authorizations SET self_check_confirmed_at = $2 WHERE id = $1',
        [legacyAuthorizationId, createdAt],
      );
      const written = await database.pool.query<{ self_check_confirmed_at: Date | null }>(
        'SELECT self_check_confirmed_at FROM activation_authorizations WHERE id = $1',
        [legacyAuthorizationId],
      );
      assert.equal(written.rows[0]?.self_check_confirmed_at?.toISOString(), createdAt.toISOString());
    } finally {
      await database.close();
      await adminDatabase.pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.close();
    }
  });
}
