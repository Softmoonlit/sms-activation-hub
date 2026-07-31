import assert from 'node:assert/strict';
import test from 'node:test';

import { readConfig } from '../src/config.js';

const environment = {
  ADMIN_PASSWORD: 'deployment-password',
  ADMIN_PATH: 'control7',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  HEROSMS_API_KEY: 'test-hero-sms-api-key',
  HEROSMS_WEBHOOK_PATH: 'test-webhook-secret-path-1234567890',
  HEROSMS_WEBHOOK_ALLOWED_IPS: '127.0.0.1',
  OPENAI_SERVICE_CODE: 'openai',
  PUBLIC_ORIGIN: 'https://test.example',
  SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
};

test('常见后台路径会被拒绝', () => {
  assert.throws(() => readConfig({ ...environment, ADMIN_PATH: 'cpanel' }), /常见后台名称/);
  assert.throws(() => readConfig({ ...environment, ADMIN_PATH: 'phpmyadmin' }), /常见后台名称/);
});

test('OpenAI 服务代码必须是部署配置', () => {
  assert.throws(() => readConfig({ ...environment, OPENAI_SERVICE_CODE: '' }), /OPENAI_SERVICE_CODE/);
  assert.throws(() => readConfig({ ...environment, OPENAI_SERVICE_CODE: 'open-ai' }), /OPENAI_SERVICE_CODE/);
});

test('生产环境要求指定可信反向代理', () => {
  assert.throws(() => readConfig({ ...environment, NODE_ENV: 'production' }), /TRUSTED_PROXY/);
  assert.deepEqual(readConfig({ ...environment, NODE_ENV: 'production', TRUSTED_PROXY: '10.0.0.0/8, ::1' }).trustedProxy, ['10.0.0.0/8', '::1']);
});
