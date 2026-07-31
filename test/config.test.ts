import assert from 'node:assert/strict';
import test from 'node:test';

import { readConfig } from '../src/config.js';

const environment = {
  ADMIN_PASSWORD: 'deployment-password',
  ADMIN_PATH: 'control7',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  PUBLIC_ORIGIN: 'https://test.example',
  SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
};

test('常见后台路径会被拒绝', () => {
  assert.throws(() => readConfig({ ...environment, ADMIN_PATH: 'cpanel' }), /常见后台名称/);
  assert.throws(() => readConfig({ ...environment, ADMIN_PATH: 'phpmyadmin' }), /常见后台名称/);
});

test('生产环境要求指定可信反向代理', () => {
  assert.throws(() => readConfig({ ...environment, NODE_ENV: 'production' }), /TRUSTED_PROXY/);
  assert.deepEqual(readConfig({ ...environment, NODE_ENV: 'production', TRUSTED_PROXY: '10.0.0.0/8, ::1' }).trustedProxy, ['10.0.0.0/8', '::1']);
});
