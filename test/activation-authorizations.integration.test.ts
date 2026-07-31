import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import type { HeroSms } from '../src/herosms.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://test.example';
const config: AppConfig = {
  adminPassword: 'correct-deployment-password', adminPath: 'control7', databaseUrl: databaseUrl ?? '',
  heroSmsApiKey: 'test-api-key', loginMaxAttempts: 3, loginWindowSeconds: 900, openAiServiceCode: 'openai',
  port: 3000, publicOrigin: origin, sessionSecret: 'test-session-secret-that-is-at-least-32-characters', trustedProxy: false,
};

function scriptedHeroSms(overrides: Partial<{ balance: number; stock: number }> = {}): HeroSms {
  return {
    balance: async () => overrides.balance ?? 10,
    services: async () => [{ code: 'openai', name: 'OpenAI' }],
    countries: async () => [{ id: 1, name: '美国' }, { id: 2, name: '英国' }, { id: 3, name: '法国' }],
    quotes: async () => [
      { countryId: 1, price: 0.8, stock: overrides.stock ?? 3 },
      { countryId: 2, price: 1.2, stock: 2 },
      { countryId: 3, price: 1.5, stock: 1 },
    ],
  };
}

type InjectionResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
function cookieValue(response: InjectionResponse, name: string): string {
  const value = response.cookies.find((cookie) => cookie.name === name)?.value;
  assert.ok(value); return value;
}
function csrfValue(body: string): string {
  const value = body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(value); return value;
}
async function login(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const page = await app.inject({ method: 'GET', url: `/${config.adminPath}` });
  const csrf = csrfValue(page.body);
  const response = await app.inject({ method: 'POST', url: `/${config.adminPath}/login`, headers: { cookie: `admin_csrf=${cookieValue(page, 'admin_csrf')}`, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: `csrf=${csrf}&password=${config.adminPassword}` });
  assert.equal(response.statusCode, 303);
  return { cookie: `admin_session=${cookieValue(response, 'admin_session')}; admin_csrf=${cookieValue(response, 'admin_csrf')}`, csrf: cookieValue(response, 'admin_csrf') };
}
async function openApplication(heroSms = scriptedHeroSms(), now?: () => Date) {
  const database = new Database(databaseUrl!);
  const app = await createApp({ ...config, sessionSecret: `${config.sessionSecret}-${randomUUID()}` }, database, { heroSms, now });
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  return { app, database };
}
async function post(app: FastifyInstance, session: { cookie: string; csrf: string }, url: string, fields: Record<string, string>) {
  return app.inject({ method: 'POST', url, headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: new URLSearchParams({ csrf: session.csrf, ...fields }).toString() });
}
async function createAuthorization(app: FastifyInstance, session: { cookie: string; csrf: string }, fields: { recipientIdentifier: string; internalNote?: string }) {
  const preview = await post(app, session, `/${config.adminPath}/authorizations/preview`, fields);
  assert.equal(preview.statusCode, 200);
  const preflightFingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(preflightFingerprint);
  return post(app, session, `/${config.adminPath}/authorizations`, { ...fields, preflightFingerprint });
}

if (!databaseUrl) {
  test('激活授权集成测试需要 TEST_DATABASE_URL', { skip: '未设置 PostgreSQL 连接字符串' }, () => {});
} else {
  test('管理员预检后创建 24 小时待领取授权，完整链接只在创建响应显示且 GET 不领取', async () => {
    const fixedNow = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => fixedNow);
    try {
      const session = await login(app);
      const recipientIdentifier = ` Alice-${randomUUID()} `;
      const preview = await post(app, session, `/${config.adminPath}/authorizations/preview`, { recipientIdentifier, internalNote: '仅管理员可见' });
      assert.equal(preview.statusCode, 200);
      assert.match(preview.body, /美国：价格 0\.8，库存 3/);
      assert.match(preview.body, /英国：价格 1\.2，库存 2/);
      assert.match(preview.body, /法国：价格 1\.5，库存 1/);

      const preflightFingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1];
      assert.ok(preflightFingerprint);
      const created = await post(app, session, `/${config.adminPath}/authorizations`, { recipientIdentifier, internalNote: '仅管理员可见', preflightFingerprint });
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token, '创建响应应显示至少 256 位随机 token');
      assert.match(created.body, /2026-08-02T00:00:00\.000Z/);

      const stored = await database.pool.query<{ token_hash: string; recipient_identifier: string }>('SELECT token_hash, recipient_identifier FROM activation_authorizations WHERE recipient_identifier = $1', [recipientIdentifier.trim()]);
      assert.equal(stored.rows.length, 1);
      assert.notEqual(stored.rows[0]?.token_hash, token);
      assert.equal(stored.rows[0]?.token_hash.length, 64);

      const firstGet = await app.inject({ method: 'GET', url: `/a/${token}` });
      const secondGet = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(firstGet.statusCode, 200);
      assert.match(firstGet.body, /获取号码（后续步骤提供）/);
      assert.equal(secondGet.statusCode, 200, '链接预览和重复 GET 不应领取授权');
      assert.equal(firstGet.headers['referrer-policy'], 'no-referrer');
      assert.match(String(firstGet.headers['x-robots-tag']), /noindex/);

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.doesNotMatch(home.body, new RegExp(token));
      assert.match(home.body, /待领取/);
    } finally { await app.close(); }
  });

  test('创建会阻止无库存、余额不足和同一标准化接收者的重复未结束授权', async () => {
    const recipientIdentifier = `Case-${randomUUID()}`;
    const first = await openApplication();
    try {
      const session = await login(first.app);
      assert.equal((await createAuthorization(first.app, session, { recipientIdentifier })).statusCode, 201);
      const duplicate = await post(first.app, session, `/${config.adminPath}/authorizations/preview`, { recipientIdentifier: `  ${recipientIdentifier.toUpperCase()}  ` });
      assert.equal(duplicate.statusCode, 422);
      assert.match(duplicate.body, /已有一条未结束激活授权/);
    } finally { await first.app.close(); }

    for (const [heroSms, message] of [[scriptedHeroSms({ stock: 0 }), /无库存/], [scriptedHeroSms({ balance: 1 }), /余额不足/]] as const) {
      const opened = await openApplication(heroSms);
      try {
        const session = await login(opened.app);
        const response = await post(opened.app, session, `/${config.adminPath}/authorizations/preview`, { recipientIdentifier: randomUUID() });
        assert.equal(response.statusCode, 422);
        assert.match(response.body, message);
      } finally { await opened.app.close(); }
    }
  });

  test('管理员撤销待领取授权后，真实链接在 24 小时内显示统一不可用，截止后返回 404', async () => {
    let now = new Date('2026-08-03T00:00:00.000Z');
    const { app } = await openApplication(scriptedHeroSms(), () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const id = (await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } })).body.match(/authorizations\/([0-9a-f-]{36})\/revoke/)?.[1]; assert.ok(id);
      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      const unavailable = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(unavailable.statusCode, 200);
      assert.match(unavailable.body, /此链接不可用，请联系发送者/);

      now = new Date('2026-08-04T00:00:00.001Z');
      const restarted = await openApplication(scriptedHeroSms(), () => now);
      try {
        const stored = await restarted.database.pool.query<{ token_hash: string | null }>('SELECT token_hash FROM activation_authorizations WHERE id = $1', [id]);
        assert.equal(stored.rows[0]?.token_hash, null, '应用重启后的到期扫描应删除已撤销授权的 token 哈希');
      } finally { await restarted.app.close(); }
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${'x'.repeat(43)}` })).statusCode, 404);
    } finally { await app.close(); }
  });
}
