import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp, type AppDependencies } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import { HeroSmsResponseError, type HeroSms, type HeroSmsActivationRecord, type HeroSmsNumber } from '../src/herosms.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://test.example';
const config: AppConfig = {
  adminPassword: 'correct-deployment-password', adminPath: 'control7', databaseUrl: databaseUrl ?? '',
  heroSmsApiKey: 'test-api-key', heroSmsWebhookAllowedIps: ['127.0.0.1'], heroSmsWebhookPath: 'test-webhook-secret-path-1234567890', heroSmsWebhookRequestsPerMinute: 120,
  loginMaxAttempts: 3, loginWindowSeconds: 900, openAiServiceCode: 'openai',
  port: 3001, publicOrigin: origin, sessionSecret: 'test-session-secret-that-is-at-least-32-characters', trustedProxy: false,
};

function scriptedHeroSms(overrides: Partial<{
  balance: number | HeroSms['balance'];
  stock: number;
  services: HeroSms['services'];
  countries: HeroSms['countries'];
  quotes: HeroSms['quotes'];
  getNumber: HeroSms['getNumber'];
  activeActivations: HeroSms['activeActivations'];
  activationHistory: HeroSms['activationHistory'];
  activationStatus: HeroSms['activationStatus'];
  cancelActivation: HeroSms['cancelActivation'];
  finishActivation: HeroSms['finishActivation'];
}> = {}): HeroSms {
  const balance = overrides.balance;
  return {
    balance: typeof balance === 'function' ? balance : async () => balance ?? 10,
    services: overrides.services ?? (async () => [{ code: 'openai', name: 'OpenAI' }]),
    countries: overrides.countries ?? (async () => [{ id: 1, name: '美国' }, { id: 2, name: '英国' }, { id: 3, name: '法国' }]),
    quotes: overrides.quotes ?? (async () => [
      { countryId: 1, price: 0.8, stock: overrides.stock ?? 3 },
      { countryId: 2, price: 1.2, stock: 2 },
      { countryId: 3, price: 1.5, stock: 1 },
    ]),
    getNumber: overrides.getNumber ?? (async (_serviceCode, countryId): Promise<HeroSmsNumber> => ({
      activationId: `activation-${countryId}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
      activationTime: new Date('2026-08-01T00:00:00.000Z'), activationEndTime: new Date('2026-08-01T00:20:00.000Z'),
    })),
    activeActivations: overrides.activeActivations ?? (async () => []),
    activationHistory: overrides.activationHistory ?? (async () => []),
    activationStatus: overrides.activationStatus ?? (async () => ({ delivered: false })),
    cancelActivation: overrides.cancelActivation ?? (async () => 'cancelled'),
    finishActivation: overrides.finishActivation ?? (async () => undefined),
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
async function openApplication(heroSms = scriptedHeroSms(), now?: () => Date, extraDependencies: Omit<AppDependencies, 'heroSms' | 'now'> = {}) {
  const database = new Database(databaseUrl!);
  const app = await createApp({ ...config, sessionSecret: `${config.sessionSecret}-${randomUUID()}` }, database, { heroSms, now, ...extraDependencies });
  await database.replaceDefaultCandidateLocations([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ]);
  return { app, database };
}
async function post(app: FastifyInstance, session: { cookie: string; csrf: string }, url: string, fields: Record<string, string>) {
  return app.inject({ method: 'POST', url, headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: new URLSearchParams({ csrf: session.csrf, ...fields }).toString() });
}
async function createAuthorization(app: FastifyInstance, session: { cookie: string; csrf: string }, _fields?: { recipientIdentifier?: string; internalNote?: string }) {
  return createBatch(app, session, '1');
}

async function createBatch(app: FastifyInstance, session: { cookie: string; csrf: string }, quantity: string): Promise<InjectionResponse> {
  const preview = await post(app, session, `/${config.adminPath}/authorizations/batch/preview`, { quantity });
  const preflightFingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(preflightFingerprint);
  return post(app, session, `/${config.adminPath}/authorizations/batch`, { quantity, preflightFingerprint });
}

function authorizationIdFromHome(body: string, token: string): string {
  // 与 listArticles 共用同一卡片结构解析，避免两处正则各自漂移
  const article = listArticles(body).find((item) => item.suffix === token.slice(-8));
  assert.ok(article, `后台列表应包含链接末 8 位 ${token.slice(-8)}`);
  return article.id;
}

async function cleanupBatchAuthorizations(database: Database): Promise<void> {
  await database.transaction(async (client) => {
    const ids = await client.query<{ id: string }>(
      "SELECT id FROM activation_authorizations",
    );
    if (!ids.rowCount) return;
    const authorizationIds = ids.rows.map((row) => row.id);
    await client.query('DELETE FROM lifecycle_events WHERE authorization_id = ANY($1::uuid[])', [authorizationIds]);
    await client.query('DELETE FROM supplier_activation_refunds WHERE supplier_activation_id IN (SELECT id FROM supplier_activations WHERE authorization_id = ANY($1::uuid[]))', [authorizationIds]);
    await client.query('DELETE FROM supplier_activations WHERE authorization_id = ANY($1::uuid[])', [authorizationIds]);
    await client.query('DELETE FROM number_acquisition_candidates WHERE request_id IN (SELECT id FROM number_acquisition_requests WHERE authorization_id = ANY($1::uuid[]))', [authorizationIds]);
    await client.query('DELETE FROM number_acquisition_requests WHERE authorization_id = ANY($1::uuid[])', [authorizationIds]);
    await client.query('DELETE FROM authorization_candidate_countries WHERE authorization_id = ANY($1::uuid[])', [authorizationIds]);
    await client.query('DELETE FROM activation_authorizations WHERE id = ANY($1::uuid[])', [authorizationIds]);
  });
}

interface ListArticle { id: string; suffix: string; status: string; }
function listArticles(body: string): ListArticle[] {
  const articles: ListArticle[] = [];
  for (const match of body.matchAll(
    /<article class="authorization" data-authorization-id="([0-9a-f-]{36})"><span class="authorization-suffix">([\s\S]*?)<\/span><span class="authorization-status">([\s\S]*?)<\/span><a class="authorization-detail"[^>]*>→<\/a><\/article>/g,
  )) {
    articles.push({ id: match[1]!, suffix: match[2]!, status: match[3]! });
  }
  return articles;
}

async function resetAuthorizationTables(database: Database): Promise<void> {
  // 集成测试共享同一个隔离数据库，列表断言需要从干净状态开始。
  await database.transaction(async (client) => {
    await client.query('DELETE FROM lifecycle_events');
    await client.query('DELETE FROM supplier_activation_refunds');
    await client.query('DELETE FROM supplier_activations');
    await client.query('DELETE FROM number_acquisition_candidates');
    await client.query('DELETE FROM number_acquisition_requests');
    await client.query('DELETE FROM authorization_candidate_countries');
    await client.query('DELETE FROM activation_authorizations');
  });
}

if (!databaseUrl) {
  test('激活授权集成测试需要 TEST_DATABASE_URL', () => {
    throw new Error('未设置 TEST_DATABASE_URL；请通过 npm test 运行完整测试');
  });
} else {
  test('批量创建确认只依赖数量，生成永久待领取链接且不调用 HeroSMS', async () => {
    let providerCalls = 0;
    const heroSms = scriptedHeroSms({
      balance: async () => { providerCalls += 1; throw new Error('批量创建不应读取余额'); },
      quotes: async () => { providerCalls += 1; throw new Error('批量创建不应读取报价'); },
      services: async () => { providerCalls += 1; throw new Error('批量创建不应读取服务'); },
      countries: async () => { providerCalls += 1; throw new Error('批量创建不应读取地区'); },
    });
    let now = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const preview = await post(app, session, `/${config.adminPath}/authorizations/batch/preview`, { quantity: '10' });
      assert.equal(preview.statusCode, 200);
      assert.match(preview.body, /将创建 10 条永久待领取授权链接/);
      assert.doesNotMatch(preview.body, /接收者标识|候选地区|HeroSMS|余额|价格|库存/);
      const fingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1];
      assert.ok(fingerprint);

      const created = await post(app, session, `/${config.adminPath}/authorizations/batch`, { quantity: '10', preflightFingerprint: fingerprint });
      assert.equal(created.statusCode, 201);
      const links = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(links.length, 10);
      assert.equal((created.body.match(/复制全部/g) ?? []).length, 1);
      assert.equal((created.body.match(/复制授权链接/g) ?? []).length, 0);
      assert.equal(providerCalls, 0);

      const stored = await database.pool.query<{
        token_hash: string | null; token_suffix: string | null;
        claimed_at: Date | null; recipient_session_hash: string | null;
      }>(
        'SELECT token_hash, token_suffix, claimed_at, recipient_session_hash FROM activation_authorizations WHERE token_suffix = ANY($1::text[])',
        [links.map((link) => link.slice(-8))],
      );
      assert.equal(stored.rows.length, 10);
      assert.ok(stored.rows.every((row) => row.token_hash && row.token_suffix && row.claimed_at === null && row.recipient_session_hash === null));
      const candidates = await database.pool.query('SELECT 1 FROM authorization_candidate_countries WHERE authorization_id IN (SELECT id FROM activation_authorizations WHERE token_suffix = ANY($1::text[]))', [links.map((link) => link.slice(-8))]);
      assert.equal(candidates.rowCount, 0);

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.doesNotMatch(home.body, new RegExp(links[0]!));
      assert.match(home.body, /待领取/);

      now = new Date('2027-08-01T00:00:00.000Z');
      const oneYearLater = await app.inject({ method: 'GET', url: `/a/${links[0]}` });
      assert.equal(oneYearLater.statusCode, 200);
      assert.match(oneYearLater.body, /获取号码/);
      assert.doesNotMatch(oneYearLater.body, /领取前永久有效/);
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('批量数量只接受 1 至 50 的整数，非法确认不会写入记录', async () => {
    const { app, database } = await openApplication();
    try {
      const session = await login(app);
      const before = await database.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM activation_authorizations WHERE created_at = TIMESTAMPTZ '2026-08-01 00:00:00+00'");
      for (const quantity of ['0', '-1', '1.5', 'abc', '51', '']) {
        const preview = await post(app, session, `/${config.adminPath}/authorizations/batch/preview`, { quantity });
        assert.equal(preview.statusCode, 422, `数量 ${quantity} 应被拒绝`);
        const created = await post(app, session, `/${config.adminPath}/authorizations/batch`, { quantity });
        assert.equal(created.statusCode, 422, `数量 ${quantity} 的直接创建也应被拒绝`);
      }
      const after = await database.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM activation_authorizations WHERE created_at = TIMESTAMPTZ '2026-08-01 00:00:00+00'");
      assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    } finally { await app.close(); }
  });

  test('批量创建接受 1 和 50 两个边界数量', async () => {
    const { app, database } = await openApplication();
    try {
      const session = await login(app);
      const one = await createBatch(app, session, '1');
      assert.equal(one.statusCode, 201);
      assert.equal([...one.body.matchAll(/https:\/\/test\.example\/a\/[A-Za-z0-9_-]{43}/g)].length, 1);
      const fifty = await createBatch(app, session, '50');
      assert.equal(fifty.statusCode, 201);
      assert.equal([...fifty.body.matchAll(/https:\/\/test\.example\/a\/[A-Za-z0-9_-]{43}/g)].length, 50);
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('批量记录写入任一行失败时整批回滚', async () => {
    const { app, database } = await openApplication();
    try {
      const createdAt = new Date('2026-08-01T00:00:00.000Z');
      await assert.rejects(database.createUnclaimedAuthorizationBatch([
        { tokenHash: 'a'.repeat(64), tokenSuffix: 'ROLLBK01', createdAt },
        { tokenHash: 'a'.repeat(64), tokenSuffix: 'ROLLBK02', createdAt },
      ]));
      const stored = await database.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM activation_authorizations WHERE token_suffix IN ('ROLLBK01', 'ROLLBK02')",
      );
      assert.equal(stored.rows[0]?.count, '0');
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('末 8 位碰撞时重新生成 token，批量写入仍保持唯一', async () => {
    const collidingSuffix = 'COLLIDE1';
    const tokens = [
      `${'A'.repeat(35)}${collidingSuffix}`,
      `${'B'.repeat(35)}${collidingSuffix}`,
      `${'C'.repeat(35)}FRESH001`,
      `${'D'.repeat(35)}FRESH002`,
    ];
    let index = 0;
    const { app, database } = await openApplication(scriptedHeroSms(), undefined, {
      tokenGenerator: { generate: () => tokens[index++] ?? `${'E'.repeat(35)}FRESH003` },
    });
    try {
      const session = await login(app);
      const first = await createBatch(app, session, '1');
      assert.equal(first.statusCode, 201);
      const second = await createBatch(app, session, '2');
      assert.equal(second.statusCode, 201);
      const links = [...second.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(links.length, 2);
      assert.equal(new Set(links.map((link) => link.slice(-8))).size, 2);
      assert.equal(index, 4, '碰撞应只重新生成发生碰撞的 token');
      const collisionRows = await database.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM activation_authorizations WHERE token_suffix = $1', [collidingSuffix]);
      assert.equal(collisionRows.rows[0]?.count, '1');
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('批量链接 GET 不领取，首次 POST 原子绑定并固定完整候选配置', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    let quoteCalls = 0;
    const heroSms = scriptedHeroSms({
      quotes: async () => {
        quoteCalls += 1;
        throw new Error('领取后实时查询暂时失败');
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 1, countryName: '美国' },
      ]);
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);

      const preview = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(preview.statusCode, 200);
      assert.match(preview.body, /<h1>OpenAI<\/h1>/);
      assert.match(preview.body, /获取号码/);
      assert.doesNotMatch(preview.body, /链接剩余时间|候选地区|价格|库存|HeroSMS|供应商|期限|授权/);

      const claim = await app.inject({ method: 'POST', url: `/a/${token}` + '/numbers', headers: { cookie: 'recipient_session=stale-client-value' } });
      assert.equal(claim.statusCode, 503);
      assert.match(claim.body, /暂时无法获取号码，请联系发送者/);
      assert.match(claim.body, /链接剩余时间/);
      assert.doesNotMatch(claim.body, /授权/);
      const recipientCookie = cookieValue(claim, 'recipient_session');
      assert.notEqual(recipientCookie, 'stale-client-value');
      assert.match(String(claim.headers['set-cookie']), /Max-Age=90000/);
      assert.match(String(claim.headers['set-cookie']), /HttpOnly; Secure; SameSite=Strict/);
      assert.match(String(claim.headers['set-cookie']), new RegExp(`Path=\\/a\\/${token}`));

      const authorization = await database.pool.query<{
        status: string; claimed_at: Date | null; number_acquisition_expires_at: Date | null;
        recipient_session_hash: string | null;
      }>(
        'SELECT status, claimed_at, number_acquisition_expires_at, recipient_session_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.equal(authorization.rows.length, 1);
      assert.equal(authorization.rows[0]?.status, 'in_progress');
      assert.equal(authorization.rows[0]?.claimed_at?.toISOString(), now.toISOString());
      assert.equal(authorization.rows[0]?.number_acquisition_expires_at?.toISOString(), new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());
      assert.ok(authorization.rows[0]?.recipient_session_hash);

      const candidates = await database.pool.query<{
        position: number; country_id: number; country_name: string; used_at: Date | null;
      }>(
        `SELECT position, country_id, country_name, used_at
         FROM authorization_candidate_countries
         WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)
         ORDER BY position`,
        [token.slice(-8)],
      );
      assert.deepEqual(candidates.rows, [
        { position: 1, country_id: 1, country_name: '美国', used_at: null },
        { position: 2, country_id: 2, country_name: '英国', used_at: null },
        { position: 3, country_id: 1, country_name: '美国', used_at: null },
      ]);

      await database.replaceDefaultCandidateLocations([
        { countryId: 3, countryName: '法国' },
        { countryId: 3, countryName: '法国' },
        { countryId: 2, countryName: '英国' },
      ]);
      now = new Date('2026-08-01T01:00:00.000Z');
      const retry = await app.inject({
        method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: `recipient_session=${recipientCookie}` },
      });
      assert.equal(retry.statusCode, 503);
      assert.equal((retry.cookies.find((cookie) => cookie.name === 'recipient_session')?.value), undefined, '后续访问不能重新设置 Cookie');
      assert.equal(quoteCalls, 2);
      const lostCookiePost = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(lostCookiePost.statusCode, 409);
      assert.match(lostCookiePost.body, /此链接已被领取，当前浏览器无法访问，请联系发送者/);
      assert.equal(lostCookiePost.cookies.find((cookie) => cookie.name === 'recipient_session'), undefined);
      const retained = await database.pool.query<{ country_id: number; country_name: string }>(
        `SELECT country_id, country_name FROM authorization_candidate_countries
         WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1) ORDER BY position`,
        [token.slice(-8)],
      );
      assert.deepEqual(retained.rows, [
        { country_id: 1, country_name: '美国' },
        { country_id: 2, country_name: '英国' },
        { country_id: 1, country_name: '美国' },
      ]);

      now = new Date('2026-08-02T00:00:00.000Z');
      const expired = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: `recipient_session=${recipientCookie}` } });
      assert.equal(expired.statusCode, 404);
      const expiredAuthorization = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null; recipient_session_hash: string | null }>(
        'SELECT status, ended_reason, token_hash, recipient_session_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.deepEqual(expiredAuthorization.rows[0], { status: 'ended', ended_reason: 'acquisition_expired', token_hash: null, recipient_session_hash: null });
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('默认候选配置不完整时领取整体回滚并保留待领取链接', async () => {
    let now = new Date('2026-08-02T00:00:00.000Z');
    let providerCalls = 0;
    const heroSms = scriptedHeroSms({
      balance: async () => { providerCalls += 1; return 10; },
      services: async () => { providerCalls += 1; return [{ code: 'openai', name: 'OpenAI' }]; },
      countries: async () => { providerCalls += 1; return [{ id: 1, name: '美国' }]; },
      quotes: async () => { providerCalls += 1; return [
        { countryId: 1, price: 0.8, stock: 1 },
        { countryId: 2, price: 1.2, stock: 1 },
        { countryId: 3, price: 1.5, stock: 1 },
      ]; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      // 旧配置只有两个候选位置，视为不完整配置
      await database.pool.query('DELETE FROM default_candidate_countries WHERE position = 3');
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);
      const claim = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claim.statusCode, 503);
      assert.match(claim.body, /暂时无法获取号码，请联系发送者/);
      assert.equal(claim.cookies.find((cookie) => cookie.name === 'recipient_session'), undefined);
      assert.equal(providerCalls, 0, '领取配置校验失败时不应调用 HeroSMS');

      const authorization = await database.pool.query<{
        status: string; claimed_at: Date | null; number_acquisition_expires_at: Date | null; recipient_session_hash: string | null;
      }>(
        'SELECT status, claimed_at, number_acquisition_expires_at, recipient_session_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.deepEqual(authorization.rows[0], {
        status: 'unclaimed', claimed_at: null, number_acquisition_expires_at: null, recipient_session_hash: null,
      });
      const candidates = await database.pool.query(
        'SELECT 1 FROM authorization_candidate_countries WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)',
        [token.slice(-8)],
      );
      assert.equal(candidates.rowCount, 0);

      const stillAvailable = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(stillAvailable.statusCode, 200);
      assert.match(stillAvailable.body, /OpenAI/);
      assert.match(stillAvailable.body, /获取号码/);

      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ]);
      now = new Date('2026-08-02T00:01:00.000Z');
      const repaired = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(repaired.statusCode, 303);
      assert.ok(repaired.cookies.find((cookie) => cookie.name === 'recipient_session'));
      assert.equal(providerCalls, 1);
      const afterRepair = await database.pool.query<{ status: string; country_name: string }>(
        `SELECT auth.status, candidate.country_name
         FROM activation_authorizations auth
         JOIN authorization_candidate_countries candidate ON candidate.authorization_id = auth.id
         WHERE auth.token_suffix = $1 ORDER BY candidate.position`,
        [token.slice(-8)],
      );
      assert.deepEqual(afterRepair.rows, [
        { status: 'in_progress', country_name: '美国' },
        { status: 'in_progress', country_name: '英国' },
        { status: 'in_progress', country_name: '法国' },
      ]);
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('同一链接并发领取只绑定一个浏览器且竞争者不能访问', async () => {
    let now = new Date('2026-08-03T00:00:00.000Z');
    const heroSms = scriptedHeroSms();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ]);
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);

      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: `/a/${token}/numbers` }),
        app.inject({ method: 'POST', url: `/a/${token}/numbers` }),
      ]);
      const responses = [first, second];
      assert.equal(responses.filter((response) => response.statusCode === 303).length, 1);
      assert.equal(responses.filter((response) => response.statusCode === 409).length, 1);
      const unavailable = responses.find((response) => response.statusCode === 409);
      assert.ok(unavailable);
      assert.match(unavailable.body, /此链接已被领取，当前浏览器无法访问，请联系发送者/);
      const bound = responses.find((response) => response.statusCode === 303);
      assert.ok(bound);
      assert.ok(bound.cookies.find((cookie) => cookie.name === 'recipient_session'));
      const boundCookie = cookieValue(bound, 'recipient_session');
      const boundPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: `recipient_session=${boundCookie}` } });
      assert.equal(boundPage.statusCode, 200);
      assert.match(boundPage.body, /链接剩余时间/);
      assert.doesNotMatch(boundPage.body, /授权/);

      const authorization = await database.pool.query<{
        status: string; claimed_at: Date | null; number_acquisition_expires_at: Date | null; recipient_session_hash: string | null;
      }>(
        'SELECT status, claimed_at, number_acquisition_expires_at, recipient_session_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.deepEqual({
        status: authorization.rows[0]?.status,
        claimed_at: authorization.rows[0]?.claimed_at,
        number_acquisition_expires_at: authorization.rows[0]?.number_acquisition_expires_at,
        hasSession: Boolean(authorization.rows[0]?.recipient_session_hash),
      }, {
        status: 'in_progress', claimed_at: now,
        number_acquisition_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000), hasSession: true,
      });
      const candidates = await database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM authorization_candidate_countries WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)',
        [token.slice(-8)],
      );
      assert.equal(candidates.rows[0]?.count, '3');
      const activations = await database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM supplier_activations WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)',
        [token.slice(-8)],
      );
      assert.equal(activations.rows[0]?.count, '1');

      const competingGet = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(competingGet.statusCode, 200);
      assert.match(competingGet.body, /此链接已被领取，当前浏览器无法访问，请联系发送者/);
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('待领取详情只展示短标识和生命周期，撤销后 token 立即返回 404', async () => {
    const fixedNow = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => fixedNow);
    try {
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);
      const suffix = token.slice(-8);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, new RegExp(`链接末 8 位：${suffix}`));
      assert.match(detail.body, /待领取/);
      assert.match(detail.body, /创建时间/);
      assert.doesNotMatch(detail.body, /获取额度|候选地区|供应商激活|成本/);

      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。/);
      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      const repeated = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(repeated.statusCode, 409);
      const stored = await database.pool.query<{
        token_hash: string | null; recipient_session_hash: string | null; status: string; ended_reason: string | null;
        candidate_count: string;
      }>(
        `SELECT auth.token_hash, auth.recipient_session_hash, auth.status, auth.ended_reason,
                (SELECT count(*)::text FROM authorization_candidate_countries candidate WHERE candidate.authorization_id = auth.id) AS candidate_count
         FROM activation_authorizations auth WHERE auth.id = $1`, [id],
      );
      assert.deepEqual(stored.rows[0], { token_hash: null, recipient_session_hash: null, status: 'ended', ended_reason: 'admin_revoked', candidate_count: '0' });
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('批量创建 24 小时领取授权，完整链接只在创建响应显示且 GET 不领取', async () => {
    const fixedNow = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => fixedNow);
    try {
      const session = await login(app);
      const preview = await post(app, session, `/${config.adminPath}/authorizations/batch/preview`, { quantity: '1' });
      assert.equal(preview.statusCode, 200);
      assert.match(preview.body, /将创建 1 条永久待领取授权链接。/);

      const preflightFingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1];
      assert.ok(preflightFingerprint);
      const created = await post(app, session, `/${config.adminPath}/authorizations/batch`, { quantity: '1', preflightFingerprint });
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token, '创建响应应显示至少 256 位随机 token');
      assert.doesNotMatch(created.body, /到期时间/);

      const stored = await database.pool.query<{ token_hash: string; token_suffix: string; created_at: Date }>(
        'SELECT token_hash, token_suffix, created_at FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.equal(stored.rows.length, 1);
      assert.notEqual(stored.rows[0]?.token_hash, token);
      assert.equal(stored.rows[0]?.token_hash.length, 64);
      assert.equal(stored.rows[0]?.token_suffix, token.slice(-8));
      assert.equal(stored.rows[0]?.created_at.toISOString(), fixedNow.toISOString());

      const firstGet = await app.inject({ method: 'GET', url: `/a/${token}` });
      const secondGet = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(firstGet.statusCode, 200);
      assert.match(firstGet.body, /获取号码/);
      assert.equal(secondGet.statusCode, 200, '链接预览和重复 GET 不应领取授权');
      assert.equal(firstGet.headers['referrer-policy'], 'no-referrer');
      assert.match(String(firstGet.headers['x-robots-tag']), /noindex/);

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.doesNotMatch(home.body, new RegExp(token));
      assert.match(home.body, /待领取/);
    } finally { await app.close(); }
  });

  test('管理员可以用三个相同候选地区创建激活授权', async () => {
    const { app, database } = await openApplication();
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ]);
      const session = await login(app);
      const created = await createAuthorization(app, session);

      assert.equal(created.statusCode, 201);
      assert.match(created.body, /\/a\/[A-Za-z0-9_-]{43}/);
    } finally { await app.close(); }
  });

  test('三个相同候选地区按位置依次消费且后台成本不重复', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationIds = [0, 1, 2].map(() => `duplicate-country-${randomUUID()}`);
    const acquiredCountries: number[] = [];
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        const activationId = activationIds[acquiredCountries.length]; assert.ok(activationId);
        acquiredCountries.push(countryId);
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ]);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      for (const minute of [2, 4]) {
        now = new Date(`2026-08-01T00:0${minute}:00.000Z`);
        const replaced: InjectionResponse = await app.inject({
          method: 'POST', url: `/a/${token}/replacement/confirm`,
          headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'replacement=confirm',
        });
        assert.equal(replaced.statusCode, 303);
      }

      assert.deepEqual(acquiredCountries, [1, 1, 1]);
      const recipientPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(recipientPage.body, /剩余可用号码次数：0/);
      assert.doesNotMatch(recipientPage.body, /更换号码/);

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      for (const activationId of activationIds) {
        assert.equal((detail.body.match(new RegExp(activationId, 'g')) ?? []).length, 1);
      }
      assert.match(detail.body, /累计激活费用：2\.40 USD/);
    } finally { await app.close(); }
  });

  test('批量创建不调用 HeroSMS，供应商故障也不阻止补充链接库存', async () => {
    let providerCalls = 0;
    const heroSms = scriptedHeroSms({
      balance: async () => { providerCalls += 1; throw new Error('余额查询失败'); },
      services: async () => { providerCalls += 1; throw new Error('服务查询失败'); },
      countries: async () => { providerCalls += 1; throw new Error('地区查询失败'); },
      quotes: async () => { providerCalls += 1; throw new Error('报价查询失败'); },
    });
    const opened = await openApplication(heroSms);
    try {
      const session = await login(opened.app);
      const created = await createBatch(opened.app, session, '2');
      assert.equal(created.statusCode, 201);
      assert.equal(providerCalls, 0, '批量创建不应调用 HeroSMS');
      const links = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g) ?? [];
      assert.equal(links.length, 2);
    } finally { await opened.app.close(); }

    for (const heroSms of [scriptedHeroSms({ stock: 0 }), scriptedHeroSms({ balance: 1 })]) {
      const opened = await openApplication(heroSms);
      try {
        const session = await login(opened.app);
        // 无库存或余额不足只影响领取后的号码获取，不阻止补充待领取链接库存
        const response = await createBatch(opened.app, session, '1');
        assert.equal(response.statusCode, 201);
        assert.match(response.body, /\/a\/[A-Za-z0-9_-]{43}/);
      } finally { await opened.app.close(); }
    }
  });

  test('首次领取按候选位置顺序尝试，明确无库存失败不消耗位置并可由绑定浏览器恢复', async () => {
    const fixedNow = new Date('2026-08-01T00:00:00.000Z');
    const attemptedCountries: number[] = [];
    const activationId = `act-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      quotes: async () => [
        { countryId: 1, price: 1.3, stock: 2 },
        { countryId: 2, price: 0.4, stock: 1 },
        { countryId: 3, price: 0.9, stock: 3 },
      ],
      getNumber: async (_serviceCode, countryId) => {
        attemptedCountries.push(countryId);
        if (countryId === 1) throw new HeroSmsResponseError('no-numbers');
        return {
          activationId, phoneNumber: '+442079460123', activationCost: 0.9, currency: 'USD',
          activationTime: fixedNow, activationEndTime: new Date('2026-08-01T00:20:00.000Z'),
        };
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      const initial = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(initial.body, /OpenAI/);
      assert.match(initial.body, /获取号码/);
      assert.doesNotMatch(initial.body, /美国|英国|法国|HeroSMS|价格|库存/);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      assert.deepEqual(attemptedCountries, [1, 2], '应按候选位置顺序尝试，不能按实时价格排序');
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      const numberPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(numberPage.statusCode, 200);
      assert.match(numberPage.body, /英国|\+44 20 7946 0123/);
      assert.match(numberPage.body, /data-copy-value="\+442079460123"/);
      assert.match(numberPage.body, /授权剩余时间|号码有效至|可换号时间|剩余可用号码次数：2/);
      assert.doesNotMatch(numberPage.body, new RegExp(`${activationId}|HeroSMS|价格|库存`));

      const lostCookie = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(lostCookie.body, /此链接已被领取，当前浏览器无法访问，请联系发送者/);
      const cannotRebind = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(cannotRebind.statusCode, 409);
      assert.match(cannotRebind.body, /此链接已被领取，当前浏览器无法访问，请联系发送者/);

      const stored = await database.pool.query<{ used_at: Date | null }>(
        `SELECT candidate.used_at FROM authorization_candidate_countries candidate
         WHERE candidate.authorization_id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)
         ORDER BY candidate.position`,
        [activationId],
      );
      assert.deepEqual(stored.rows.map((row) => row.used_at !== null), [false, true, false], '只有成功取得号码的地区才被消耗');
    } finally { await app.close(); }
  });

  test('首次与后继号码获取按相同候选位置顺序尝试并规范化供应商时间', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const attemptedCountries: number[] = [];
    let acquiredCount = 0;
    const heroSms = scriptedHeroSms({
      quotes: async () => [
        { countryId: 1, price: 1.3, stock: 2 },
        { countryId: 2, price: 0.4, stock: 1 },
        { countryId: 3, price: 0.9, stock: 3 },
      ],
      getNumber: async (_serviceCode, countryId) => {
        attemptedCountries.push(countryId);
        if (countryId === 2) throw new HeroSmsResponseError('no-numbers');
        acquiredCount += 1;
        return {
          activationId: `shared-flow-${acquiredCount}-${randomUUID()}`,
          phoneNumber: acquiredCount === 1 ? '+14155550123' : '+442079460123',
          activationCost: 0.8, currency: 'USD',
          activationTime: now,
          activationEndTime: new Date(now.getTime() - 1_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 303);
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      const firstPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(firstPage.body, /data-countdown="2026-08-01T00:20:00.000Z"/);

      now = new Date('2026-08-01T00:02:00.000Z');
      const replacement = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacement.statusCode, 303);
      assert.deepEqual(attemptedCountries, [1, 2, 3]);

      const replacementPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(replacementPage.body, /data-countdown="2026-08-01T00:22:00.000Z"/);
    } finally { await app.close(); }
  });

  test('后继号码获取结果不确定时复用同一对账流程且确认前不重复获取', async () => {
    let now = new Date('2026-08-01T06:00:00.000Z');
    const firstActivationId = `shared-uncertain-first-${randomUUID()}`;
    const replacementActivationId = `shared-uncertain-replacement-${randomUUID()}`;
    let getNumberCalls = 0;
    let reconciliationAvailable = false;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 1) {
          return {
            activationId: firstActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
            activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
          };
        }
        throw new HeroSmsResponseError('uncertain');
      },
      activeActivations: async () => {
        if (!reconciliationAvailable) throw new HeroSmsResponseError('provider');
        return [{
          activationId: replacementActivationId, phoneNumber: '+442079460124', activationCost: 0.8, currency: 'USD',
          serviceCode: 'openai', countryId: 2, activationTime: new Date('2026-08-01T06:02:00.000Z'), status: '1',
        }];
      },
      activationHistory: async () => [],
      cancelActivation: async (activationId) => {
        assert.equal(activationId, firstActivationId);
        return 'cancelled';
      },
    });
    const opened = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const first = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-01T06:02:00.000Z');
      const confirming = await opened.app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(confirming.statusCode, 202);
      assert.match(confirming.body, /正在确认号码获取结果，请稍候/);
      assert.equal(getNumberCalls, 2);

      const retry = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: recipientCookie } });
      assert.equal(retry.statusCode, 202);
      assert.equal(getNumberCalls, 2, '结果确认前重试不得再次调用供应商');
    } finally { await opened.app.close(); }

    reconciliationAvailable = true;
    const restarted = await openApplication(heroSms, () => now);
    try {
      const recovered = await restarted.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(recovered.body, /\+44 20 7946 0124/);
      assert.equal(getNumberCalls, 2);
    } finally { await restarted.app.close(); }
  });

  test('首次获取在报价查询期间并发撤销时返回不可用而不是 404', async () => {
    let blockQuotes = false;
    let resolveQuotesStarted!: () => void;
    const quotesStarted = new Promise<void>((resolve) => { resolveQuotesStarted = resolve; });
    let releaseQuotes: (() => void) | undefined;
    const quotesReleased = new Promise<void>((resolve) => { releaseQuotes = resolve; });
    const heroSms = scriptedHeroSms({
      quotes: async () => {
        if (blockQuotes) {
          resolveQuotesStarted();
          await quotesReleased;
        }
        return [
          { countryId: 1, price: 0.8, stock: 3 },
          { countryId: 2, price: 1.2, stock: 2 },
          { countryId: 3, price: 1.5, stock: 1 },
        ];
      },
    });
    const { app } = await openApplication(heroSms);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      blockQuotes = true;
      const claim = app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      await quotesStarted;

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${authorizationId}/revoke`, {})).statusCode, 303);

      releaseQuotes?.();
      const result = await claim;
      assert.equal(result.statusCode, 409);
      assert.match(result.body, /此链接不可用，请联系发送者/);
    } finally {
      releaseQuotes?.();
      await app.close();
    }
  });

  test('PostgreSQL 全局串行号码获取，并在调用前重新检查授权期限', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const activationPrefix = randomUUID();
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        calls += 1; activeCalls += 1; maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        if (calls === 1) await firstBlocked;
        activeCalls -= 1;
        return { activationId: `${activationPrefix}-${calls}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
    });
    const opened = await openApplication(heroSms, () => now);
    try {
      const session = await login(opened.app);
      const first = await createAuthorization(opened.app, session);
      const second = await createAuthorization(opened.app, session);
      const firstToken = first.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(firstToken);
      const secondToken = second.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(secondToken);
      const firstClaim = opened.app.inject({ method: 'POST', url: `/a/${firstToken}/numbers` });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const secondClaim = opened.app.inject({ method: 'POST', url: `/a/${secondToken}/numbers` });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls, 1, '第二个请求应等待 PostgreSQL 全局锁');
      releaseFirst();
      assert.equal((await firstClaim).statusCode, 303);
      assert.equal((await secondClaim).statusCode, 303);
      assert.equal(maximumActiveCalls, 1);

      const third = await createAuthorization(opened.app, session);
      const thirdToken = third.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(thirdToken);
      // 待领取链接永久有效：跨过创建时间仍可领取，领取前不开始 24 小时计时
      now = new Date('2026-08-02T00:00:00.001Z');
      assert.equal((await opened.app.inject({ method: 'POST', url: `/a/${thirdToken}/numbers` })).statusCode, 303);
      assert.equal(calls, 3);
      // 领取后 24 小时截止：截止后不得调用 HeroSMS
      now = new Date('2026-08-03T00:00:00.002Z');
      assert.equal((await opened.app.inject({ method: 'POST', url: `/a/${thirdToken}/numbers` })).statusCode, 404);
      assert.equal(calls, 3, '截止后不得调用 HeroSMS');
    } finally { await opened.app.close(); }
  });

  test('三个候选地区均明确无库存时保留全部地区和获取额度', async () => {
    const fixedNow = new Date('2026-08-04T12:00:00.000Z');
    let inventoryAvailable = true;
    const attemptedCountries: number[] = [];
    const heroSms = scriptedHeroSms({
      quotes: async () => inventoryAvailable ? [
        { countryId: 1, price: 0.8, stock: 3 },
        { countryId: 2, price: 1.2, stock: 2 },
        { countryId: 3, price: 1.5, stock: 1 },
      ] : [
        { countryId: 1, price: 0.8, stock: 0 },
        { countryId: 2, price: 1.2, stock: 0 },
        { countryId: 3, price: 1.5, stock: 0 },
      ],
      getNumber: async (_serviceCode, countryId) => {
        attemptedCountries.push(countryId);
        throw new Error('报价库存为零时不应调用号码获取');
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      inventoryAvailable = false;
      const response = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(response.statusCode, 409);
      assert.match(response.body, /当前暂无可用号码，请稍后重试/);
      assert.match(response.body, /获取号码/);
      assert.doesNotMatch(response.body, /请联系发送者/);
      assert.deepEqual(attemptedCountries, []);
      const candidates = await database.pool.query<{ used_at: Date | null }>(
        `SELECT candidate.used_at FROM authorization_candidate_countries candidate
         JOIN activation_authorizations auth ON auth.id = candidate.authorization_id
         WHERE auth.token_suffix = $1 ORDER BY candidate.position`,
        [token.slice(-8)],
      );
      assert.deepEqual(candidates.rows.map((candidate) => candidate.used_at), [null, null, null]);
    } finally { await app.close(); }
  });

  test('无库存位置不消耗额度，库存恢复后下一次仍按原始位置优先', async () => {
    const fixedNow = new Date('2026-08-04T18:00:00.000Z');
    let inventory: 'available' | 'empty' | 'recovered' = 'available';
    const attemptedCountries: number[] = [];
    const activationId = `recovered-stock-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      quotes: async () => inventory === 'available' ? [
        { countryId: 1, price: 1.3, stock: 2 },
        { countryId: 2, price: 0.4, stock: 1 },
        { countryId: 3, price: 0.9, stock: 1 },
      ] : inventory === 'empty' ? [
        { countryId: 1, price: 1.3, stock: 0 },
        { countryId: 2, price: 0.4, stock: 0 },
        { countryId: 3, price: 0.9, stock: 0 },
      ] : [
        { countryId: 1, price: 1.3, stock: 1 },
        { countryId: 2, price: 0.4, stock: 1 },
        { countryId: 3, price: 0.9, stock: 0 },
      ],
      getNumber: async (_serviceCode, countryId) => {
        attemptedCountries.push(countryId);
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: fixedNow, activationEndTime: new Date(fixedNow.getTime() + 1_200_000),
        };
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      inventory = 'empty';
      const unavailable = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(unavailable.statusCode, 409);
      assert.match(unavailable.body, /当前暂无可用号码，请稍后重试/);
      const recipientCookie = `recipient_session=${cookieValue(unavailable, 'recipient_session')}`;

      inventory = 'recovered';
      const recovered = await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: recipientCookie } });
      assert.equal(recovered.statusCode, 303);
      assert.deepEqual(attemptedCountries, [1]);

      const candidates = await database.pool.query<{ used_at: Date | null }>(
        `SELECT candidate.used_at FROM authorization_candidate_countries candidate
         JOIN activation_authorizations auth ON auth.id = candidate.authorization_id
         WHERE auth.token_suffix = $1 ORDER BY candidate.position`,
        [token.slice(-8)],
      );
      assert.deepEqual(candidates.rows.map((candidate) => candidate.used_at !== null), [true, false, false]);
    } finally { await app.close(); }
  });

  test('报价缺失属于可重试的获取错误而不是无库存', async () => {
    const fixedNow = new Date('2026-08-05T12:00:00.000Z');
    let configurationReady = true;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      quotes: async () => configurationReady ? [
        { countryId: 1, price: 0.8, stock: 3 },
        { countryId: 2, price: 1.2, stock: 2 },
        { countryId: 3, price: 1.5, stock: 1 },
      ] : [
        { countryId: 2, price: 1.2, stock: 2 },
        { countryId: 3, price: 1.5, stock: 1 },
      ],
      getNumber: async () => {
        getNumberCalls += 1;
        return { activationId: `quote-retry-${randomUUID()}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: fixedNow };
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      configurationReady = false;
      const failed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(failed.statusCode, 503);
      assert.match(failed.body, /暂时无法获取号码，请联系发送者/);
      assert.doesNotMatch(failed.body, /当前暂无可用号码/);
      assert.equal(getNumberCalls, 0);
      const unused = await database.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM authorization_candidate_countries
         WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)
           AND used_at IS NOT NULL`,
        [token.slice(-8)],
      );
      assert.equal(unused.rows[0]?.count, '0');

      configurationReady = true;
      const retried = await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: `recipient_session=${cookieValue(failed, 'recipient_session')}` } });
      assert.equal(retried.statusCode, 303);
      assert.equal(getNumberCalls, 1);
    } finally { await app.close(); }
  });

  test('明确获取失败不消耗地区或额度，管理员处理后可由原绑定浏览器重试', async () => {
    const fixedNow = new Date('2026-08-05T00:00:00.000Z');
    const definiteKinds = ['balance', 'authentication', 'account', 'request', 'rate-limit', 'provider'] as const;
    let failureKind: typeof definiteKinds[number] | undefined = definiteKinds[0];
    let activationSequence = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        if (failureKind) throw new HeroSmsResponseError(failureKind);
        activationSequence += 1;
        return { activationId: `recovered-${activationSequence}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: fixedNow };
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      for (const kind of definiteKinds) {
        failureKind = kind;
        const created = await createAuthorization(app, session);
        const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
        const failed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        assert.equal(failed.statusCode, 503);
        assert.match(failed.body, /暂时无法获取号码，请联系发送者/);
        const recipientCookie = `recipient_session=${cookieValue(failed, 'recipient_session')}`;
        const unused = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM authorization_candidate_countries
           WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)
             AND used_at IS NOT NULL`,
          [token.slice(-8)],
        );
        assert.equal(unused.rows[0]?.count, '0');

        failureKind = undefined;
        const retried = await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: recipientCookie } });
        assert.equal(retried.statusCode, 303, `管理员处理 ${kind} 后应可重试`);
      }
    } finally { await app.close(); }
  });

  test('响应丢失后自动从活动激活与历史唯一恢复，不重复调用号码获取', async () => {
    const fixedNow = new Date('2026-08-06T00:00:00.000Z');
    let getNumberCalls = 0;
    const recovered: HeroSmsActivationRecord = {
      activationId: `lost-${randomUUID()}`, phoneNumber: '+442079460123', activationCost: 0.9,
      currency: 'USD', serviceCode: 'openai', countryId: 1, activationTime: fixedNow, status: '1',
    };
    const heroSms = scriptedHeroSms({
      getNumber: async () => { getNumberCalls += 1; throw new HeroSmsResponseError('uncertain'); },
      activeActivations: async () => [recovered],
      activationHistory: async () => [],
    });
    const { app } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /\+44 20 7946 0123/);
      assert.equal(getNumberCalls, 1, '对账必须恢复原请求，不得盲目重试');
    } finally { await app.close(); }
  });

  test('无法唯一归属时全局暂停，管理员可关联候选或确认未产生激活并解除暂停', async () => {
    const fixedNow = new Date('2026-08-07T00:00:00.000Z');
    let mode: 'uncertain' | 'success' = 'uncertain';
    let getNumberCalls = 0;
    const candidates: HeroSmsActivationRecord[] = [1, 2, 3].map((suffix) => ({
      activationId: `ambiguous-${suffix}-${randomUUID()}`, phoneNumber: `+1415555012${suffix}`,
      activationCost: 0.8, currency: 'USD', serviceCode: 'openai', countryId: 1,
      activationTime: fixedNow, status: '1',
    }));
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (mode === 'uncertain') throw new HeroSmsResponseError('uncertain');
        return { activationId: `after-review-${randomUUID()}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: fixedNow };
      },
      activeActivations: async () => candidates,
      activationHistory: async () => [],
    });
    const { app } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const first = await createAuthorization(app, session);
      const second = await createAuthorization(app, session);
      const firstToken = first.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(firstToken);
      const secondToken = second.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(secondToken);
      const uncertain = await app.inject({ method: 'POST', url: `/a/${firstToken}/numbers` });
      assert.equal(uncertain.statusCode, 202);
      assert.match(uncertain.body, /号码状态待发送者处理/);
      const firstCookie = `recipient_session=${cookieValue(uncertain, 'recipient_session')}`;

      const paused = await app.inject({ method: 'POST', url: `/a/${secondToken}/numbers` });
      assert.equal(paused.statusCode, 503);
      assert.equal(getNumberCalls, 1, '人工对账期间不得开始其他号码获取');

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.match(home.body, /结果待人工对账/);
      const link = home.body.match(/action="(\/control7\/acquisition-requests\/[0-9a-f-]{36}\/candidates\/[^"/]+\/link)"/)?.[1]; assert.ok(link);
      const linked = await post(app, session, link, {});
      assert.equal(linked.statusCode, 303);
      const recoveredPage = await app.inject({ method: 'GET', url: `/a/${firstToken}`, headers: { cookie: firstCookie } });
      assert.match(recoveredPage.body, /\+1 415 555 0121/, '人工关联后应恢复号码和激活状态');

      const secondCookie = `recipient_session=${cookieValue(paused, 'recipient_session')}`;
      const secondUncertain = await app.inject({ method: 'POST', url: `/a/${secondToken}/numbers`, headers: { cookie: secondCookie } });
      assert.equal(secondUncertain.statusCode, 202, '人工关联后全局队列应恢复');
      const secondHome = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const requestId = secondHome.body.match(/acquisition-requests\/([0-9a-f-]{36})\/confirm-absent/)?.[1]; assert.ok(requestId);
      const confirmed = await post(app, session, `/${config.adminPath}/acquisition-requests/${requestId}/confirm-absent`, {});
      assert.equal(confirmed.statusCode, 303);

      mode = 'success';
      const retried = await app.inject({ method: 'POST', url: `/a/${secondToken}/numbers`, headers: { cookie: secondCookie } });
      assert.equal(retried.statusCode, 303, '确认未产生激活后原授权可重试');
    } finally { await app.close(); }
  });

  test('未完成对账在应用重启后恢复并自动关联唯一供应商激活', async () => {
    const fixedNow = new Date('2026-08-08T00:00:00.000Z');
    const providerActivationId = `restart-${randomUUID()}`;
    let reconciliationAvailable = false;
    let records: HeroSmsActivationRecord[] = [];
    const heroSms = scriptedHeroSms({
      getNumber: async () => { throw new HeroSmsResponseError('uncertain'); },
      activeActivations: async () => {
        if (!reconciliationAvailable) throw new HeroSmsResponseError('provider');
        return records;
      },
      activationHistory: async () => [],
    });
    const opened = await openApplication(heroSms, () => fixedNow);
    let token: string;
    let recipientCookie: string;
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const uncertain = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(uncertain.statusCode, 202);
      recipientCookie = `recipient_session=${cookieValue(uncertain, 'recipient_session')}`;
    } finally { await opened.app.close(); }

    reconciliationAvailable = true;
    records = [{
      activationId: providerActivationId, phoneNumber: '+14155550123', activationCost: 0.8,
      currency: 'USD', serviceCode: 'openai', countryId: 1, activationTime: fixedNow, status: '1',
    }];
    const restarted = await openApplication(heroSms, () => fixedNow);
    try {
      const page = await restarted.app.inject({ method: 'GET', url: `/a/${token!}`, headers: { cookie: recipientCookie! } });
      assert.match(page.body, /\+1 415 555 0123/);
    } finally { await restarted.app.close(); }
  });

  test('相同地区的后继获取对账不会误用前一候选位置', async () => {
    let now = new Date('2026-08-08T06:00:00.000Z');
    const firstActivationId = `duplicate-first-${randomUUID()}`;
    const secondActivationId = `duplicate-second-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 2) throw new HeroSmsResponseError('uncertain');
        return {
          activationId: firstActivationId, phoneNumber: '+14155550123', activationCost: 0.8,
          currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      activeActivations: async () => getNumberCalls < 2 ? [] : [{
        activationId: secondActivationId, phoneNumber: '+14155550124', activationCost: 0.8,
        currency: 'USD', serviceCode: 'openai', countryId: 1, activationTime: now, status: '1',
      }],
      activationHistory: async () => [],
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ]);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-08T06:02:00.000Z');
      const replaced = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replaced.statusCode, 303);
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /\+1 415 555 0124/);

      const activations = await database.pool.query<{ provider_activation_id: string; candidate_position: number }>(
        'SELECT provider_activation_id, candidate_position FROM supplier_activations WHERE provider_activation_id = ANY($1) ORDER BY candidate_position',
        [[firstActivationId, secondActivationId]],
      );
      assert.deepEqual(activations.rows, [
        { provider_activation_id: firstActivationId, candidate_position: 1 },
        { provider_activation_id: secondActivationId, candidate_position: 2 },
      ]);
    } finally { await app.close(); }
  });

  test('相同地区的后继获取可人工关联且后台不重复请求', async () => {
    let now = new Date('2026-08-08T12:00:00.000Z');
    const firstActivationId = `duplicate-manual-first-${randomUUID()}`;
    const linkedActivationId = `duplicate-manual-linked-${randomUUID()}`;
    const otherActivationId = `duplicate-manual-other-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 2) throw new HeroSmsResponseError('uncertain');
        return {
          activationId: firstActivationId, phoneNumber: '+14155550123', activationCost: 0.8,
          currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      activeActivations: async () => getNumberCalls < 2 ? [] : [
        {
          activationId: linkedActivationId, phoneNumber: '+14155550124', activationCost: 0.8,
          currency: 'USD', serviceCode: 'openai', countryId: 1, activationTime: now, status: '1',
        },
        {
          activationId: otherActivationId, phoneNumber: '+14155550125', activationCost: 0.8,
          currency: 'USD', serviceCode: 'openai', countryId: 1, activationTime: now, status: '1',
        },
      ],
      activationHistory: async () => [],
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ]);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-08T12:02:00.000Z');
      const confirming = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(confirming.statusCode, 202);

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const linkedAction = new RegExp(`action="/${config.adminPath}/acquisition-requests/[0-9a-f-]{36}/candidates/${linkedActivationId}/link"`, 'g');
      const otherAction = new RegExp(`action="/${config.adminPath}/acquisition-requests/[0-9a-f-]{36}/candidates/${otherActivationId}/link"`, 'g');
      assert.equal((home.body.match(linkedAction) ?? []).length, 1);
      assert.equal((home.body.match(otherAction) ?? []).length, 1);
      const link = home.body.match(new RegExp(`action="(/${config.adminPath}/acquisition-requests/[0-9a-f-]{36}/candidates/${linkedActivationId}/link)"`))?.[1]; assert.ok(link);
      assert.equal((await post(app, session, link, {})).statusCode, 303);

      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /\+1 415 555 0124/);
      const activations = await database.pool.query<{ provider_activation_id: string; candidate_position: number }>(
        'SELECT provider_activation_id, candidate_position FROM supplier_activations WHERE provider_activation_id = ANY($1) ORDER BY candidate_position',
        [[firstActivationId, linkedActivationId]],
      );
      assert.deepEqual(activations.rows, [
        { provider_activation_id: firstActivationId, candidate_position: 1 },
        { provider_activation_id: linkedActivationId, candidate_position: 2 },
      ]);
    } finally { await app.close(); }
  });

  test('有效短信进入五分钟结果窗口，原号码页面保留交付上下文并禁用后继操作', async () => {
    let now = new Date('2026-08-09T00:00:00.000Z');
    const activationId = `result-window-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      now = new Date('2026-08-09T00:03:00.000Z');
      const delivered = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), code: '482913', text: 'Your code is 482913' },
      });
      assert.equal(delivered.statusCode, 200);

      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /美国|\+1 415 555 0123|复制号码/);
      assert.match(page.body, /使用说明|482913|复制验证码|验证码可查看至/);
      assert.doesNotMatch(page.body, /更换号码|结束使用|可换号时间|可结束时间|剩余可用号码次数|正在监听短信验证码/);
      const state = await database.pool.query<{ authorization_status: string; result_view_until: Date | null; phone_number: string | null; sms_code: string | null }>(
        `SELECT auth.status AS authorization_status, auth.result_view_until, activation.phone_number, activation.sms_code
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.equal(state.rows[0]?.authorization_status, 'result_available');
      assert.equal(state.rows[0]?.result_view_until?.toISOString(), '2026-08-09T00:08:00.000Z');
      assert.deepEqual({ phone_number: state.rows[0]?.phone_number, sms_code: state.rows[0]?.sms_code }, { phone_number: '+14155550123', sms_code: '482913' });
    } finally { await app.close(); }
  });

  test('短信有效窗口采用严格半开区间，号码截止时刻及之后不恢复接收者结果', async () => {
    let now = new Date('2026-08-09T00:00:00.000Z');
    const cases = [
      { label: 'before-acquired', receivedAt: '2026-08-08T23:59:59.999Z', deliverable: false },
      { label: 'before', receivedAt: '2026-08-09T00:19:59.999Z', deliverable: true },
      { label: 'at', receivedAt: '2026-08-09T00:20:00.000Z', deliverable: false },
      { label: 'after', receivedAt: '2026-08-09T00:20:00.001Z', deliverable: false },
    ];
    const activationIds = new Map<string, string>();
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        const activationId = `result-boundary-${randomUUID()}`;
        activationIds.set(activationId, activationId);
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: new Date('2026-08-09T00:00:00.000Z'),
          activationEndTime: new Date('2026-08-09T00:20:00.000Z'),
        };
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      for (const item of cases) {
        now = new Date('2026-08-09T00:00:00.000Z');
        const created = await createAuthorization(app, session);
        const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
        const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
        const activationId = [...activationIds.keys()].at(-1); assert.ok(activationId);

        now = new Date('2026-08-09T00:20:00.001Z');
        const webhook = await app.inject({
          method: 'POST', url: `/${config.heroSmsWebhookPath}`,
          payload: { activationId, service: 'openai', country: 1, receivedAt: item.receivedAt, code: '482913', text: `boundary ${item.label}` },
        });
        assert.equal(webhook.statusCode, 200);
        const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
        if (item.deliverable) {
          assert.match(page.body, /482913|复制验证码/);
        } else {
          assert.doesNotMatch(page.body, /482913|boundary/);
        }

        const state = await database.pool.query<{ status: string; sms_code: string | null; sms_text: string | null }>(
          `SELECT auth.status, activation.sms_code, activation.sms_text
           FROM activation_authorizations auth
           JOIN supplier_activations activation ON activation.authorization_id = auth.id
           WHERE activation.provider_activation_id = $1`, [activationId],
        );
        if (item.deliverable) {
          assert.equal(state.rows[0]?.status, 'result_available');
          assert.deepEqual({ sms_code: state.rows[0]?.sms_code, sms_text: state.rows[0]?.sms_text }, { sms_code: '482913', sms_text: 'boundary before' });
        } else {
          assert.notEqual(state.rows[0]?.status, 'result_available');
          assert.deepEqual({ sms_code: state.rows[0]?.sms_code, sms_text: state.rows[0]?.sms_text }, { sms_code: null, sms_text: null });
        }
      }
    } finally { await app.close(); }
  });

  test('首次确认短信时五分钟结果窗口已结束会立即清理访问凭据和敏感数据', async () => {
    let now = new Date('2026-08-09T00:00:00.000Z');
    const activationId = `result-too-late-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      now = new Date('2026-08-09T00:10:00.000Z');
      const delivered = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId, service: 'openai', country: 1, receivedAt: '2026-08-09T00:03:00.000Z', code: '482913', text: 'too late body' },
      });
      assert.equal(delivered.statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);

      const state = await database.pool.query<{ authorization_status: string; ended_reason: string | null; token_hash: string | null; recipient_session_hash: string | null; phone_number: string | null; sms_code: string | null; sms_text: string | null }>(
        `SELECT auth.status AS authorization_status, auth.ended_reason, auth.token_hash, auth.recipient_session_hash,
                activation.phone_number, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.deepEqual(state.rows[0], {
        authorization_status: 'ended', ended_reason: 'result_view_expired', token_hash: null, recipient_session_hash: null,
        phone_number: null, sms_code: null, sms_text: null,
      });
    } finally { await app.close(); }
  });

  test('结果查看窗口到期时删除号码、验证码、短信正文和访问凭据', async () => {
    let now = new Date('2026-08-09T00:00:00.000Z');
    const activationId = `result-cleanup-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      now = new Date('2026-08-09T00:03:00.000Z');
      await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload: {
        activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), code: '482913', text: 'cleanup body',
      } });

      now = new Date('2026-08-09T00:07:59.999Z');
      const beforeExpiry = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(beforeExpiry.statusCode, 200);
      assert.match(beforeExpiry.body, /482913|\+1 415 555 0123/);

      now = new Date('2026-08-09T00:08:00.000Z');
      const afterExpiry = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(afterExpiry.statusCode, 404);
      const state = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null; recipient_session_hash: string | null; phone_number: string | null; sms_code: string | null; sms_text: string | null }>(
        `SELECT auth.status, auth.ended_reason, auth.token_hash, auth.recipient_session_hash,
                activation.phone_number, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.deepEqual(state.rows[0], {
        status: 'ended', ended_reason: 'result_view_expired', token_hash: null, recipient_session_hash: null,
        phone_number: null, sms_code: null, sms_text: null,
      });
    } finally { await app.close(); }
  });

  test('受保护 Webhook 持久化结构化验证码、幂等终止后继操作并异步完成供应商激活', async () => {
    let now = new Date('2026-08-09T00:00:00.000Z');
    const activationId = `sms-${randomUUID()}`;
    let finishCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({ activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) }),
      finishActivation: async (id) => { assert.equal(id, activationId); finishCalls += 1; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const payload = { activationId, service: 'openai', country: 1, receivedAt: '2026-08-09T00:03:00.000Z', code: '482913', text: 'Your code is 482913' };

      assert.equal((await app.inject({ method: 'POST', url: '/wrong-webhook-path', payload })).statusCode, 404);
      assert.equal((await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '192.0.2.10', payload })).statusCode, 404);
      const delivered = await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload });
      assert.equal(delivered.statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /验证码|482913|复制验证码/);
      assert.doesNotMatch(page.body, /换号|获取号码|Your code is/);
      assert.equal(finishCalls, 1);
      const state = await database.pool.query<{ authorization_status: string; activation_status: string; events: string }>(
        `SELECT auth.status AS authorization_status, activation.status AS activation_status,
                (SELECT count(*) FROM hero_sms_events event WHERE event.provider_activation_id = activation.provider_activation_id)::text AS events
         FROM supplier_activations activation JOIN activation_authorizations auth ON auth.id = activation.authorization_id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.deepEqual(state.rows[0], { authorization_status: 'result_available', activation_status: 'completed', events: '1' });

      now = new Date('2026-08-09T00:20:00.001Z');
      await app.close();
      const restarted = await openApplication(heroSms, () => now);
      try {
        const sensitive = await restarted.database.pool.query<{ phone_number: string | null; sms_code: string | null; sms_text: string | null }>(
          'SELECT phone_number, sms_code, sms_text FROM supplier_activations WHERE provider_activation_id = $1', [activationId],
        );
        assert.deepEqual(sensitive.rows[0], { phone_number: null, sms_code: null, sms_text: null });
      } finally { await restarted.app.close(); }
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('轮询恢复遗漏的异常短信，管理员仅在号码有效窗口内查看正文，后续结构化验证码自动更新', async () => {
    let now = new Date('2026-08-10T00:00:00.000Z');
    const activationId = `poll-${randomUUID()}`;
    let polledCode: string | undefined;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({ activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) }),
      activationStatus: async () => ({ delivered: true, receivedAt: new Date('2026-08-10T00:03:00.000Z'), text: 'OpenAI unusual delivery body', ...(polledCode ? { code: polledCode } : {}) }),
    });
    const opened = await openApplication(heroSms, () => now);
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      now = new Date('2026-08-10T00:03:00.000Z');
      await opened.app.close();
      const recovered = await openApplication(heroSms, () => now);
      try {
        const recipient = await recovered.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
        assert.match(recipient.body, /短信已收到，暂时无法显示验证码，请联系发送者/);
        assert.match(recipient.body, /location\.reload/);
        assert.doesNotMatch(recipient.body, /OpenAI unusual delivery body/);

        const recoveredSession = await login(recovered.app);
        const home = await recovered.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: recoveredSession.cookie } });
        const detailPath = home.body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(detailPath);
        const detail = await recovered.app.inject({ method: 'GET', url: detailPath, headers: { cookie: recoveredSession.cookie } });
        assert.match(detail.body, /OpenAI unusual delivery body/);

        polledCode = '731904';
        await recovered.app.close();
        const structured = await openApplication(heroSms, () => new Date('2026-08-10T00:04:01.000Z'));
        try {
          const page = await structured.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
          assert.match(page.body, /731904|复制验证码/);
        } finally { await structured.app.close(); }

        now = new Date('2026-08-10T00:20:00.001Z');
        const expired = await openApplication(heroSms, () => now);
        try {
          const expiredSession = await login(expired.app);
          const expiredHome = await expired.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: expiredSession.cookie } });
          const expiredDetailPath = expiredHome.body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(expiredDetailPath);
          const detail = await expired.app.inject({ method: 'GET', url: expiredDetailPath, headers: { cookie: expiredSession.cookie } });
          assert.doesNotMatch(detail.body, /OpenAI unusual delivery body|731904/);
        } finally { await expired.app.close(); }
      } finally { await recovered.app.close().catch(() => undefined); }
    } finally { await opened.app.close().catch(() => undefined); }
  });

  test('号码截止后仍在结果窗口内轮询补充结构化验证码', async () => {
    let now = new Date('2026-08-10T00:00:00.000Z');
    const activationId = `poll-after-number-expiry-${randomUUID()}`;
    let polledCode: string | undefined;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => ({
        delivered: true, receivedAt: new Date('2026-08-10T00:19:00.000Z'), text: 'late structured body',
        ...(polledCode ? { code: polledCode } : {}),
      }),
    });
    const opened = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
    } finally { await opened.app.close(); }

    now = new Date('2026-08-10T00:20:01.000Z');
    const recovered = await openApplication(heroSms, () => now);
    try {
      const page = await recovered.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /短信已收到，暂时无法显示验证码，请联系发送者/);
      assert.match(page.body, /\+1 415 555 0123|复制号码/);
      assert.doesNotMatch(page.body, /可换号时间|剩余可用号码次数/);
    } finally { await recovered.app.close(); }

    polledCode = '731904';
    now = new Date('2026-08-10T00:21:02.000Z');
    const structured = await openApplication(heroSms, () => now);
    try {
      const page = await structured.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /731904|复制验证码/);
      assert.match(page.body, /data-countdown="2026-08-10T00:24:00.000Z"/);
    } finally { await structured.app.close(); }
  });  test('供应商完成失败会持久重试，应用重启后继续且不影响验证码展示', async () => {
    const now = new Date('2026-08-11T00:00:00.000Z');
    const activationId = `finish-retry-${randomUUID()}`;
    let finishCalls = 0;
    let reconciliationCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({ activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now }),
      activationStatus: async () => { reconciliationCalls += 1; return { delivered: true, text: 'structured body', code: '482913' }; },
      finishActivation: async () => { finishCalls += 1; if (finishCalls === 1) throw new HeroSmsResponseError('uncertain'); },
    });
    const opened = await openApplication(heroSms, () => now);
    // 同一隔离数据库中的更早授权也会在启动时恢复；从此处起只观察本用例的供应商完成任务。
    finishCalls = 0;
    reconciliationCalls = 0;
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      await opened.app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload: {
        activationId, service: 'openai', country: 1, receivedAt: '2026-08-11T00:03:00.000Z', code: '482913', text: 'structured body',
      } });
      await new Promise((resolve) => setImmediate(resolve));
      const page = await opened.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /482913/);
      assert.equal(finishCalls, 1);
      assert.equal(reconciliationCalls, 1, '完成结果不明确时应查询供应商状态对账');
    } finally { await opened.app.close(); }

    const finishCallsBeforeRestart = finishCalls;
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.ok(finishCalls > finishCallsBeforeRestart, '重启应恢复完成确认任务');
      const state = await restarted.database.pool.query<{ status: string }>('SELECT status FROM supplier_activations WHERE provider_activation_id = $1', [activationId]);
      assert.equal(state.rows[0]?.status, 'completed');
    } finally { await restarted.app.close(); }
  });

  test('供应商完成确认取消时仍保留结果页号码上下文', async () => {
    const now = new Date('2026-08-11T12:00:00.000Z');
    const activationId = `finish-cancelled-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({ activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) }),
      finishActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async () => ({ delivered: false, providerStatus: 'cancelled' }),
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId, service: 'openai', country: 1, receivedAt: new Date(now.getTime() + 3 * 60_000).toISOString(), text: 'Your code is 482913', code: '482913' },
      });
      assert.equal(webhook.statusCode, 200);
      await new Promise((resolve) => setImmediate(resolve));
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /482913|复制验证码/);
      assert.match(page.body, /\+1 415 555 0123|复制号码/);
      assert.doesNotMatch(page.body, /获取下一个号码|获取号码/);
    } finally { await app.close(); }
  });

  test('接收者二次确认换号后，明确取消会清除旧敏感数据并自动获取未使用地区的后继号码', async () => {
    let now = new Date('2026-08-12T00:00:00.000Z');
    const acquiredCountries: number[] = [];
    const cancelledActivationId = `replace-old-${randomUUID()}`;
    const replacementActivationId = `replace-new-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        acquiredCountries.push(countryId);
        return {
          activationId: acquiredCountries.length === 1 ? cancelledActivationId : replacementActivationId,
          phoneNumber: acquiredCountries.length === 1 ? '+14155550123' : '+442079460123',
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async (activationId) => {
        assert.equal(activationId, cancelledActivationId);
        cancelCalls += 1;
        return 'cancelled';
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-12T00:02:00.000Z');
      const number = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(number.body, /更换号码/);
      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement`, headers: { cookie: recipientCookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /更换后当前号码将不能继续使用/);
      assert.match(confirmation.body, /继续等待/);
      const replaced = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(replaced.statusCode, 303);
      assert.equal(cancelCalls, 1);
      assert.deepEqual(acquiredCountries, [1, 2], '后继号码只能使用未成功获取过的地区');

      const replacement = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(replacement.body, /\+44 20 7946 0123/);
      assert.match(replacement.body, /剩余可用号码次数：1/);
      const oldData = await database.pool.query<{ status: string; phone_number: string | null; sms_code: string | null; sms_text: string | null }>(
        'SELECT status, phone_number, sms_code, sms_text FROM supplier_activations WHERE provider_activation_id = $1', [cancelledActivationId],
      );
      assert.deepEqual(oldData.rows[0], { status: 'cancelled', phone_number: null, sms_code: null, sms_text: null });
    } finally { await app.close(); }
  });

  test('后继号码通用错误仍显示统一获取文案且可由原浏览器重试', async () => {
    let now = new Date('2026-08-12T04:00:00.000Z');
    let getNumberCalls = 0;
    let replacementShouldFail = true;
    const firstActivationId = `replacement-error-first-${randomUUID()}`;
    const secondActivationId = `replacement-error-second-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 2 && replacementShouldFail) throw new HeroSmsResponseError('provider');
        return {
          activationId: getNumberCalls === 1 ? firstActivationId : secondActivationId,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-12T04:02:00.000Z');
      const failed = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(failed.statusCode, 503);
      assert.match(failed.body, /暂时无法获取号码，请联系发送者/);
      assert.doesNotMatch(failed.body, /暂时无法更换号码/);
      assert.equal(getNumberCalls, 2);

      replacementShouldFail = false;
      const retried = await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: recipientCookie } });
      assert.equal(retried.statusCode, 303);
      assert.equal(getNumberCalls, 3);
    } finally { await app.close(); }
  });

  test('第三个号码满两分钟后显示结束使用，确认结束后进入两分钟额度提示且不获取第四个号码', async () => {
    let now = new Date('2026-08-12T06:00:00.000Z');
    const activationIds = [0, 1, 2].map(() => randomUUID());
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        const index = getNumberCalls;
        getNumberCalls += 1;
        return {
          activationId: activationIds[index]!, phoneNumber: `+1415555012${index + 3}`,
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-12T06:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T06:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T06:05:59.999Z');
      const before = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(before.body, /可结束时间/);
      assert.doesNotMatch(before.body, /结束使用/);
      const tooEarly = await app.inject({ method: 'POST', url: `/a/${token}/replacement`, headers: { cookie: recipientCookie } });
      assert.equal(tooEarly.statusCode, 409);

      now = new Date('2026-08-12T06:06:00.000Z');
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /可结束时间|结束使用/);
      assert.doesNotMatch(page.body, /更换号码/);
      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement`, headers: { cookie: recipientCookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /结束使用此号码|结束后当前号码将不能继续使用|继续等待|确认结束/);
      const waited = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=wait' });
      assert.equal(waited.statusCode, 303);
      assert.equal(cancelCalls, 2);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ended.statusCode, 303);
      assert.equal(cancelCalls, 3);
      assert.equal(getNumberCalls, 3, '结束使用绝不能获取第四个号码');

      const prompt = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(prompt.body, /可用号码次数已用尽，请联系发送者/);
      assert.doesNotMatch(prompt.body, /1415555015|美国|更换号码|结束使用|获取下一个号码/);
      const state = await database.pool.query<{ status: string; ended_reason: string | null; end_prompt_until: Date | null; token_hash: string | null; recipient_session_hash: string | null; phone_number: string | null }>(
        `SELECT auth.status, auth.ended_reason, auth.end_prompt_until, auth.token_hash, auth.recipient_session_hash, activation.phone_number
         FROM activation_authorizations auth JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activationIds[2]],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'quota_exhausted');
      assert.equal(state.rows[0]?.end_prompt_until?.toISOString(), '2026-08-12T06:08:00.000Z');
      assert.ok(state.rows[0]?.token_hash);
      assert.ok(state.rows[0]?.recipient_session_hash);
      assert.equal(state.rows[0]?.phone_number, null);

      now = new Date('2026-08-12T06:07:59.999Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 200);
      now = new Date('2026-08-12T06:08:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
      const cleared = await database.pool.query<{ token_hash: string | null; recipient_session_hash: string | null }>(
        'SELECT token_hash, recipient_session_hash FROM activation_authorizations WHERE id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)',
        [activationIds[2]],
      );
      assert.deepEqual(cleared.rows[0], { token_hash: null, recipient_session_hash: null });
    } finally { await app.close(); }
  });

  test('短信先于取消送达会终止换号，保留短信结果且不获取后继号码', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    const activationId = `replacement-sms-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return { activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      cancelActivation: async () => 'sms-delivered',
      activationStatus: async () => ({ delivered: true, receivedAt: now, text: 'Your code is 482913', code: '482913' }),
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      now = new Date('2026-08-12T12:02:00.000Z');
      const raced = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(raced.statusCode, 202);
      assert.match(raced.body, /验证码|482913/);
      assert.equal(getNumberCalls, 1, '短信送达后不得创建后继号码');
    } finally { await app.close(); }
  });

  test('第三个号码结束使用与短信竞争时保留短信结果并进入结果窗口，不进入额度终局', async () => {
    let now = new Date('2026-08-12T18:00:00.000Z');
    const activationIds = [0, 1, 2].map(() => randomUUID());
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        const index = getNumberCalls;
        getNumberCalls += 1;
        return {
          activationId: activationIds[index]!, phoneNumber: `+1415555012${index + 3}`,
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async (activationId) => activationId === activationIds[2] ? 'sms-delivered' : 'cancelled',
      activationStatus: async () => ({ delivered: true, receivedAt: now, text: 'Your code is 482913', code: '482913' }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      now = new Date('2026-08-12T18:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T18:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T18:06:00.000Z');
      const raced = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(raced.statusCode, 202);
      assert.match(raced.body, /验证码|482913/);
      assert.doesNotMatch(raced.body, /可用号码次数已用尽/);
      assert.equal(getNumberCalls, 3, '短信胜出后不得获取第四个号码');
      const state = await database.pool.query<{ status: string }>(
        `SELECT auth.status FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationIds[2]],
      );
      assert.equal(state.rows[0]?.status, 'result_available');
    } finally { await app.close(); }
  });

  test('第三个号码取消结果不明确时不显示终局，重启确认取消后进入两分钟额度提示且不获取第四个号码', async () => {
    let now = new Date('2026-08-12T22:00:00.000Z');
    const activationIds = [0, 1, 2].map(() => randomUUID());
    let getNumberCalls = 0;
    let reconciled = false;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        const index = getNumberCalls;
        getNumberCalls += 1;
        return {
          activationId: activationIds[index]!, phoneNumber: `+1415555012${index + 3}`,
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async (activationId) => {
        if (activationId === activationIds[2]) throw new HeroSmsResponseError('uncertain');
        return 'cancelled';
      },
      activationStatus: async (activationId) => {
        if (activationId !== activationIds[2]) return { delivered: false, providerStatus: 'cancelled' };
        return reconciled ? { delivered: false, providerStatus: 'cancelled' } : { delivered: false };
      },
    });
    const opened = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const first = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      now = new Date('2026-08-12T22:02:00.000Z');
      assert.equal((await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T22:04:00.000Z');
      assert.equal((await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T22:06:00.000Z');
      const ending = await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ending.statusCode, 202);
      assert.match(ending.body, /正在结束使用/);
      assert.doesNotMatch(ending.body, /可用号码次数已用尽|获取下一个号码/);
      assert.equal(getNumberCalls, 3, '取消结果不明确前不得显示终局或获取第四个号码');
    } finally { await opened.app.close(); }

    reconciled = true;
    const restarted = await openApplication(heroSms, () => now);
    try {
      const page = await restarted.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /可用号码次数已用尽，请联系发送者/);
      assert.equal(getNumberCalls, 3, '重启确认取消后仍不得获取第四个号码');
    } finally { await restarted.app.close(); }
  });

  test('换号确认在供应商结果不明确时保持取消确认，重启对账确认取消后才自动获取后继号码', async () => {
    let now = new Date('2026-08-13T00:00:00.000Z');
    const cancelledActivationId = `uncertain-old-${randomUUID()}`;
    const replacementActivationId = `uncertain-new-${randomUUID()}`;
    let reconciled = false;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        getNumberCalls += 1;
        return { activationId: getNumberCalls === 1 ? cancelledActivationId : replacementActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async () => reconciled ? { delivered: false, providerStatus: 'cancelled' } : { delivered: false },
    });
    const opened = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const first = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      now = new Date('2026-08-13T00:02:00.000Z');
      const replacing = await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(replacing.statusCode, 202);
      assert.match(replacing.body, /正在更换号码/);
      assert.equal(getNumberCalls, 1, '取消结果不明确前不得获取后继号码');
    } finally { await opened.app.close(); }

    reconciled = true;
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(getNumberCalls, 2, '供应商确认取消后应自动获取后继号码');
      const page = await restarted.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /\+1 415 555 0123/);
    } finally { await restarted.app.close(); }
  });

  test('第三个号码取消确认后窗口内迟到短信不恢复结果，两分钟额度提示保持', async () => {
    let now = new Date('2026-08-12T20:00:00.000Z');
    const activationIds = [0, 1, 2].map(() => randomUUID());
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        const index = getNumberCalls;
        getNumberCalls += 1;
        return {
          activationId: activationIds[index]!, phoneNumber: `+141555502${index + 3}`,
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
      activationStatus: async () => ({ delivered: false, providerStatus: 'cancelled' }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      now = new Date('2026-08-12T20:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T20:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T20:06:00.000Z');
      const ending = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ending.statusCode, 303, '供应商明确确认取消后结束使用应立即完成');

      now = new Date('2026-08-12T20:06:30.000Z');
      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId: activationIds[2]!, service: 'openai', country: 1, receivedAt: '2026-08-12T20:06:30.000Z', code: '482913', text: 'late after cancel' },
      });
      assert.equal(webhook.statusCode, 200);
      const state = await database.pool.query<{ activation_status: string; authorization_status: string; sms_code: string | null; sms_text: string | null }>(
        `SELECT activation.status AS activation_status, auth.status AS authorization_status, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationIds[2]!],
      );
      assert.equal(state.rows[0]?.activation_status, 'cancelled', '取消确认后送达的短信不得恢复激活');
      assert.equal(state.rows[0]?.authorization_status, 'ended');
      assert.deepEqual({ sms_code: state.rows[0]?.sms_code, sms_text: state.rows[0]?.sms_text }, { sms_code: null, sms_text: null });
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /可用号码次数已用尽，请联系发送者/);
      assert.doesNotMatch(page.body, /482913|复制验证码|获取下一个号码/);
    } finally { await app.close(); }
  });

  test('激活超时后持久对账退款但不自动获取，接收者可在原浏览器手动获取下一个号码', async () => {
    let now = new Date('2026-08-14T00:00:00.000Z');
    const timedOutActivationId = `timeout-${randomUUID()}`;
    const nextActivationId = `after-timeout-${randomUUID()}`;
    let getNumberCalls = 0;
    let refundConfirmed = false;
    let historyCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? timedOutActivationId : nextActivationId,
          phoneNumber: getNumberCalls === 1 ? '+14155550123' : '+442079460123',
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      activationStatus: async (activationId) => {
        assert.equal(activationId, timedOutActivationId);
        return { delivered: false, providerStatus: 'cancelled' };
      },
      activationHistory: async () => {
        historyCalls += 1;
        return [{
          activationId: timedOutActivationId, phoneNumber: '+1********23', activationCost: refundConfirmed ? 0 : 0.8,
          currency: 'USD', activationTime: now, status: '4',
        }];
      },
    });
    const { app: initial } = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      now = new Date('2026-08-14T00:19:59.999Z');
      const justBeforeTimeout = await initial.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(justBeforeTimeout.body, /\+1 415 555 0123/);
    } finally { await initial.close(); }

    now = new Date('2026-08-14T00:20:00.000Z');
    const { app: timedOut } = await openApplication(heroSms, () => now);
    try {
      assert.equal(getNumberCalls, 1, '激活超时不得在接收者离开页面后自动获取后继号码');
      const page = await timedOut.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /号码已过期/);
      assert.match(page.body, /剩余可用号码次数：2/);
      assert.match(page.body, /获取下一个号码/);
      assert.doesNotMatch(page.body, /\+1 415 555 0123/);
      const next = await timedOut.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: recipientCookie } });
      assert.equal(next.statusCode, 303);
      assert.equal(getNumberCalls, 2, '只有接收者再次点击才获取下一个号码');
    } finally { await timedOut.close(); }

    const historyCallsBeforeRefund = historyCalls;
    refundConfirmed = true;
    const { app: reconciled } = await openApplication(heroSms, () => now);
    try {
      assert.ok(historyCalls > historyCallsBeforeRefund, '费用仍非零时必须保留退款对账任务，重启后继续确认');
      const page = await reconciled.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /\+44 20 7946 0123/, '重启后继续处理退款对账不会改变接收者当前激活');
    } finally { await reconciled.close(); }
  });

  test('第三次激活超时后授权额度已用尽，可以继续创建新的待领取链接', async () => {
    let now = new Date('2026-08-14T06:00:00.000Z');
    const activationIds = [0, 1, 2].map(() => randomUUID());
    let acquisitionIndex = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        const activationId = activationIds[acquisitionIndex]; assert.ok(activationId);
        acquisitionIndex += 1;
        return {
          activationId, phoneNumber: `+1415555012${acquisitionIndex}`, activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
      activationStatus: async (activationId) => {
        assert.equal(activationId, activationIds[2]);
        return { delivered: false, providerStatus: 'cancelled' };
      },
      activationHistory: async () => [{
        activationId: activationIds[2]!, phoneNumber: '+1********23', activationCost: 0,
        currency: 'USD', activationTime: now, status: '4',
      }],
    });
    const { app: initial, database: initialDatabase } = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const first = await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-14T06:02:00.000Z');
      assert.equal((await initial.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-14T06:04:00.000Z');
      assert.equal((await initial.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(acquisitionIndex, 3);

      // 模拟历史中已有一次确认超时，而第三次激活仍在等待短信。
      await initialDatabase.pool.query(
        "UPDATE supplier_activations SET status = 'timed_out', timed_out_at = $2, timeout_final_status_confirmed_at = $2 WHERE provider_activation_id = $1",
        [activationIds[0], now],
      );
    } finally { await initial.close(); }

    const { app: activeRestart } = await openApplication(heroSms, () => now);
    try {
      const page = await activeRestart.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /\+1 415 555 0123/);
      const session = await login(activeRestart);
      const home = await activeRestart.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      assert.match(home.body, new RegExp(`data-authorization-id="${authorizationId}"[^>]*>[\\s\\S]*?<span class="authorization-status">进行中</span>`));
    } finally { await activeRestart.close(); }

    now = new Date('2026-08-14T06:24:00.000Z');
    const { app: timedOut, database } = await openApplication(heroSms, () => now);
    try {
      const page = await timedOut.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /可用号码次数已用尽/);
      assert.doesNotMatch(page.body, /获取下一个号码|获取号码/);

      const session = await login(timedOut);
      const home = await timedOut.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.match(home.body, /已结束/);

      // 模拟修复部署前已经确认第三次超时、但授权仍错误停在“进行中”的数据。
      await database.pool.query(
        "UPDATE activation_authorizations SET status = 'in_progress' WHERE token_suffix = $1",
        [token.slice(-8)],
      );
    } finally { await timedOut.close(); }

    const { app: migrated } = await openApplication(heroSms, () => now);
    try {
      const session = await login(migrated);
      const home = await migrated.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.match(home.body, /已结束/);
      const recreated = await createAuthorization(migrated, session);
      assert.equal(recreated.statusCode, 201);
    } finally { await migrated.close(); }
  });

  test('超时扫描后确认窗口内已送达短信时，接收者看到短信结果且不能再获取号码', async () => {
    let now = new Date('2026-08-15T06:00:00.000Z');
    const activationId = `timeout-in-window-delivery-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => ({
        delivered: true, receivedAt: new Date('2026-08-15T06:19:59.999Z'), text: 'Your code is 482913', code: '482913',
      }),
    });
    const { app: initial } = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
    } finally { await initial.close(); }

    now = new Date('2026-08-15T06:20:00.000Z');
    const { app: reconciled } = await openApplication(heroSms, () => now);
    try {
      const page = await reconciled.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /482913|复制验证码/);
      assert.match(page.body, /\+1 415 555 0123|复制号码/);
      assert.doesNotMatch(page.body, /获取下一个号码|获取号码/);
    } finally { await reconciled.close(); }
  });

  test('窗口后的迟到短信不会恢复敏感交付数据，接收者仍可手动获取下一个号码', async () => {
    let now = new Date('2026-08-15T00:00:00.000Z');
    const activationId = `timeout-delivered-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      activationStatus: async () => ({
        delivered: true, receivedAt: new Date('2026-08-15T00:20:01.000Z'), text: 'Your code is 482913', code: '482913',
      }),
    });
    const { app: initial } = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
    } finally { await initial.close(); }

    now = new Date('2026-08-15T00:20:00.000Z');
    const { app: restarted } = await openApplication(heroSms, () => now);
    try {
      const page = await restarted.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /获取下一个号码/);
      assert.doesNotMatch(page.body, /482913|Your code is|\+1 415 555 0123/);
      assert.equal(getNumberCalls, 1);
    } finally { await restarted.close(); }
  });

  test('HeroSMS 尚未返回最终状态时，激活超时继续对账而不开放后继号码', async () => {
    let now = new Date('2026-08-16T06:00:00.000Z');
    const activationId = `timeout-waiting-${randomUUID()}`;
    let delivered = false;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => delivered
        ? { delivered: true, receivedAt: new Date('2026-08-16T06:19:59.999Z'), text: 'late body', code: '482913' }
        : { delivered: false },
    });
    const { app: initial } = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
    } finally { await initial.close(); }

    now = new Date('2026-08-16T06:20:00.000Z');
    const { app: restarted } = await openApplication(heroSms, () => now);
    try {
      const page = await restarted.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /正在确认号码状态/);
      assert.doesNotMatch(page.body, /获取下一个号码|获取号码/);

      const session = await login(restarted);
      const home = await restarted.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const detailPath = home.body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(detailPath);
      const detail = await restarted.inject({ method: 'GET', url: detailPath, headers: { cookie: session.cookie } });
      assert.match(detail.body, /manual_reconciliation/);
      assert.doesNotMatch(detail.body, /timed_out/);
    } finally { await restarted.close(); }

    delivered = true;
    now = new Date('2026-08-16T06:21:00.000Z');
    const confirmed = await openApplication(heroSms, () => now);
    try {
      const page = await confirmed.app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /482913|复制验证码/);
      assert.match(page.body, /\+1 415 555 0123|复制号码/);
    } finally { await confirmed.app.close(); }
  });

  test('授权在 24 小时临界秒删除接收者访问凭据，已有激活继续收尾且仅管理员可见', async () => {
    let now = new Date('2026-08-20T00:00:00.000Z');
    const activationId = `expiry-existing-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      now = new Date('2026-08-20T23:50:00.000Z');
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      now = new Date('2026-08-20T23:59:59.999Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 200);
      now = new Date('2026-08-21T00:00:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 200);
      assert.equal(cancelCalls, 0, '截止时已经存在的供应商激活不得因授权到期自动取消');

      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '127.0.0.1',
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), text: 'late body', code: '482913' },
      });
      assert.equal(webhook.statusCode, 200);
      const detailPath = (await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } })).body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(detailPath);
      const detail = await app.inject({ method: 'GET', url: detailPath, headers: { cookie: session.cookie } });
      assert.match(detail.body, /completion_confirming|completed/);
      const recipient = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(recipient.statusCode, 200);
      assert.match(recipient.body, /482913|复制验证码|\+1 415 555 0123/);
      now = new Date('2026-08-21T00:05:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
    } finally { await app.close(); }
  });

  test('供应商取得时间等于领取截止时不交付，并在允许取消后自动供应商取消', async () => {
    let now = new Date('2026-08-22T00:00:00.000Z');
    const activationId = `expiry-late-acquisition-${randomUUID()}`;
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        now = new Date('2026-08-23T00:00:00.000Z');
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: new Date('2026-08-23T00:00:00.000Z'), activationEndTime: new Date('2026-08-23T00:20:00.000Z'),
        };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    let detailPath = '';
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      detailPath = (await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } })).body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1] ?? '';
      assert.ok(detailPath);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const response = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      // 领取发生在 08-22 00:00，领取截止 = 08-23 00:00；供应商取得时间恰为截止时刻，不交付
      assert.equal(response.statusCode, 404);
      assert.equal(getNumberCalls, 1);
      assert.equal(cancelCalls, 0, '供应商尚未允许取消时应保留持久取消任务');
    } finally { await app.close(); }

    now = new Date('2026-08-23T00:01:59.999Z');
    const beforeAllowed = await openApplication(heroSms, () => now);
    try { assert.equal(cancelCalls, 0); } finally { await beforeAllowed.app.close(); }

    now = new Date('2026-08-23T00:02:00.000Z');
    const allowed = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1);
      const adminSession = await login(allowed.app);
      const detail = await allowed.app.inject({ method: 'GET', url: detailPath, headers: { cookie: adminSession.cookie } });
      assert.match(detail.body, /cancelled/);
      assert.doesNotMatch(detail.body, /\+14155550123/);
      assert.equal(getNumberCalls, 1, '授权到期后不得创建后继激活');
    } finally { await allowed.app.close(); }
  });

  test('截止前结果不确定的获取在截止后对账时不交付，并在允许取消后自动取消', async () => {
    let now = new Date('2026-08-26T00:00:00.000Z');
    const activationId = `expiry-reconciled-${randomUUID()}`;
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        now = new Date('2026-08-27T00:00:00.000Z');
        throw new HeroSmsResponseError('uncertain');
      },
      activeActivations: async () => [{
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', serviceCode: 'openai', countryId: 1,
        activationTime: new Date('2026-08-27T00:00:00.000Z'), status: 'STATUS_WAIT_CODE',
      }],
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      // 领取发生在 08-26 00:00，领取截止 = 08-27 00:00；供应商取得时间恰为截止时刻，不交付
      const response = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(response.statusCode, 404);
      assert.equal(getNumberCalls, 1);
      assert.equal(cancelCalls, 0);
    } finally { await app.close(); }

    now = new Date('2026-08-27T00:01:59.999Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(getNumberCalls, 1, '迟到号码收尾后不得创建后继激活');
      assert.equal(cancelCalls, 0, '供应商尚未允许取消时应保留持久取消任务');
    } finally { await restarted.app.close(); }

    now = new Date('2026-08-27T00:02:00.000Z');
    const allowed = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1, '允许取消后自动取消不交付的激活');
      assert.equal(getNumberCalls, 1);
    } finally { await allowed.app.close(); }
  });

  test('全局获取队列等待跨过截止秒时，供应商取得时间在截止前的请求仍可交付', async () => {
    let now = new Date('2026-08-28T00:00:00.000Z');
    let getNumberCalls = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        // 前两次是领取时取得首个号码（窗口即时开始）；第三次是第一个链接换号，必须阻塞以观察排队请求跨过截止。
        if (getNumberCalls >= 3) await firstBlocked;
        const activationTime = getNumberCalls >= 3 ? new Date('2026-08-28T23:59:59.999Z') : now;
        return {
          activationId: `expiry-queued-${randomUUID()}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime, activationEndTime: new Date(activationTime.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const first = await createAuthorization(app, session);
      const second = await createAuthorization(app, session);
      const firstToken = first.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(firstToken);
      const secondToken = second.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(secondToken);

      // 08-28 00:00 两个链接各自领取并取得号码，领取截止 = 08-29 00:00
      const firstClaim = await app.inject({ method: 'POST', url: `/a/${firstToken}/numbers` });
      const secondClaim = await app.inject({ method: 'POST', url: `/a/${secondToken}/numbers` });
      assert.equal(firstClaim.statusCode, 303);
      assert.equal(secondClaim.statusCode, 303);
      assert.equal(getNumberCalls, 2);
      const firstCookie = `recipient_session=${cookieValue(firstClaim, 'recipient_session')}`;
      const secondCookie = `recipient_session=${cookieValue(secondClaim, 'recipient_session')}`;

      // 08-28 00:02 两个链接同时换号：第一个锁住，第二个进入 PostgreSQL 全局队列
      now = new Date('2026-08-28T00:02:00.000Z');
      const firstRequest = app.inject({ method: 'POST', url: `/a/${firstToken}/replacement/confirm`, headers: { cookie: firstCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const queuedRequest = app.inject({ method: 'POST', url: `/a/${secondToken}/replacement/confirm`, headers: { cookie: secondCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(getNumberCalls, 3, '第二个请求应在 PostgreSQL 全局队列中等待');
      // 并行负载下第二个请求的取消确认可能延迟；轮询其激活变为已取消，
      // 确认取消确认完成后才推进时钟，避免取消确认阶段跨过截止。
      // 不能轮询 pg_locks：咨询锁是实例级的，其他并行测试的排队请求会造成误判。
      const cancelConfirmedStartedAt = Date.now();
      for (;;) {
        const activation = await database.pool.query<{ status: string }>(
          `SELECT activation.status FROM supplier_activations activation
           JOIN activation_authorizations auth ON auth.id = activation.authorization_id
           WHERE auth.token_suffix = $1`,
          [secondToken.slice(-8)],
        );
        if (activation.rows[0]?.status === 'cancelled') break;
        if (Date.now() - cancelConfirmedStartedAt > 5_000) throw new Error('第二个请求未完成取消确认');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      now = new Date('2026-08-29T00:00:00.000Z');
      releaseFirst();
      assert.equal((await firstRequest).statusCode, 303, '供应商取得时间在截止前的号码仍可交付');
      assert.equal((await queuedRequest).statusCode, 404, '排队资格不能越过授权期限');
      assert.equal(getNumberCalls, 3, '截止后不得为队列中的请求调用 HeroSMS');
    } finally { await app.close(); }
  });

  test('明确无库存响应跨过授权截止秒后，不再调用下一个候选地区', async () => {
    let now = new Date('2026-08-24T00:00:00.000Z');
    let getNumberCalls = 0;
    const attemptedCountries: number[] = [];
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        getNumberCalls += 1;
        attemptedCountries.push(countryId);
        if (getNumberCalls === 1) {
          return {
            activationId: `no-stock-cross-${randomUUID()}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
            activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
          };
        }
        now = new Date('2026-08-25T00:00:00.000Z');
        throw new HeroSmsResponseError('no-numbers');
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claim = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claim.statusCode, 303);
      const recipientCookie = `recipient_session=${cookieValue(claim, 'recipient_session')}`;
      assert.deepEqual(attemptedCountries, [1]);
      // 领取截止 = 08-25 00:00；位置 1 已被领取消费，换号从位置 2 开始，
      // 位置 2 返回明确无库存并把时间推进到截止，不再调用下一个候选地区。
      now = new Date('2026-08-24T00:02:00.000Z');
      const replaced = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(replaced.statusCode, 404);
      assert.deepEqual(attemptedCountries, [1, 2]);
      assert.equal(getNumberCalls, 2, '跨过领取截止后绝不能获取第三个候选地区');
    } finally { await app.close(); }
  });

  test('领取截止后窗口内当前号码降级为结束使用，确认后不创建后继号码并以领取后期限结束', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationId = `deadline-degrade-${randomUUID()}`;
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        // 领取发生在 08-01 00:00，领取截止 = 08-02 00:00；供应商在截止前 1 毫秒取得号码，窗口跨过截止
        now = new Date('2026-08-01T23:59:59.999Z');
        return { activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      // 立即领取，领取截止 = 08-02 00:00
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      assert.equal(getNumberCalls, 1);

      now = new Date('2026-08-02T00:05:00.000Z');
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /链接剩余时间/);
      assert.match(page.body, /结束使用/);
      assert.match(page.body, /可结束时间/);
      assert.doesNotMatch(page.body, /更换号码|获取下一个号码/);

      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement`, headers: { cookie: recipientCookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /结束使用此号码/);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ended.statusCode, 404);
      assert.equal(cancelCalls, 1);
      assert.equal(getNumberCalls, 1, '领取截止后不得创建后继号码');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);

      const state = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null; recipient_session_hash: string | null }>(
        'SELECT status, ended_reason, token_hash, recipient_session_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'acquisition_expired');
      assert.equal(state.rows[0]?.token_hash, null);
      assert.equal(state.rows[0]?.recipient_session_hash, null);
    } finally { await app.close(); }
  });

  test('第三个号码跨过领取截止后结束使用，仍以获取额度用尽结束并提供两分钟提示且不获取第四个号码', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationIds = [0, 1, 2].map(() => randomUUID());
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        const index = getNumberCalls;
        getNumberCalls += 1;
        // 第三个号码在领取截止（08-02 00:00）前 1 毫秒取得，窗口跨过截止
        if (index === 2) now = new Date('2026-08-01T23:59:59.999Z');
        return {
          activationId: activationIds[index]!, phoneNumber: `+1415555012${index + 3}`,
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      // 立即领取，领取截止 = 08-02 00:00
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      now = new Date('2026-08-01T00:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-01T00:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-02T00:05:00.000Z');
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /结束使用/);
      assert.doesNotMatch(page.body, /更换号码|获取下一个号码/);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ended.statusCode, 303);
      assert.equal(cancelCalls, 3);
      assert.equal(getNumberCalls, 3, '领取截止后的结束使用绝不能获取第四个号码');

      const prompt = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(prompt.body, /可用号码次数已用尽，请联系发送者/);
      assert.doesNotMatch(prompt.body, /1415555015|美国|更换号码|结束使用|获取下一个号码/);
      const state = await database.pool.query<{ status: string; ended_reason: string | null; end_prompt_until: Date | null; token_hash: string | null; recipient_session_hash: string | null }>(
        `SELECT auth.status, auth.ended_reason, auth.end_prompt_until, auth.token_hash, auth.recipient_session_hash
         FROM activation_authorizations auth JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activationIds[2]],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'quota_exhausted');
      assert.equal(state.rows[0]?.end_prompt_until?.toISOString(), '2026-08-02T00:07:00.000Z');
      assert.ok(state.rows[0]?.token_hash);
      assert.ok(state.rows[0]?.recipient_session_hash);

      now = new Date('2026-08-02T00:06:59.999Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 200);
      now = new Date('2026-08-02T00:07:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
      const cleared = await database.pool.query<{ token_hash: string | null; recipient_session_hash: string | null }>(
        'SELECT token_hash, recipient_session_hash FROM activation_authorizations WHERE id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)',
        [activationIds[2]],
      );
      assert.deepEqual(cleared.rows[0], { token_hash: null, recipient_session_hash: null });
    } finally { await app.close(); }
  });

  test('批量领取截止边界：截止前 1 毫秒可获取交付，恰好与截止后 1 毫秒拒绝且不调用 HeroSMS', async () => {
    let now = new Date('2026-08-05T00:00:00.000Z');
    const successActivationId = `boundary-success-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls < 4) throw new HeroSmsResponseError('balance');
        return {
          activationId: successActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ]);
      const session = await login(app);
      const created = await createBatch(app, session, '3');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(tokens.length, 3);
      const first = await app.inject({ method: 'POST', url: `/a/${tokens[0]}/numbers` });
      assert.equal(first.statusCode, 503);
      const second = await app.inject({ method: 'POST', url: `/a/${tokens[1]}/numbers` });
      assert.equal(second.statusCode, 503);
      const third = await app.inject({ method: 'POST', url: `/a/${tokens[2]}/numbers` });
      assert.equal(third.statusCode, 503);
      const firstCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      const secondCookie = `recipient_session=${cookieValue(second, 'recipient_session')}`;
      const thirdCookie = `recipient_session=${cookieValue(third, 'recipient_session')}`;

      now = new Date('2026-08-05T23:59:59.999Z');
      const claimed = await app.inject({ method: 'POST', url: `/a/${tokens[0]}/numbers`, headers: { cookie: firstCookie } });
      assert.equal(claimed.statusCode, 303);
      const page = await app.inject({ method: 'GET', url: `/a/${tokens[0]}`, headers: { cookie: firstCookie } });
      assert.match(page.body, /data-countdown="2026-08-06T00:19:59.999Z"/);

      now = new Date('2026-08-06T00:00:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${tokens[1]}/numbers`, headers: { cookie: secondCookie } })).statusCode, 404);
      now = new Date('2026-08-06T00:00:00.001Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${tokens[2]}/numbers`, headers: { cookie: thirdCookie } })).statusCode, 404);
      assert.equal(getNumberCalls, 4, '恰好与截止后不得调用 HeroSMS');
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('同步成功响应缺失取得时间或截止时间时按规范化规则计算号码窗口', async () => {
    let now = new Date('2026-08-03T00:00:00.000Z');
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 1) return { activationId: `no-times-${randomUUID()}`, phoneNumber: '+14155550123' };
        return { activationId: `no-end-time-${randomUUID()}`, phoneNumber: '+442079460123', activationTime: new Date('2026-08-03T00:05:00.000Z') };
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ]);
      const session = await login(app);
      const created = await createBatch(app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      const first = await app.inject({ method: 'POST', url: `/a/${tokens[0]}/numbers` });
      assert.equal(first.statusCode, 303);
      const firstCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      const firstPage = await app.inject({ method: 'GET', url: `/a/${tokens[0]}`, headers: { cookie: firstCookie } });
      assert.match(firstPage.body, /data-countdown="2026-08-03T00:20:00.000Z"/);

      const second = await app.inject({ method: 'POST', url: `/a/${tokens[1]}/numbers` });
      assert.equal(second.statusCode, 303);
      const secondCookie = `recipient_session=${cookieValue(second, 'recipient_session')}`;
      const secondPage = await app.inject({ method: 'GET', url: `/a/${tokens[1]}`, headers: { cookie: secondCookie } });
      assert.match(secondPage.body, /data-countdown="2026-08-03T00:25:00.000Z"/);
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('跨截止确认且缺失取得时间时按确认时间判定不交付，并在允许取消后自动供应商取消', async () => {
    let now = new Date('2026-08-03T00:00:00.000Z');
    const activationId = `deadline-confirmed-${randomUUID()}`;
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 1) throw new HeroSmsResponseError('balance');
        // 模拟同步成功响应跨过截止秒才被确认：仅返回号码，缺失取得时间，并推进测试时钟。
        now = new Date('2026-08-04T00:00:00.001Z');
        return { activationId, phoneNumber: '+14155550123' };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ]);
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 503);
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;

      now = new Date('2026-08-03T23:59:59.999Z');
      const late = await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: recipientCookie } });
      assert.equal(late.statusCode, 404);
      assert.equal(getNumberCalls, 2);
      assert.equal(cancelCalls, 0, '供应商尚未允许取消时应保留持久取消任务');
      const stored = await database.pool.query<{ phone_number: string | null; status: string; authorization_expiry_cancellation_pending: boolean }>(
        `SELECT phone_number, status, authorization_expiry_cancellation_pending FROM supplier_activations WHERE provider_activation_id = $1`,
        [activationId],
      );
      assert.equal(stored.rows[0]?.phone_number, null);
      assert.equal(stored.rows[0]?.status, 'waiting_sms');
      assert.equal(stored.rows[0]?.authorization_expiry_cancellation_pending, true);
    } finally { await app.close(); }

    // 清理必须放在最终块并使用第二个应用的数据库：批授权行需要跨重启存活到供应商取消对账。
    now = new Date('2026-08-04T00:02:00.001Z');
    const allowed = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1);
      assert.equal(getNumberCalls, 2, '跨截止确认的号码不得再次获取');
    } finally {
      await allowed.app.close();
      const cleanupDatabase = new Database(databaseUrl!);
      try {
        await cleanupBatchAuthorizations(cleanupDatabase);
      } finally {
        await cleanupDatabase.close();
      }
    }
  });

  test('跨过领取截止的当前号码窗口结束后超时收尾，以领取后期限结束且不创建后继号码', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationId = `deadline-timeout-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        // 领取发生在 08-01 00:00，领取截止 = 08-02 00:00；供应商在截止前 1 毫秒取得号码，窗口跨过截止
        now = new Date('2026-08-01T23:59:59.999Z');
        return { activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      activationStatus: async () => ({ delivered: false, providerStatus: 'cancelled' }),
      activationHistory: async () => [{ activationId, phoneNumber: '+14155550123', activationCost: 0, currency: 'USD', activationTime: new Date('2026-08-01T23:59:59.999Z'), status: 'cancelled' }],
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      // 立即领取，领取截止 = 08-02 00:00
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      // 号码窗口（至 08-02 00:19:59.999）跨过领取截止后结束，超时收尾并以领取后期限结束
      now = new Date('2026-08-02T00:20:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
      assert.equal(getNumberCalls, 1, '超时收尾不得创建后继号码');
      const state = await database.pool.query<{
        status: string; ended_reason: string | null; token_hash: string | null; recipient_session_hash: string | null;
        activation_status: string; phone_number: string | null;
      }>(
        `SELECT auth.status, auth.ended_reason, auth.token_hash, auth.recipient_session_hash,
                activation.status AS activation_status, activation.phone_number
         FROM activation_authorizations auth JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'acquisition_expired');
      assert.equal(state.rows[0]?.token_hash, null);
      assert.equal(state.rows[0]?.recipient_session_hash, null);
      assert.equal(state.rows[0]?.activation_status, 'timed_out');
      assert.equal(state.rows[0]?.phone_number, null);
    } finally { await app.close(); }
  });

  test('领取截止后误触获取号码请求被拒绝但不清理凭据，窗口内短信仍完整送达', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationId = `stale-numbers-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        // 领取发生在 08-01 00:00，领取截止 = 08-02 00:00；供应商在截止前 1 毫秒取得号码，窗口跨过截止
        now = new Date('2026-08-01T23:59:59.999Z');
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      // 立即领取，领取截止 = 08-02 00:00
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      // 截止后陈旧页面的获取按钮仍会发起请求：必须拒绝新获取，但不得清理窗口内当前号码的访问凭据。
      now = new Date('2026-08-02T00:05:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: recipientCookie } })).statusCode, 404);
      assert.equal(cancelCalls, 0, '拒绝获取不得触发供应商取消');
      const preserved = await database.pool.query<{ status: string; token_hash: string | null; recipient_session_hash: string | null }>(
        'SELECT status, token_hash, recipient_session_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.equal(preserved.rows[0]?.status, 'in_progress');
      assert.ok(preserved.rows[0]?.token_hash, '拒绝获取不得清理链接凭据');
      assert.ok(preserved.rows[0]?.recipient_session_hash, '拒绝获取不得清理浏览器凭据');

      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /结束使用/);
      assert.doesNotMatch(page.body, /更换号码|获取下一个号码/);
      assert.match(page.body, /data-countdown="2026-08-02T00:19:59.999Z"/);

      // 跨截止的当前号码窗口内到达的短信仍进入完整五分钟结果窗口。
      now = new Date('2026-08-02T00:07:00.000Z');
      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '127.0.0.1',
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), code: '482913', text: 'deadline window sms' },
      });
      assert.equal(webhook.statusCode, 200);
      const result = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(result.body, /482913|复制验证码/);
      assert.match(result.body, /data-countdown="2026-08-02T00:12:00.000Z"/);

      now = new Date('2026-08-02T00:12:00.001Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
    } finally { await app.close(); }
  });

  test('取得时间早于截止而确认晚于截止时交付剩余供应商窗口，不截短也不延长', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationId = `delayed-confirm-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        // 供应商在截止前 1 毫秒取得号码，但同步成功响应到系统确认时已经跨过截止秒。
        now = new Date('2026-08-02T00:00:00.001Z');
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: new Date('2026-08-01T23:59:59.999Z'), activationEndTime: new Date('2026-08-02T00:19:59.999Z'),
        };
      },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      now = new Date('2026-08-01T23:59:59.999Z');
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      assert.equal(getNumberCalls, 1);

      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /\+1 415 555 0123|复制号码/);
      // 剩余窗口保持供应商原窗口（取得时间 + 20 分钟）：不因截止截短，也不因确认延迟延长。
      assert.match(page.body, /data-countdown="2026-08-02T00:19:59.999Z"/);
    } finally { await app.close(); }
  });

  test('截止前确认换号但供应商在截止后才确认取消时不创建后继号码', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationId = `cross-deadline-cancel-${randomUUID()}`;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        // 领取发生在 08-01 00:00，领取截止 = 08-02 00:00；首个号码在截止前 10 分钟取得，窗口跨过截止
        now = new Date('2026-08-01T23:50:00.000Z');
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => {
        // 供应商在截止后才确认取消：推进测试时钟跨过截止秒并返回确认。
        now = new Date('2026-08-02T00:00:00.001Z');
        return 'cancelled';
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      // 立即领取，领取截止 = 08-02 00:00
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      now = new Date('2026-08-01T23:59:59.999Z');
      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement`, headers: { cookie: recipientCookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /确认更换号码/);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ended.statusCode, 404);
      assert.equal(getNumberCalls, 1, '供应商在截止后确认取消时不得创建后继号码');
      const state = await database.pool.query<{
        status: string; ended_reason: string | null; activation_status: string; replacement_pending: boolean; end_use_pending: boolean;
      }>(
        `SELECT auth.status, auth.ended_reason, activation.status AS activation_status,
                activation.replacement_pending, activation.end_use_pending
         FROM activation_authorizations auth JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'acquisition_expired');
      assert.equal(state.rows[0]?.activation_status, 'cancelled');
      assert.equal(state.rows[0]?.replacement_pending, false);
      assert.equal(state.rows[0]?.end_use_pending, false);
    } finally { await app.close(); }
  });

  test('管理员确认撤销已领取且可取消的授权后，立即切断访问并取消当前供应商激活', async () => {
    let now = new Date('2026-09-01T00:00:00.000Z');
    const activationId = `revoked-waiting-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async (id) => { assert.equal(id, activationId); cancelCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      now = new Date('2026-09-01T00:02:00.000Z');
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。/);
      assert.match(confirmation.body, new RegExp(`链接末 8 位：${token.slice(-8)}`));
      assert.match(confirmation.body, /<strong>授权状态：<\/strong>进行中/);
      assert.match(confirmation.body, /<strong>当前激活状态：<\/strong>waiting_sms/);
      assert.match(confirmation.body, /<strong>当前地区：<\/strong>美国/);
      assert.match(confirmation.body, /<strong>已获取次数：<\/strong>1/);
      assert.match(confirmation.body, /立即请求取消当前供应商激活/);

      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      assert.equal(cancelCalls, 1);
      const recipient = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(recipient.statusCode, 404);
      const state = await database.pool.query<{
        status: string; ended_reason: string | null; token_hash: string | null; recipient_session_hash: string | null;
        phone_number: string | null; sms_code: string | null; sms_text: string | null;
      }>(
        `SELECT auth.status, auth.ended_reason, auth.token_hash, auth.recipient_session_hash,
                activation.phone_number, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE auth.id = $1`, [id],
      );
      assert.deepEqual(state.rows[0], {
        status: 'ended', ended_reason: 'admin_revoked', token_hash: null, recipient_session_hash: null,
        phone_number: null, sms_code: null, sms_text: null,
      });
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /授权状态：已结束/);
      assert.match(detail.body, /结束原因：管理员撤销/);
      assert.match(detail.body, /cancelled/);
      assert.match(detail.body, /已确认退款：0\.80 USD/);
      assert.match(detail.body, /净成本：0\.00 USD/);
      assert.doesNotMatch(detail.body, /\+14155550123/);
    } finally { await app.close(); }
  });

  test('撤销未满两分钟的当前激活会持久等待，并在重启后到时取消', async () => {
    let now = new Date('2026-09-02T00:00:00.000Z');
    const activationId = `revoked-delayed-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    let token = '';
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.match(confirmation.body, /撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。/);
      assert.match(confirmation.body, /将在可取消时请求取消当前供应商激活/);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancelCalls, 0);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
    } finally { await app.close(); }

    now = new Date('2026-09-02T00:01:59.999Z');
    const beforeAllowed = await openApplication(heroSms, () => now);
    try { assert.equal(cancelCalls, 0); } finally { await beforeAllowed.app.close(); }
    now = new Date('2026-09-02T00:02:00.000Z');
    const allowed = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1);
      assert.equal((await allowed.app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
    } finally { await allowed.app.close(); }
  });

  test('撤销取消过早响应会持久延后重试，重启前不重复请求供应商', async () => {
    let now = new Date('2026-09-06T00:00:00.000Z');
    const activationId = `revoked-too-early-${randomUUID()}`;
    let cancellationCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancellationCalls += 1;
        return cancellationCalls === 1 ? 'too-early' : 'cancelled';
      },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancellationCalls, 0);
    } finally { await app.close(); }

    now = new Date('2026-09-06T00:02:00.000Z');
    const tooEarly = await openApplication(heroSms, () => now);
    try { assert.equal(cancellationCalls, 1); } finally { await tooEarly.app.close(); }
    now = new Date('2026-09-06T00:02:30.000Z');
    const beforeRetry = await openApplication(heroSms, () => now);
    try { assert.equal(cancellationCalls, 1); } finally { await beforeRetry.app.close(); }
    now = new Date('2026-09-06T00:03:00.000Z');
    const retried = await openApplication(heroSms, () => now);
    try { assert.equal(cancellationCalls, 2); } finally { await retried.app.close(); }
  });

  test('短信送达后撤销只终止接收者访问，不取消供应商激活或自动换号', async () => {
    const now = new Date('2026-09-03T00:03:00.000Z');
    const activationId = `revoked-sms-${randomUUID()}`;
    let cancelCalls = 0;
    let acquiredNumbers = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        acquiredNumbers += 1;
        return { activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      assert.equal((await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '127.0.0.1',
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), text: '验证码 482913', code: '482913' },
      })).statusCode, 200);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.match(confirmation.body, /撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。/);
      assert.match(confirmation.body, /只终止接收者访问，不请求供应商取消/);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancelCalls, 0);
      assert.equal(acquiredNumbers, 1);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
    } finally { await app.close(); }
  });

  test('撤销获取结果待确认的授权后，重启对账确认号码并取消且不交付', async () => {
    let now = new Date('2026-09-04T00:00:00.000Z');
    const activationId = `revoked-reconciled-${randomUUID()}`;
    let reconciliationFindsNumber = false;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => { throw new HeroSmsResponseError('uncertain'); },
      activeActivations: async () => reconciliationFindsNumber ? [{
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', serviceCode: 'openai', countryId: 1,
        activationTime: new Date('2026-09-04T00:00:00.000Z'), status: 'STATUS_WAIT_CODE',
      }] : [],
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    let token = '';
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/numbers` })).statusCode, 202);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.match(confirmation.body, /撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。/);
      assert.match(confirmation.body, /先完成供应商对账，确认号码后取消/);
      assert.match(confirmation.body, /<strong>当前地区：<\/strong>美国/);
      assert.match(confirmation.body, /<strong>当前激活状态：<\/strong>(?:获取结果确认中|结果待人工对账)/);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
    } finally { await app.close(); }

    reconciliationFindsNumber = true;
    now = new Date('2026-09-04T00:02:00.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1);
      assert.equal((await restarted.app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
    } finally { await restarted.app.close(); }
  });

  test('撤销已进入人工对账的供应商激活仍继续取消并确认退款', async () => {
    let now = new Date('2026-09-04T00:03:00.000Z');
    const activationId = `revoked-manual-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      const authorization = await database.pool.query<{ id: string }>(
        'SELECT id FROM activation_authorizations WHERE token_suffix = $1', [token.slice(-8)],
      );
      const authorizationId = authorization.rows[0]?.id; assert.ok(authorizationId);
      await database.pool.query(
        `UPDATE supplier_activations
         SET status = 'manual_reconciliation', timed_out_at = $2, cancel_available_at = $2,
             refund_reconciliation_status = 'pending'
         WHERE provider_activation_id = $1`,
        [activationId, now],
      );

      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${authorizationId}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      assert.equal(cancelCalls, 1, '人工对账状态也必须进入管理员撤销专用取消任务');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);

      const state = await database.pool.query<{
        authorization_status: string; ended_reason: string | null; activation_status: string;
        refund_reconciliation_status: string; phone_number: string | null; refund_count: string;
      }>(
        `SELECT auth.status AS authorization_status, auth.ended_reason, activation.status AS activation_status,
                activation.refund_reconciliation_status, activation.phone_number,
                (SELECT count(*)::text FROM supplier_activation_refunds refund WHERE refund.supplier_activation_id = activation.id) AS refund_count
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE auth.id = $1`, [authorizationId],
      );
      assert.deepEqual(state.rows[0], {
        authorization_status: 'ended', ended_reason: 'admin_revoked', activation_status: 'cancelled',
        refund_reconciliation_status: 'resolved', phone_number: null, refund_count: '1',
      });
    } finally { await app.close(); }
  });

  test('撤销取消响应报告短信送达时，接收者仍被断开且不产生后继号码', async () => {
    let now = new Date('2026-09-05T00:02:00.001Z');
    const activationId = `revoked-cancel-sms-${randomUUID()}`;
    let acquiredNumbers = 0;
    let cancellationCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        acquiredNumbers += 1;
        return { activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: new Date('2026-09-05T00:00:00.000Z'), activationEndTime: new Date('2026-09-05T00:20:00.000Z') };
      },
      cancelActivation: async () => { cancellationCalls += 1; return 'sms-delivered'; },
      activationStatus: async () => ({ delivered: true, receivedAt: now, text: '验证码 482913', code: '482913' }),
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancellationCalls, 1);
      assert.equal(acquiredNumbers, 1);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /completion_confirming|completed/);
    } finally { await app.close(); }
  });

  test('撤销确认取消后收到更早短信不保留退款事实', async () => {
    let now = new Date('2026-09-05T01:00:00.000Z');
    const activationId = `revoked-cancelled-before-sms-${randomUUID()}`;
    let cancellationCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { cancellationCalls += 1; return 'cancelled'; },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);

      now = new Date('2026-09-05T01:02:00.000Z');
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${authorizationId}/revoke`, {})).statusCode, 303);
      assert.equal(cancellationCalls, 1);

      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '127.0.0.1',
        payload: {
          activationId, service: 'openai', country: 1,
          receivedAt: '2026-09-05T01:01:00.000Z', text: '验证码 482913', code: '482913',
        },
      });
      assert.equal(webhook.statusCode, 200);
      const state = await database.pool.query<{
        authorization_status: string; activation_status: string; refund_count: string;
        phone_number: string | null; sms_code: string | null; sms_text: string | null;
      }>(
        `SELECT auth.status AS authorization_status, activation.status AS activation_status,
                (SELECT count(*)::text FROM supplier_activation_refunds refund WHERE refund.supplier_activation_id = activation.id) AS refund_count,
                activation.phone_number, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE auth.id = $1`, [authorizationId],
      );
      assert.deepEqual(state.rows[0], {
        authorization_status: 'ended', activation_status: 'completion_confirming', refund_count: '0',
        phone_number: null, sms_code: null, sms_text: null,
      });
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
    } finally { await app.close(); }
  });

  test('管理员撤销待领取授权后，真实链接立即返回 404', async () => {
    let now = new Date('2026-08-18T00:00:00.000Z');
    const { app } = await openApplication(scriptedHeroSms(), () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      const unavailable = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(unavailable.statusCode, 404);

      now = new Date('2026-08-19T00:00:00.001Z');
      const restarted = await openApplication(scriptedHeroSms(), () => now);
      try {
        const stored = await restarted.database.pool.query<{ token_hash: string | null }>('SELECT token_hash FROM activation_authorizations WHERE id = $1', [id]);
        assert.equal(stored.rows[0]?.token_hash, null, '应用重启后的到期扫描应删除已撤销授权的 token 哈希');
      } finally { await restarted.app.close(); }
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${'x'.repeat(43)}` })).statusCode, 404);
    } finally { await app.close(); }
  });

  test('管理员首页和详情分别显示授权、供应商状态以及三次激活的净成本', async () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const links = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      const token = links[0]!;
      const authorization = await database.pool.query<{ id: string }>(
        'SELECT id FROM activation_authorizations WHERE token_suffix = $1', [token.slice(-8)],
      );
      const authorizationId = authorization.rows[0]?.id; assert.ok(authorizationId);
      await database.pool.query("UPDATE activation_authorizations SET status = 'ended', ended_reason = 'acquisition_expired', token_hash = NULL WHERE id = $1", [authorizationId]);
      const activationIds = ['first', 'second', 'third'].map((suffix) => `${suffix}-${randomUUID()}`);
      // 先插入候选地区，满足 supplier_activations 的外键约束
      for (const [index] of activationIds.entries()) {
        await database.pool.query(
          `INSERT INTO authorization_candidate_countries (authorization_id, position, country_id, country_name, used_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [authorizationId, index + 1, index + 1, ['美国', '英国', '法国'][index], now],
        );
      }
      for (const [index, activationId] of activationIds.entries()) {
        await database.pool.query(
          `INSERT INTO supplier_activations
             (authorization_id, candidate_position, country_id, provider_activation_id, status, activation_cost, currency, acquired_at, cancel_available_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $7, $8)`,
          [authorizationId, index + 1, index + 1, activationId, index === 2 ? 'waiting_sms' : 'cancelled', [0.8, 1.25, 2][index], new Date(now.getTime() + index), new Date('2026-09-06T00:20:00.000Z')],
        );
      }
      await database.pool.query(
        "UPDATE supplier_activations SET refund_reconciliation_status = 'pending' WHERE provider_activation_id = $1", [activationIds[0]],
      );
      await database.pool.query(
        "UPDATE supplier_activations SET phone_number = '+14155550123', sms_code = '482913' WHERE provider_activation_id = $1", [activationIds[2]],
      );
      const activationRows = await database.pool.query<{ id: string }>(
        'SELECT id FROM supplier_activations WHERE provider_activation_id = $1', [activationIds[0]],
      );
      await database.pool.query(
        "INSERT INTO supplier_activation_refunds (supplier_activation_id, amount, currency, confirmed_at) VALUES ($1, 0.8, 'USD', $2)",
        [activationRows.rows[0]?.id, now],
      );

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.match(home.body, new RegExp(`data-authorization-id="${authorizationId}"[^>]*>[\\s\\S]*?<span class="authorization-status">已结束</span>`));
      assert.doesNotMatch(home.body, /已到期|等待短信|待处理异常|退款|费用|供应商激活|当前地区/);
      assert.doesNotMatch(home.body, /\+14155550123|482913|短信正文/);
      const eventsBeforeDetail = await database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM lifecycle_events WHERE authorization_id = $1', [authorizationId],
      );
      assert.ok(Number(eventsBeforeDetail.rows[0]?.count) >= 4, '状态变更应留下非敏感生命周期事件');

      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /授权状态：已结束/);
      assert.match(detail.body, /结束原因：领取后期限结束/);
      assert.match(detail.body, /供应商激活/);
      assert.match(detail.body, /first-/);
      assert.match(detail.body, /获取时间 2026-09-06 08:00:00/);
      assert.match(detail.body, /已取消/);
      assert.match(detail.body, /等待短信/);
      assert.match(detail.body, /候选地区/);
      assert.match(detail.body, /获取额度：3\/3/);
      assert.match(detail.body, /累计激活费用：4\.05 USD/);
      assert.match(detail.body, /已确认退款：0\.80 USD/);
      assert.match(detail.body, /净成本：3\.25 USD/);
      assert.match(detail.body, /退款确认待处理/);
      assert.match(detail.body, /完整号码：<\/strong>\+14155550123/);
      assert.match(detail.body, /验证码：<\/strong>482913/);
      const eventsAfterDetail = await database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM lifecycle_events WHERE authorization_id = $1', [authorizationId],
      );
      assert.equal(eventsAfterDetail.rows[0]?.count, eventsBeforeDetail.rows[0]?.count, '读取详情不得写入审计事件');
    } finally { await app.close(); }
  });

  test('库存列表空库显示空状态且无分页控件', async () => {
    const { app, database } = await openApplication();
    await resetAuthorizationTables(database);
    try {
      const session = await login(app);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.equal(home.statusCode, 200);
      assert.match(home.body, /尚未创建激活授权。/);
      assert.doesNotMatch(home.body, /<div class="authorization-list">/);
      assert.doesNotMatch(home.body, /授权列表分页/);
    } finally { await app.close(); }
  });

  test('库存列表每页固定 20 条，覆盖 20、21、40、41 条分页边界', async () => {
    for (const quantity of [20, 21, 40, 41]) {
      const now = new Date('2026-08-01T00:00:00.000Z');
      const { app, database } = await openApplication(scriptedHeroSms(), () => now);
      await resetAuthorizationTables(database);
      try {
        const session = await login(app);
        const created = await createBatch(app, session, String(quantity));
        assert.equal(created.statusCode, 201);
        const links = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
        assert.equal(links.length, quantity);
        const expectedSuffixes = new Set(links.map((link) => link.slice(-8)));
        const totalPages = Math.ceil(quantity / 20);
        const lastPageSize = quantity % 20 === 0 ? 20 : quantity % 20;

        const first = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
        assert.equal(first.statusCode, 200);
        const firstArticles = listArticles(first.body);
        assert.equal(firstArticles.length, Math.min(20, quantity), `首页应展示 ${Math.min(20, quantity)} 条`);
        assert.match(first.body, new RegExp(`第 1 / ${totalPages} 页`));
        assert.match(first.body, /class="pagination-previous disabled" aria-disabled="true"/);
        if (totalPages > 1) {
          assert.match(first.body, new RegExp(`class="pagination-next" href="/${config.adminPath}\\?page=2"`));
        } else {
          assert.match(first.body, /class="pagination-next disabled" aria-disabled="true"/);
        }
        const repeated = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
        assert.deepEqual(listArticles(repeated.body).map((article) => article.suffix), firstArticles.map((article) => article.suffix), '分页列表顺序应稳定');

        const seen = new Set<string>();
        for (const article of firstArticles) {
          assert.match(article.suffix, /^[A-Za-z0-9_-]{8}$/);
          assert.equal(article.status, '待领取');
          assert.ok(expectedSuffixes.has(article.suffix));
          assert.ok(!seen.has(article.suffix), `后缀 ${article.suffix} 在分页中重复`);
          seen.add(article.suffix);
        }

        if (totalPages > 1) {
          for (let page = 2; page <= totalPages; page += 1) {
            const response = await app.inject({ method: 'GET', url: `/${config.adminPath}?page=${page}`, headers: { cookie: session.cookie } });
            assert.equal(response.statusCode, 200);
            const articles = listArticles(response.body);
            assert.equal(articles.length, page === totalPages ? lastPageSize : 20, `第 ${page} 页应展示 ${page === totalPages ? lastPageSize : 20} 条`);
            assert.match(response.body, new RegExp(`第 ${page} / ${totalPages} 页`));
            // 第 2 页的上一页回到无参数的默认列表，更靠后的页保留页码
            assert.match(response.body, page === 2
              ? /class="pagination-previous" href="\/control7">/
              : /class="pagination-previous" href="\/control7\?page=\d+">/);
            if (page === totalPages) {
              assert.match(response.body, /class="pagination-next disabled" aria-disabled="true"/);
            } else {
              assert.match(response.body, /class="pagination-next" href="\/control7\?page=\d+"/);
            }
            for (const article of articles) {
              assert.ok(expectedSuffixes.has(article.suffix), `页面不应出现未知后缀 ${article.suffix}`);
              assert.ok(!seen.has(article.suffix), `后缀 ${article.suffix} 在分页中重复`);
              seen.add(article.suffix);
            }
          }
          // 越界页码钳制到最后一页
          const clamped = await app.inject({ method: 'GET', url: `/${config.adminPath}?page=999`, headers: { cookie: session.cookie } });
          assert.equal(clamped.statusCode, 200);
          assert.equal(listArticles(clamped.body).length, lastPageSize);
          assert.match(clamped.body, new RegExp(`第 ${totalPages} / ${totalPages} 页`));
        }
        assert.equal(seen.size, quantity, '所有记录都应恰好出现一次');
      } finally { await app.close(); }
    }
  });

  test('库存列表四个顶层状态筛选并展示记录', async () => {
    const { app, database } = await openApplication();
    await resetAuthorizationTables(database);
    try {
      const session = await login(app);
      const created = await createBatch(app, session, '4');
      assert.equal(created.statusCode, 201);
      const links = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(links.length, 4);
      const transitions: Array<[string, string]> = [
        ['in_progress', links[0]!], ['result_available', links[1]!], ['ended', links[2]!],
      ];
      for (const [status, link] of transitions) {
        const updated = await database.pool.query('UPDATE activation_authorizations SET status = $2 WHERE token_suffix = $1', [link.slice(-8), status]);
        assert.equal(updated.rowCount, 1);
      }

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.equal(home.statusCode, 200);
      assert.equal(listArticles(home.body).length, 4);
      assert.doesNotMatch(home.body, /供应商激活|累计激活费用|已确认退款|净成本|短信正文|待处理异常|等待短信|\+14155550123|482913/);

      const assertFilter = async (status: string, expectedSuffixes: string[], expectedStatusLabel: string): Promise<void> => {
        const response = await app.inject({ method: 'GET', url: `/${config.adminPath}?status=${status}`, headers: { cookie: session.cookie } });
        assert.equal(response.statusCode, 200);
        const articles = listArticles(response.body);
        assert.deepEqual(new Set(articles.map((article) => article.suffix)), new Set(expectedSuffixes), `状态 ${status} 应命中 ${expectedSuffixes.length} 条`);
        assert.ok(articles.every((article) => article.status === expectedStatusLabel), `状态 ${status} 应显示 ${expectedStatusLabel}`);
        assert.match(response.body, new RegExp(`<option value="${status}" selected>`));
      };
      await assertFilter('unclaimed', [links[3]!.slice(-8)], '待领取');
      await assertFilter('in_progress', [links[0]!.slice(-8)], '进行中');
      await assertFilter('result_available', [links[1]!.slice(-8)], '结果可查看');
      await assertFilter('ended', [links[2]!.slice(-8)], '已结束');
    } finally { await app.close(); }
  });

  test('库存列表按末 8 位大小写敏感精确搜索，接收者标识不能命中', async () => {
    const { app, database } = await openApplication();
    await resetAuthorizationTables(database);
    try {
      const session = await login(app);
      const created = await createBatch(app, session, '3');
      assert.equal(created.statusCode, 201);
      const links = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(links.length, 3);
      // 改写后缀以精确控制大小写差异（Base64URL 实际字符，不做模糊匹配）
      const suffixes = ['AAAA1111', 'aaaa1111', 'BBBB2222'];
      for (const [index, link] of links.entries()) {
        const updated = await database.pool.query('UPDATE activation_authorizations SET token_suffix = $2 WHERE token_suffix = $1', [link.slice(-8), suffixes[index]!]);
        assert.equal(updated.rowCount, 1);
      }

      const search = async (suffix: string): Promise<InjectionResponse> =>
        app.inject({ method: 'GET', url: `/${config.adminPath}?suffix=${suffix}`, headers: { cookie: session.cookie } });

      const upper = await search('AAAA1111');
      assert.equal(upper.statusCode, 200);
      assert.deepEqual(listArticles(upper.body).map((article) => article.suffix), ['AAAA1111']);

      // 大小写敏感：小写变体命中不同记录，混合大小写命中不了任何记录
      const lower = await search('aaaa1111');
      assert.deepEqual(listArticles(lower.body).map((article) => article.suffix), ['aaaa1111']);
      const mixedCase = await search('AAAa1111');
      assert.equal(listArticles(mixedCase.body).length, 0);
      assert.match(mixedCase.body, /没有符合条件的激活授权。/);

      const other = await search('BBBB2222');
      assert.deepEqual(listArticles(other.body).map((article) => article.suffix), ['BBBB2222']);

      // 其他文本标识不能命中末 8 位搜索
      const individual = await createAuthorization(app, session);
      assert.equal(individual.statusCode, 201);
      const byIdentifier = await search('ABCD1234');
      assert.equal(listArticles(byIdentifier.body).length, 0);
      assert.match(byIdentifier.body, /没有符合条件的激活授权。/);

      // 搜索与状态筛选组合保留
      const combined = await app.inject({ method: 'GET', url: `/${config.adminPath}?status=unclaimed&suffix=AAAA1111`, headers: { cookie: session.cookie } });
      assert.deepEqual(listArticles(combined.body).map((article) => article.suffix), ['AAAA1111']);
    } finally { await app.close(); }
  });

  test('库存列表按最近活动倒序与稳定次级排序，只读详情不重排', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => now);
    await resetAuthorizationTables(database);
    try {
      const session = await login(app);
      const created = await createBatch(app, session, '3');
      assert.equal(created.statusCode, 201);
      const links = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(links.length, 3);
      const [oldest, middle, newest] = links.map((link) => link.slice(-8));
      const base = new Date('2026-08-01T00:00:00.000Z');
      await database.pool.query('UPDATE activation_authorizations SET last_activity_at = $2 WHERE token_suffix = $1', [newest!, new Date(base.getTime() + 30 * 60 * 1000)]);
      await database.pool.query('UPDATE activation_authorizations SET last_activity_at = $2 WHERE token_suffix = $1', [middle!, new Date(base.getTime() + 20 * 60 * 1000)]);
      // oldest 保持 last_activity_at = created_at，验证缺失活动时间回落到创建时间

      const first = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.equal(first.statusCode, 200);
      assert.deepEqual(listArticles(first.body).map((article) => article.suffix), [newest, middle, oldest]);

      // 读取只读详情不得重排列表，也不得推进活动时间
      const oldestArticle = listArticles(first.body).find((article) => article.suffix === oldest); assert.ok(oldestArticle);
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${oldestArticle.id}`, headers: { cookie: session.cookie } });
      assert.equal(detail.statusCode, 200);
      const second = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.deepEqual(listArticles(second.body).map((article) => article.suffix), [newest, middle, oldest]);
      const stored = await database.pool.query<{ last_activity_at: Date | null }>('SELECT last_activity_at FROM activation_authorizations WHERE token_suffix = $1', [oldest]);
      assert.equal(stored.rows[0]?.last_activity_at?.toISOString(), base.toISOString(), '只读详情不得推进活动时间');

      // 相同最近活动时间的记录按稳定次级键排序，两次查询顺序一致
      const secondBatch = await createBatch(app, session, '3');
      assert.equal(secondBatch.statusCode, 201);
      const secondLinks = [...secondBatch.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(secondLinks.length, 3);
      const tie = new Date('2026-08-01T02:00:00.000Z');
      for (const link of secondLinks) {
        await database.pool.query('UPDATE activation_authorizations SET last_activity_at = $2 WHERE token_suffix = $1', [link.slice(-8), tie]);
      }
      const third = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const thirdSuffixes = listArticles(third.body).map((article) => article.suffix);
      assert.equal(thirdSuffixes.length, 6);
      assert.deepEqual(new Set(thirdSuffixes.slice(0, 3)), new Set(secondLinks.map((link) => link.slice(-8))));
      assert.deepEqual(thirdSuffixes.slice(3), [newest, middle, oldest]);
      const fourth = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.deepEqual(listArticles(fourth.body).map((article) => article.suffix), thirdSuffixes);
    } finally { await app.close(); }
  });

  test('关键业务事实推进库存活动时间，轮询与无新事实重试不推进', async () => {
    let now = new Date('2026-08-09T00:00:00.000Z');
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => ({
        activationId: `fact-advance-${countryId}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    await resetAuthorizationTables(database);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const idResult = await database.pool.query<{ id: string }>('SELECT id FROM activation_authorizations WHERE token_suffix = $1', [token.slice(-8)]);
      const authorizationId = idResult.rows[0]?.id; assert.ok(authorizationId);
      const activityAt = async (): Promise<string> => {
        const result = await database.pool.query<{ last_activity_at: Date | null }>('SELECT last_activity_at FROM activation_authorizations WHERE id = $1', [authorizationId]);
        const value = result.rows[0]?.last_activity_at; assert.ok(value);
        return value.toISOString();
      };
      assert.equal(await activityAt(), '2026-08-09T00:00:00.000Z', '创建是初始业务事实');

      // 领取并成功取得供应商激活（真实业务事实）推进活动时间
      now = new Date('2026-08-09T00:01:00.000Z');
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      assert.equal(await activityAt(), '2026-08-09T00:01:00.000Z', '领取与号码取得应推进活动时间');

      // 有效短信送达（真实业务事实）推进活动时间
      now = new Date('2026-08-09T00:02:00.000Z');
      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId: 'fact-advance-1', service: 'openai', country: 1, receivedAt: now.toISOString(), code: '482913', text: 'Your code is 482913' },
      });
      assert.equal(webhook.statusCode, 200);
      // 送达后的完成确认是后台异步任务（setImmediate），等待其落定后再断言，避免竞态
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await activityAt(), '2026-08-09T00:02:00.000Z', '短信送达应推进活动时间');

      // 无新事实的换号重试与只读访问不得推进活动时间
      now = new Date('2026-08-09T00:02:30.000Z');
      const replacement = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacement.statusCode, 409);
      const readDetail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.equal(readDetail.statusCode, 200);
      const readList = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.equal(readList.statusCode, 200);
      assert.equal(await activityAt(), '2026-08-09T00:02:00.000Z', '轮询与无新事实重试不得推进活动时间');

      // 管理员撤销（真实业务事实）推进活动时间
      now = new Date('2026-08-09T00:05:00.000Z');
      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${authorizationId}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      assert.equal(await activityAt(), '2026-08-09T00:05:00.000Z', '撤销应推进活动时间');
    } finally { await app.close(); }
  });

  test('旧撤销历史缺少后缀时展示未知标记，不伪造后缀也不恢复访问能力', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => now);
    await resetAuthorizationTables(database);
    try {
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const suffix = token.slice(-8);
      // 模拟旧模型撤销历史：没有保存后缀，也没有任何访问凭据
      const updated = await database.pool.query(
        "UPDATE activation_authorizations SET token_suffix = NULL, token_hash = NULL, status = 'ended', ended_at = $2, ended_reason = 'admin_revoked' WHERE token_suffix = $1",
        [suffix, now],
      );
      assert.equal(updated.rowCount, 1);
      const idResult = await database.pool.query<{ id: string }>('SELECT id FROM activation_authorizations WHERE token_hash IS NULL AND status = \'ended\' LIMIT 1');
      const authorizationId = idResult.rows[0]?.id; assert.ok(authorizationId);

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.equal(home.statusCode, 200);
      const articles = listArticles(home.body);
      assert.equal(articles.length, 1);
      assert.equal(articles[0]?.suffix, '链接末 8 位未知', '不得伪造缺失的后缀');
      assert.equal(articles[0]?.status, '已结束');
      assert.ok([...home.body.matchAll(/href="([^"]+)"/g)].every((match) => !match[1]!.includes('/a/')), '列表不得提供公开链接入口');

      // 详情页仍可打开，同样不伪造后缀
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.equal(detail.statusCode, 200);
      assert.match(detail.body, /链接末 8 位：未知/);
    } finally { await app.close(); }
  });

  test('按生命周期裁剪管理员详情：覆盖待领取、进行中、结果可查看、额度用尽、期限结束和管理员撤销详情', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => now);
    await resetAuthorizationTables(database);
    await database.replaceDefaultCandidateLocations([
      { countryId: 1, countryName: '美国' },
      { countryId: 2, countryName: '英国' },
      { countryId: 3, countryName: '法国' },
    ]);
    try {
      const session = await login(app);

      // 1. 待领取详情 (unclaimed)
      const created = await createBatch(app, session, '1');
      assert.equal(created.statusCode, 201);
      const token1 = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token1);
      const suffix1 = token1.slice(-8);
      const home1 = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id1 = authorizationIdFromHome(home1.body, token1);

      const detail1 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id1}`, headers: { cookie: session.cookie } });
      assert.equal(detail1.statusCode, 200);
      assert.match(detail1.body, new RegExp(`链接末 8 位：${suffix1}`));
      assert.match(detail1.body, /授权状态：待领取/);
      assert.match(detail1.body, /创建时间/);
      assert.match(detail1.body, /撤销授权/);
      assert.doesNotMatch(detail1.body, /候选地区|供应商激活|成本|获取额度|新号码获取截止时间|授权到期时间|领取时间|尚无/);
      assert.doesNotMatch(detail1.body, new RegExp(token1));

      // 2. 进行中详情 (in_progress)
      const claimRes = await app.inject({
        method: 'POST', url: `/a/${token1}/numbers`,
      });
      assert.equal(claimRes.statusCode, 303);

      const detail2 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id1}`, headers: { cookie: session.cookie } });
      assert.equal(detail2.statusCode, 200);
      assert.match(detail2.body, /授权状态：进行中/);
      assert.match(detail2.body, /创建时间/);
      assert.match(detail2.body, /领取时间/);
      assert.match(detail2.body, /新号码获取截止时间/);
      assert.match(detail2.body, /获取额度：1\/3/);
      assert.match(detail2.body, /候选地区/);
      assert.match(detail2.body, /位置 1（美国）：<\/strong>已消耗/);
      assert.doesNotMatch(detail2.body, /报价|预检价格|库存/);
      assert.match(detail2.body, /撤销授权/);

      // 3. 结果可查看详情 (result_available)
      const actRes = await database.pool.query<{ provider_activation_id: string }>(
        'SELECT provider_activation_id FROM supplier_activations WHERE authorization_id = $1 ORDER BY acquired_at DESC LIMIT 1', [id1],
      );
      const actId = actRes.rows[0]?.provider_activation_id; assert.ok(actId);
      const webhookRes = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId: actId, service: 'openai', country: 1, receivedAt: '2026-08-01T00:05:00.000Z', code: '654321', text: 'Your code is 654321' },
      });
      assert.equal(webhookRes.statusCode, 200);

      const detail3 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id1}`, headers: { cookie: session.cookie } });
      assert.equal(detail3.statusCode, 200);
      assert.match(detail3.body, /授权状态：结果可查看/);
      assert.match(detail3.body, /完整号码：/);
      assert.match(detail3.body, /验证码：/);
      assert.match(detail3.body, /654321/);
      assert.match(detail3.body, /撤销授权/);

      // 4. 管理员撤销详情 (admin_revoked)
      const revokeRes = await post(app, session, `/${config.adminPath}/authorizations/${id1}/revoke`, {});
      assert.equal(revokeRes.statusCode, 303);
      const detail4 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id1}`, headers: { cookie: session.cookie } });
      assert.equal(detail4.statusCode, 200);
      assert.match(detail4.body, /授权状态：已结束/);
      assert.match(detail4.body, /结束原因：管理员撤销/);
      assert.doesNotMatch(detail4.body, /撤销授权/);
      assert.doesNotMatch(detail4.body, /654321/);

      // 5. 额度用尽详情 (quota_exhausted)
      const createdB = await createBatch(app, session, '1');
      const tokenB = createdB.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(tokenB);
      const homeB = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const idB = authorizationIdFromHome(homeB.body, tokenB);
      await database.pool.query(
        "UPDATE activation_authorizations SET status = 'ended', claimed_at = $2, ended_at = $2, ended_reason = 'quota_exhausted' WHERE id = $1",
        [idB, now],
      );
      for (let pos = 1; pos <= 3; pos++) {
        await database.pool.query(
          "INSERT INTO authorization_candidate_countries (authorization_id, position, country_id, country_name, used_at) VALUES ($1, $2, 1, '美国', $3)",
          [idB, pos, now],
        );
      }
      const detail5 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${idB}`, headers: { cookie: session.cookie } });
      assert.equal(detail5.statusCode, 200);
      assert.match(detail5.body, /授权状态：已结束/);
      assert.match(detail5.body, /结束原因：获取额度用尽/);
      assert.match(detail5.body, /获取额度：3\/3/);
      assert.doesNotMatch(detail5.body, /撤销授权/);

      // 6. 期限结束详情 (acquisition_expired)
      const createdC = await createBatch(app, session, '1');
      const tokenC = createdC.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(tokenC);
      const homeC = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const idC = authorizationIdFromHome(homeC.body, tokenC);
      const claimC = await app.inject({ method: 'POST', url: `/a/${tokenC}/numbers` });
      assert.ok([200, 202, 303].includes(claimC.statusCode));
      const cookC = `recipient_session=${cookieValue(claimC, 'recipient_session')}`;
      await database.pool.query(
        "UPDATE activation_authorizations SET status = 'ended', ended_at = $2, ended_reason = 'acquisition_expired' WHERE token_hash = $1",
        [createHash('sha256').update(tokenC).digest('hex'), now],
      );
      const detail6 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${idC}`, headers: { cookie: session.cookie } });
      assert.equal(detail6.statusCode, 200);
      assert.match(detail6.body, /授权状态：已结束/);
      assert.match(detail6.body, /结束原因：领取后期限结束/);
      assert.doesNotMatch(detail6.body, /撤销授权/);
    } finally { await app.close(); }
  });
}
