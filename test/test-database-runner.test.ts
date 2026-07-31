import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTestDatabaseAdminUrl } from '../scripts/run-tests.js';

test('测试数据库运行器优先使用显式管理连接', () => {
  const resolved = resolveTestDatabaseAdminUrl({
    DATABASE_URL: 'postgres://ignored:ignored@example.com/application',
    TEST_DATABASE_ADMIN_URL: 'postgres://tester:secret@db.example.test/admin',
  });

  assert.equal(resolved, 'postgres://tester:secret@db.example.test/admin');
});

test('测试数据库运行器只允许隐式复用本地应用连接', () => {
  assert.equal(
    resolveTestDatabaseAdminUrl({ DATABASE_URL: 'postgres://tester:secret@127.0.0.1:5432/application' }),
    'postgres://tester:secret@127.0.0.1:5432/application',
  );
  assert.throws(
    () => resolveTestDatabaseAdminUrl({ DATABASE_URL: 'postgres://tester:secret@db.example.test/application' }),
    /拒绝使用非本地 DATABASE_URL/,
  );
});

test('测试数据库运行器缺少连接配置时明确失败', () => {
  assert.throws(() => resolveTestDatabaseAdminUrl({}), /运行完整测试需要设置 TEST_DATABASE_ADMIN_URL/);
});
