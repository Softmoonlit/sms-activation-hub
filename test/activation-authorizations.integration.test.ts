import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp, type AppDependencies } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import { ActivationAuthorizations, type HeroSmsWebhookEvent } from '../src/activation-authorizations.js';
import { HeroSmsResponseError, type HeroSms, type HeroSmsActivationRecord, type HeroSmsNumber, type HeroSmsOffer } from '../src/herosms.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://test.example';
const config: AppConfig = {
  adminPassword: 'correct-deployment-password', adminPath: 'control7', databaseUrl: databaseUrl ?? '',
  heroSmsApiKey: 'test-api-key', heroSmsWebhookAllowedIps: ['127.0.0.1'], heroSmsWebhookPath: 'test-webhook-secret-path-1234567890', heroSmsWebhookRequestsPerMinute: 120,
  loginMaxAttempts: 3, loginWindowSeconds: 900, openAiServiceCode: 'openai',
  port: 3001, publicOrigin: origin, sessionSecret: 'test-session-secret-that-is-at-least-32-characters', trustedProxy: false,
};

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

function scriptedHeroSms(overrides: Partial<{
  balance: number | HeroSms['balance'];
  stock: number;
  services: HeroSms['services'];
  countries: HeroSms['countries'];
  offers: HeroSms['offers'];
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
    offers: overrides.offers ?? (async (): Promise<HeroSmsOffer[]> => [
      { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: overrides.stock ?? 3, map: { '0.08': overrides.stock ?? 3 } },
      { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 2, map: { '0.09': 2 } },
      { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 1, map: { '0.10': 1 } },
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
  const activationAuthorizations = new ActivationAuthorizations(database, heroSms, config.openAiServiceCode, now, extraDependencies.tokenGenerator);
  const app = await createApp({ ...config, sessionSecret: `${config.sessionSecret}-${randomUUID()}` }, database, { heroSms, now, ...extraDependencies });
  await database.saveCandidateSettings([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ], 0.11);
  return { app, database, activationAuthorizations };
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
    await client.query(`
      DO $$
      DECLARE
        t text;
      BEGIN
        FOR t IN SELECT unnest(ARRAY[
          'lifecycle_events',
          'supplier_activation_refunds',
          'supplier_activations',
          'number_acquisition_candidates',
          'number_acquisition_requests',
          'authorization_candidate_countries',
          'activation_authorizations'
        ])
        LOOP
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = t) THEN
            EXECUTE 'DELETE FROM ' || quote_ident(t);
          END IF;
        END LOOP;
      END $$;
    `);
  });
}

/** 在打开应用前清空共享数据库，避免前序测试残留记录被启动任务（轮询、对账）处理而污染计数断言。 */
async function resetTablesBeforeApplication(): Promise<void> {
  const database = new Database(databaseUrl!);
  try {
    await resetAuthorizationTables(database);
  } finally {
    await database.close();
  }
}

/** 轮询等待真实定时器触发的异步条件；预算必须远小于 60 秒后台扫描周期，确保对账来自专用调度器。 */
async function waitFor(condition: () => boolean, timeoutMs: number, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`等待条件在 ${timeoutMs}ms 内未满足`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 等待条件成立或预算耗尽，均不抛错；用于断言“修复前会发生、修复后不应发生”的竞态窗口。 */
async function waitOrTimeout(condition: () => boolean, timeoutMs: number, intervalMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

/** 捕获 run 执行期间的 stdout 输出（含直接写入 process.stdout 的极简日志），用于断言日志级别与去向。 */
async function withCapturedStdout<T>(run: () => Promise<T>): Promise<{ value: T; output: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await run(), output: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
  }
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
      offers: async () => { providerCalls += 1; throw new Error('批量创建不应读取报价'); },
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
        claimed_at: Date | null;
      }>(
        'SELECT token_hash, token_suffix, claimed_at FROM activation_authorizations WHERE token_suffix = ANY($1::text[])',
        [links.map((link) => link.slice(-8))],
      );
      assert.equal(stored.rows.length, 10);
      assert.ok(stored.rows.every((row) => row.token_hash && row.token_suffix && row.claimed_at === null));
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

  test('批量链接 GET 不领取，首次 POST 原子领取并允许通过授权链接继续使用', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    let offersCalls = 0;
    const heroSms = scriptedHeroSms({
      offers: async () => {
        offersCalls += 1;
        throw new Error('领取后实时查询暂时失败');
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 1, countryName: '美国' },
      ], 0.11);
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);

      const preview = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(preview.statusCode, 200);
      assert.match(preview.body, /<h1>OpenAI<\/h1>/);
      assert.match(preview.body, /获取号码/);
      assert.doesNotMatch(preview.body, /剩余号码获取额度/);
      assert.doesNotMatch(preview.body.replace('实际能否获取取决于供应商库存', ''), /链接剩余时间|候选地区|价格|库存|HeroSMS|供应商|期限|授权/);

      const claim = await app.inject({ method: 'POST', url: `/a/${token}` + '/numbers', headers: { cookie: 'irrelevant=stale-client-value' } });
      assert.equal(claim.statusCode, 503);
      assert.match(claim.body, /暂时无法获取号码，请联系发送者/);
      assert.match(claim.body, /获取号码后，请在 24 小时内使用/);
      assert.match(claim.body, /剩余号码获取额度：3 · 实际能否获取取决于供应商库存/);
      assert.doesNotMatch(claim.body, /链接剩余时间/);
      assert.doesNotMatch(claim.body, /授权/);
      assert.equal(claim.cookies.find((cookie) => cookie.name === 'recipient_session'), undefined);

      const authorization = await database.pool.query<{
        status: string; claimed_at: Date | null; number_acquisition_expires_at: Date | null;
      }>(
        'SELECT status, claimed_at, number_acquisition_expires_at FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.equal(authorization.rows.length, 1);
      assert.equal(authorization.rows[0]?.status, 'in_progress');
      assert.equal(authorization.rows[0]?.claimed_at?.toISOString(), now.toISOString());
      assert.equal(authorization.rows[0]?.number_acquisition_expires_at?.toISOString(), new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());

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

      await database.saveCandidateSettings([
        { countryId: 3, countryName: '法国' },
        { countryId: 3, countryName: '法国' },
        { countryId: 2, countryName: '英国' },
      ], 0.11);
      now = new Date('2026-08-01T01:00:00.000Z');
      const retry = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(retry.statusCode, 503);
      assert.equal(retry.cookies.find((cookie) => cookie.name === 'recipient_session'), undefined);
      assert.equal(offersCalls, 2);
      const otherBrowserPost = await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: 'irrelevant=other-browser' } });
      assert.equal(otherBrowserPost.statusCode, 503);
      assert.match(otherBrowserPost.body, /暂时无法获取号码，请联系发送者/);
      assert.equal(otherBrowserPost.cookies.find((cookie) => cookie.name === 'recipient_session'), undefined);
      assert.equal(offersCalls, 3);
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
      const expired = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(expired.statusCode, 404);
      const expiredAuthorization = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null }>(
        'SELECT status, ended_reason, token_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.deepEqual(expiredAuthorization.rows[0], { status: 'ended', ended_reason: 'acquisition_expired', token_hash: null });
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('后台配置变更只影响尚未领取授权，领取时复制完整动态额度', async () => {
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 0, map: { '0.08': 0 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 0, map: { '0.09': 0 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 0, map: { '0.10': 0 } },
      ],
      getNumber: async () => { throw new Error('零库存不应请求号码'); },
    });
    const { app, database } = await openApplication(heroSms, () => new Date('2026-08-01T00:00:00.000Z'));
    try {
      const session = await login(app);
      const created = await createBatch(app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]!);
      assert.equal(tokens.length, 2);

      const saveEight = await post(app, session, `/${config.adminPath}/settings`, {
        candidateCount: '8',
        maxPricePerNumber: '0.11',
        ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`candidate${index + 1}`, String(index % 3 + 1)])),
      });
      assert.equal(saveEight.statusCode, 303);
      const firstClaim = await app.inject({ method: 'POST', url: `/a/${tokens[0]}/numbers` });
      assert.equal(firstClaim.statusCode, 409);
      assert.match(firstClaim.body, /剩余号码获取额度：8/);

      const saveTen = await post(app, session, `/${config.adminPath}/settings`, {
        candidateCount: '10',
        maxPricePerNumber: '0.11',
        ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`candidate${index + 1}`, String((index + 1) % 3 + 1)])),
      });
      assert.equal(saveTen.statusCode, 303);
      const secondClaim = await app.inject({ method: 'POST', url: `/a/${tokens[1]}/numbers` });
      assert.equal(secondClaim.statusCode, 409);
      assert.match(secondClaim.body, /剩余号码获取额度：10/);

      const copied = await database.pool.query<{ token_suffix: string; positions: number[]; country_ids: number[] }>(
        `SELECT auth.token_suffix,
                array_agg(candidate.position ORDER BY candidate.position)::int[] AS positions,
                array_agg(candidate.country_id ORDER BY candidate.position)::int[] AS country_ids
         FROM activation_authorizations auth
         JOIN authorization_candidate_countries candidate ON candidate.authorization_id = auth.id
         WHERE auth.token_suffix = ANY($1::text[])
         GROUP BY auth.token_suffix`,
        [tokens.map((token) => token.slice(-8))],
      );
      const copiedBySuffix = new Map(copied.rows.map((row) => [row.token_suffix, row]));
      assert.deepEqual(copiedBySuffix.get(tokens[0]!.slice(-8))?.positions, [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.deepEqual(copiedBySuffix.get(tokens[0]!.slice(-8))?.country_ids, [1, 2, 3, 1, 2, 3, 1, 2]);
      assert.deepEqual(copiedBySuffix.get(tokens[1]!.slice(-8))?.positions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.deepEqual(copiedBySuffix.get(tokens[1]!.slice(-8))?.country_ids, [2, 3, 1, 2, 3, 1, 2, 3, 1, 2]);
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
      offers: async (): Promise<HeroSmsOffer[]> => { providerCalls += 1; return [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 1, map: { '0.08': 1 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 1, map: { '0.09': 1 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 1, map: { '0.10': 1 } },
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
        status: string; claimed_at: Date | null; number_acquisition_expires_at: Date | null;
      }>(
        'SELECT status, claimed_at, number_acquisition_expires_at FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.deepEqual(authorization.rows[0], {
        status: 'unclaimed', claimed_at: null, number_acquisition_expires_at: null,
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

      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.11);
      now = new Date('2026-08-02T00:01:00.000Z');
      const repaired = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(repaired.statusCode, 303);
      assert.equal(repaired.cookies.find((cookie) => cookie.name === 'recipient_session'), undefined);
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

  test('同一授权链接并发领取只初始化一次并只获取一个号码', async () => {
    let now = new Date('2026-08-03T00:00:00.000Z');
    const heroSms = scriptedHeroSms();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.11);
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);

      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: `/a/${token}/numbers` }),
        app.inject({ method: 'POST', url: `/a/${token}/numbers` }),
      ]);
      const responses = [first, second];
      assert.equal(responses.filter((response) => response.statusCode === 303).length, 2);
      assert.ok(responses.every((response) => response.cookies.find((cookie) => cookie.name === 'recipient_session') === undefined));
      const recipientPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: 'irrelevant=other-browser' } });
      assert.equal(recipientPage.statusCode, 200);
      assert.match(recipientPage.body, /号码有效至/);
      assert.doesNotMatch(recipientPage.body, /获取号码后，请在 24 小时内使用|链接剩余时间/);
      assert.doesNotMatch(recipientPage.body, /授权/);

      const authorization = await database.pool.query<{
        status: string; claimed_at: Date | null; number_acquisition_expires_at: Date | null;
      }>(
        'SELECT status, claimed_at, number_acquisition_expires_at FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.deepEqual({
        status: authorization.rows[0]?.status,
        claimed_at: authorization.rows[0]?.claimed_at,
        number_acquisition_expires_at: authorization.rows[0]?.number_acquisition_expires_at,
      }, {
        status: 'in_progress', claimed_at: now,
        number_acquisition_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
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

      const competingGet = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: 'irrelevant=third-browser' } });
      assert.equal(competingGet.statusCode, 200);
      assert.match(competingGet.body, /号码有效至/);
    } finally {
      await cleanupBatchAuthorizations(database);
      await app.close();
    }
  });

  test('同一授权链接并发换号只取消一次当前激活并只取得一个后继号码', async () => {
    let now = new Date('2026-08-15T00:00:00.000Z');
    const firstActivationId = `concurrent-replacement-${randomUUID()}`;
    const secondActivationId = `concurrent-replacement-next-${randomUUID()}`;
    let getNumberCalls = 0;
    let cancelCalls = 0;
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => { markCancellationStarted = resolve; });
    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? firstActivationId : secondActivationId,
          phoneNumber: getNumberCalls === 1 ? '+14155550123' : '+442079460123',
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async (activationId) => {
        assert.equal(activationId, firstActivationId, '换号只能取消当前激活');
        cancelCalls += 1;
        markCancellationStarted();
        await cancellationReleased;
        return 'cancelled';
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const acquired = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(acquired.statusCode, 303);
      assert.equal(getNumberCalls, 1);

      now = new Date('2026-08-15T00:02:00.000Z');
      // 第一个请求取得取消状态转换后确定性阻塞在供应商取消调用上，
      // 确保第二个请求到达时状态转换已提交但供应商调用尚未完成，不依赖任意延时。
      const first = app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      await cancellationStarted;
      assert.equal(cancelCalls, 1);

      const second = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(second.statusCode, 409, '竞争请求必须收到明确冲突响应');
      // 冲突页面提示换号仍在进行中：当前激活已被胜出请求转态，页面状态已经变化。
      assert.match(second.body, /正在更换号码/);
      assert.equal(cancelCalls, 1, '竞争请求不得重复调用供应商取消');
      assert.equal(getNumberCalls, 1, '竞争请求不得消耗候选位置');

      releaseCancellation();
      const won = await first;
      assert.equal(won.statusCode, 303, '胜出请求完成换号并重定向');
      assert.equal(cancelCalls, 1);
      assert.equal(getNumberCalls, 2);

      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /20 7946 0123/);
      assert.match(page.body, /剩余号码获取额度：1 · 实际能否获取取决于供应商库存/);

      const activations = await database.pool.query<{ provider_activation_id: string; status: string }>(
        `SELECT provider_activation_id, status FROM supplier_activations
         WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)
         ORDER BY acquired_at`,
        [token.slice(-8)],
      );
      assert.deepEqual(activations.rows, [
        { provider_activation_id: firstActivationId, status: 'cancelled' },
        { provider_activation_id: secondActivationId, status: 'waiting_sms' },
      ]);
      const candidates = await database.pool.query<{ used: string; total: string }>(
        `SELECT count(*) FILTER (WHERE used_at IS NOT NULL)::text AS used, count(*)::text AS total
         FROM authorization_candidate_countries
         WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)`,
        [token.slice(-8)],
      );
      assert.deepEqual(candidates.rows[0], { used: '2', total: '3' }, '并发换号恰好消耗两个候选位置');
      const activeCount = await database.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM supplier_activations
         WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)
           AND status IN ('acquisition_confirming', 'waiting_sms', 'cancellation_confirming', 'manual_reconciliation', 'sms_delivered', 'completion_confirming')`,
        [token.slice(-8)],
      );
      assert.equal(activeCount.rows[0]?.count, '1', '并发换号后仍只有一个当前激活');
      const authorization = await database.pool.query<{ status: string }>(
        'SELECT status FROM activation_authorizations WHERE token_suffix = $1', [token.slice(-8)],
      );
      assert.equal(authorization.rows[0]?.status, 'in_progress');
    } finally {
      releaseCancellation();
      await resetAuthorizationTables(database);
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
      assert.match(detail.body, /授权状态：📋 待领取/);
      assert.match(detail.body, /创建时间/);
      assert.doesNotMatch(detail.body, /获取额度|候选地区|供应商激活|成本|新号码获取截止时间|结束原因|结束时间|领取时间/);

      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。/);
      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      const repeated = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(repeated.statusCode, 409);
      const stored = await database.pool.query<{
        token_hash: string | null; status: string; ended_reason: string | null;
        candidate_count: string;
      }>(
        `SELECT auth.token_hash, auth.status, auth.ended_reason,
                (SELECT count(*)::text FROM authorization_candidate_countries candidate WHERE candidate.authorization_id = auth.id) AS candidate_count
         FROM activation_authorizations auth WHERE auth.id = $1`, [id],
      );
      assert.deepEqual(stored.rows[0], { token_hash: null, status: 'ended', ended_reason: 'admin_revoked', candidate_count: '0' });
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
      assert.match(firstGet.body, /获取号码后，请在 24 小时内使用/);
      assert.doesNotMatch(firstGet.body, /链接剩余时间/);
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
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ], 0.11);
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
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ], 0.11);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      assert.equal(created.statusCode, 201);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      for (const minute of [2, 4]) {
        now = new Date(`2026-08-01T00:0${minute}:00.000Z`);
        const replaced: InjectionResponse = await app.inject({
          method: 'POST', url: `/a/${token}/replacement/confirm`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'replacement=confirm',
        });
        assert.equal(replaced.statusCode, 303);
      }

      assert.deepEqual(acquiredCountries, [1, 1, 1]);
      const recipientPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(recipientPage.body, /剩余号码获取额度：0/);
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
      offers: async () => { providerCalls += 1; throw new Error('报价查询失败'); },
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

  test('首次领取按候选位置顺序尝试，明确无库存失败不消耗位置并可通过授权链接恢复', async () => {
    const fixedNow = new Date('2026-08-01T00:00:00.000Z');
    const attemptedCountries: number[] = [];
    const activationId = `act-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 2, map: { '0.08': 2 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 1, map: { '0.09': 1 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 3, map: { '0.10': 3 } },
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
      assert.doesNotMatch(initial.body, /剩余号码获取额度/);
      assert.doesNotMatch(initial.body, /美国|英国|法国|HeroSMS|价格/);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      assert.deepEqual(attemptedCountries, [1, 2], '应按候选位置顺序尝试，不能按实时价格排序');

      const numberPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(numberPage.statusCode, 200);
      assert.match(numberPage.body, /英国 <span class="calling-code">\(\+44\)<\/span>/);
      assert.match(numberPage.body, /20 7946 0123/);
      assert.match(numberPage.body, /data-copy-value="2079460123"/);
      assert.match(numberPage.body, /号码有效至|可换号时间|剩余号码获取额度：2 · 实际能否获取取决于供应商库存/);
      assert.doesNotMatch(numberPage.body, /获取号码后，请在 24 小时内使用|链接剩余时间/);
      assert.doesNotMatch(numberPage.body, new RegExp(`${activationId}|HeroSMS|价格`));

      const otherBrowserPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: 'irrelevant=other-browser' } });
      assert.equal(otherBrowserPage.statusCode, 200);
      assert.match(otherBrowserPage.body, /20 7946 0123/);
      const otherBrowserRetry = await app.inject({ method: 'POST', url: `/a/${token}/numbers`, headers: { cookie: 'irrelevant=other-browser' } });
      assert.equal(otherBrowserRetry.statusCode, 303);
      assert.deepEqual(attemptedCountries, [1, 2], '已有当前号码时重复请求不得再次调用供应商');

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
      offers: async (): Promise<HeroSmsOffer[]> => [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 2, map: { '0.08': 2 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 1, map: { '0.09': 1 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 3, map: { '0.10': 3 } },
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
      const firstPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(firstPage.body, /data-countdown="2026-08-01T00:20:00.000Z"/);

      now = new Date('2026-08-01T00:02:00.000Z');
      const replacement = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacement.statusCode, 303);
      assert.deepEqual(attemptedCountries, [1, 2, 3]);

      const replacementPage = await app.inject({ method: 'GET', url: `/a/${token}` });
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
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-01T06:02:00.000Z');
      const confirming = await opened.app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(confirming.statusCode, 202);
      assert.match(confirming.body, /正在确认号码获取结果，请稍候/);
      assert.doesNotMatch(confirming.body, /<section class="section-action"|剩余号码获取额度|获取号码后，请在 24 小时内使用|链接剩余时间/);
      assert.equal(getNumberCalls, 2);

      const retry = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(retry.statusCode, 202);
      assert.equal(getNumberCalls, 2, '结果确认前重试不得再次调用供应商');
    } finally { await opened.app.close(); }

    reconciliationAvailable = true;
    const restarted = await openApplication(heroSms, () => now);
    try {
      const recovered = await restarted.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(recovered.body, /20 7946 0124/);
      assert.equal(getNumberCalls, 2);
    } finally { await restarted.app.close(); }
  });

  test('首次获取在报价查询期间并发撤销时返回不可用而不是 404', async () => {
    let blockOffers = false;
    let resolveOffersStarted!: () => void;
    const offersStarted = new Promise<void>((resolve) => { resolveOffersStarted = resolve; });
    let releaseOffers: (() => void) | undefined;
    const offersReleased = new Promise<void>((resolve) => { releaseOffers = resolve; });
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => {
        if (blockOffers) {
          resolveOffersStarted();
          await offersReleased;
        }
        return [
          { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 3, map: { '0.08': 3 } },
          { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 2, map: { '0.09': 2 } },
          { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 1, map: { '0.10': 1 } },
        ];
      },
    });
    const { app } = await openApplication(heroSms);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      blockOffers = true;
      const claim = app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      await offersStarted;

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${authorizationId}/revoke`, {})).statusCode, 303);

      releaseOffers?.();
      const result = await claim;
      assert.equal(result.statusCode, 409);
      assert.match(result.body, /此链接不可用，请联系发送者/);
    } finally {
      releaseOffers?.();
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
      offers: async (): Promise<HeroSmsOffer[]> => inventoryAvailable ? [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 3, map: { '0.08': 3 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 2, map: { '0.09': 2 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 1, map: { '0.10': 1 } },
      ] : [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 0, map: { '0.08': 0 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 0, map: { '0.09': 0 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 0, map: { '0.10': 0 } },
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
      assert.match(response.body, /剩余号码获取额度：3 · 实际能否获取取决于供应商库存/);
      assert.doesNotMatch(response.body, /请联系发送者/);
      const refreshed = await app.inject({
        method: 'GET', url: `/a/${token}`,
      });
      assert.match(refreshed.body, /剩余号码获取额度：3 · 实际能否获取取决于供应商库存/);
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

  test('八个候选位置在领取前不展示额度，无库存重试不消耗且成功后只减少一次', async () => {
    const fixedNow = new Date('2026-08-04T13:00:00.000Z');
    let stock = 0;
    let acquisitionCount = 0;
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [{ serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: stock, map: { '0.08': stock } }],
      getNumber: async () => {
        acquisitionCount += 1;
        return {
          activationId: `dynamic-eight-${randomUUID()}`,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: fixedNow, activationEndTime: new Date(fixedNow.getTime() + 1_200_000),
        };
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      await database.saveCandidateSettings(Array.from({ length: 8 }, () => ({
        countryId: 1,
        countryName: '美国',
      })), 0.11);
      await database.initialize();
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      const unopened = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.doesNotMatch(unopened.body, /剩余号码获取额度/);

      const empty = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(empty.statusCode, 409);
      assert.match(empty.body, /当前暂无可用号码，请稍后重试/);
      assert.match(empty.body, /剩余号码获取额度：8 · 实际能否获取取决于供应商库存/);

      const emptyAgain = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(emptyAgain.statusCode, 409);
      assert.match(emptyAgain.body, /剩余号码获取额度：8 · 实际能否获取取决于供应商库存/);

      stock = 1;
      const acquired = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(acquired.statusCode, 303);
      const acquiredPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(acquiredPage.body, /剩余号码获取额度：7 · 实际能否获取取决于供应商库存/);
      assert.equal(acquisitionCount, 1);
    } finally { await app.close(); }
  });

  test('十个重复地区候选位置逐个消费，第十个号码只能结束使用', async () => {
    let now = new Date('2026-08-04T14:00:00.000Z');
    let acquisitionCount = 0;
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [{ serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 10, map: { '0.08': 10 } }],
      getNumber: async () => {
        acquisitionCount += 1;
        return {
          activationId: `dynamic-ten-${acquisitionCount}-${randomUUID()}`,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.saveCandidateSettings(Array.from({ length: 10 }, () => ({
        countryId: 1,
        countryName: '美国',
      })), 0.11);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      for (let usedCount = 1; usedCount < 10; usedCount += 1) {
        now = new Date(now.getTime() + 120_000);
        const page = await app.inject({ method: 'GET', url: `/a/${token}` });
        assert.match(page.body, /更换号码/);
        assert.match(page.body, new RegExp(`剩余号码获取额度：${10 - usedCount}`));
        const replacementResponse: InjectionResponse = await app.inject({
          method: 'POST', url: `/a/${token}/replacement/confirm`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'replacement=confirm',
        });
        assert.equal(replacementResponse.statusCode, 303);
      }

      now = new Date(now.getTime() + 120_000);
      const finalPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(finalPage.body, /结束使用/);
      assert.doesNotMatch(finalPage.body, /更换号码/);
      assert.match(finalPage.body, /剩余号码获取额度：0/);
      assert.equal(acquisitionCount, 10);

      const ending = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(ending.statusCode, 303);
      const terminal = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(terminal.body, /可用号码次数已用尽，请联系发送者/);
    } finally { await app.close(); }
  });

  test('八个候选位置已消费五个后激活超时，仍可手动获取下一个号码', async () => {
    let now = new Date('2026-08-04T16:00:00.000Z');
    let acquisitionCount = 0;
    let currentActivationId = '';
    let currentAcquiredAt = now;
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [{ serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 8, map: { '0.08': 8 } }],
      getNumber: async () => {
        acquisitionCount += 1;
        currentActivationId = `dynamic-timeout-${acquisitionCount}-${randomUUID()}`;
        currentAcquiredAt = now;
        return {
          activationId: currentActivationId,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
      activationStatus: async (activationId) => {
        assert.equal(activationId, currentActivationId);
        return { delivered: false, providerStatus: 'cancelled' };
      },
      activationHistory: async () => [{
        activationId: currentActivationId,
        phoneNumber: '+1********23', activationCost: 0, currency: 'USD',
        activationTime: currentAcquiredAt, status: '4',
      }],
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.saveCandidateSettings(Array.from({ length: 8 }, () => ({
        countryId: 1,
        countryName: '美国',
      })), 0.11);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      for (let replacementCount = 0; replacementCount < 4; replacementCount += 1) {
        now = new Date(now.getTime() + 120_000);
        const replacementResponse: InjectionResponse = await app.inject({
          method: 'POST', url: `/a/${token}/replacement/confirm`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'replacement=confirm',
        });
        assert.equal(replacementResponse.statusCode, 303);
      }
      assert.equal(acquisitionCount, 5);

      now = new Date(currentAcquiredAt.getTime() + 1_200_000);
      const timedOut = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(timedOut.body, /号码已过期/);
      assert.match(timedOut.body, /剩余号码获取额度：3 · 实际能否获取取决于供应商库存/);
      assert.match(timedOut.body, /获取下一个号码/);

      const next = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(next.statusCode, 303);
      assert.equal(acquisitionCount, 6);
    } finally { await app.close(); }
  });

  test('无库存位置不消耗额度，库存恢复后下一次仍按原始位置优先', async () => {
    const fixedNow = new Date('2026-08-04T18:00:00.000Z');
    let inventory: 'available' | 'empty' | 'recovered' = 'available';
    const attemptedCountries: number[] = [];
    const activationId = `recovered-stock-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => inventory === 'available' ? [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 2, map: { '0.08': 2 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 1, map: { '0.09': 1 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 1, map: { '0.10': 1 } },
      ] : inventory === 'empty' ? [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 0, map: { '0.08': 0 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 0, map: { '0.09': 0 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 0, map: { '0.10': 0 } },
      ] : [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 1, map: { '0.08': 1 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 1, map: { '0.09': 1 } },
        { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 0, map: { '0.10': 0 } },
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

      inventory = 'recovered';
      const recovered = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
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

  test('offers 接口异常属于可重试的获取错误而不是无库存', async () => {
    const fixedNow = new Date('2026-08-05T12:00:00.000Z');
    let offersAvailable = true;
    let getNumberCalls = 0;
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => {
        if (!offersAvailable) throw new HeroSmsResponseError('provider');
        return [
          { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 3, map: { '0.08': 3 } },
          { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 2, map: { '0.09': 2 } },
          { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 1, map: { '0.10': 1 } },
        ];
      },
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

      offersAvailable = false;
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

      offersAvailable = true;
      const retried = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(retried.statusCode, 303);
      assert.equal(getNumberCalls, 1);
    } finally { await app.close(); }
  });

  test('明确获取失败不消耗地区或额度，管理员处理后可通过同一授权链接重试', async () => {
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
        assert.match(failed.body, /剩余号码获取额度：3 · 实际能否获取取决于供应商库存/);
        const refreshed = await app.inject({ method: 'GET', url: `/a/${token}` });
        assert.match(refreshed.body, /剩余号码获取额度：3 · 实际能否获取取决于供应商库存/);
        const unused = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM authorization_candidate_countries
           WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_suffix = $1)
             AND used_at IS NOT NULL`,
          [token.slice(-8)],
        );
        assert.equal(unused.rows[0]?.count, '0');

        failureKind = undefined;
        const retried = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
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
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      // 恢复记录地区为美国（呼叫代码 1）而号码为 +44 开头，代码与号码不匹配 → 降级为整号显示。
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
      assert.match(uncertain.body, /获取号码后，请在 24 小时内使用/);
      assert.doesNotMatch(uncertain.body, /<section class="section-action"|剩余号码获取额度|链接剩余时间/);

      const paused = await app.inject({ method: 'POST', url: `/a/${secondToken}/numbers` });
      assert.equal(paused.statusCode, 503);
      assert.equal(getNumberCalls, 1, '人工对账期间不得开始其他号码获取');

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.match(home.body, /结果待人工对账/);
      assert.match(home.body, /请求时间：08-07 08:00/);
      assert.match(home.body, /时间 08-07 08:00/);
      assert.doesNotMatch(home.body, /2026-08-07T00:00:00\.000Z/);
      const link = home.body.match(/action="(\/control7\/acquisition-requests\/[0-9a-f-]{36}\/candidates\/[^"/]+\/link)"/)?.[1]; assert.ok(link);
      const linked = await post(app, session, link, {});
      assert.equal(linked.statusCode, 303);
      const recoveredPage = await app.inject({ method: 'GET', url: `/a/${firstToken}` });
      assert.match(recoveredPage.body, /415 555 0121/, '人工关联后应恢复号码和激活状态');

      const secondUncertain = await app.inject({ method: 'POST', url: `/a/${secondToken}/numbers` });
      assert.equal(secondUncertain.statusCode, 202, '人工关联后全局队列应恢复');
      const secondHome = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const requestId = secondHome.body.match(/acquisition-requests\/([0-9a-f-]{36})\/confirm-absent/)?.[1]; assert.ok(requestId);
      const confirmed = await post(app, session, `/${config.adminPath}/acquisition-requests/${requestId}/confirm-absent`, {});
      assert.equal(confirmed.statusCode, 303);

      mode = 'success';
      const retried = await app.inject({ method: 'POST', url: `/a/${secondToken}/numbers` });
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
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const uncertain = await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(uncertain.statusCode, 202);
      assert.match(uncertain.body, /获取号码后，请在 24 小时内使用/);
      assert.doesNotMatch(uncertain.body, /链接剩余时间/);
    } finally { await opened.app.close(); }

    reconciliationAvailable = true;
    records = [{
      activationId: providerActivationId, phoneNumber: '+14155550123', activationCost: 0.8,
      currency: 'USD', serviceCode: 'openai', countryId: 1, activationTime: fixedNow, status: '1',
    }];
    const restarted = await openApplication(heroSms, () => fixedNow);
    try {
      const page = await restarted.app.inject({ method: 'GET', url: `/a/${token!}` });
      assert.match(page.body, /415 555 0123/);
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
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ], 0.11);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-08T06:02:00.000Z');
      const replaced = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replaced.statusCode, 303);
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /415 555 0124/);

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
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
        { countryId: 1, countryName: '美国' },
      ], 0.11);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-08T12:02:00.000Z');
      const confirming = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
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

      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /415 555 0124/);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-09T00:03:00.000Z');
      const delivered = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), code: '482913', text: 'Your code is 482913' },
      });
      assert.equal(delivered.statusCode, 200);

      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /美国 <span class="calling-code">\(\+1\)<\/span>|415 555 0123|复制号码/);
      assert.match(page.body, /使用说明|482913|复制验证码|验证码可查看至/);
      assert.doesNotMatch(page.body, /剩余号码获取额度|已收到验证码|更换号码|结束使用|可换号时间|可结束时间|正在监听短信验证码/);
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

  test('无时区莫斯科时间戳的 webhook 短信按莫斯科时区解释并正常交付（回归“短信被忽略”事故）', async () => {
    let now = new Date('2026-08-09T00:00:00.000Z');
    const activationId = `moscow-timestamp-${randomUUID()}`;
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      // 供应商实际发送无时区莫斯科本地时间（UTC+3）：03:15 莫斯科 = 00:15 UTC，
      // 落在号码窗口 [00:00, 00:20) 内；若按 UTC 或服务器本地时间解释则被窗口校验拒绝。
      now = new Date('2026-08-09T00:15:00.000Z');
      const delivered = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId, service: 'openai', country: 1, receivedAt: '2026-08-09 03:15:00', code: '482913', text: 'Your code is 482913' },
      });
      assert.equal(delivered.statusCode, 200);

      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /482913|复制验证码/);

      const state = await database.pool.query<{ authorization_status: string; sms_code: string | null; event_received_at: Date | null }>(
        `SELECT auth.status AS authorization_status, activation.sms_code,
                (SELECT received_at FROM hero_sms_events WHERE provider_activation_id = activation.provider_activation_id LIMIT 1) AS event_received_at
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.equal(state.rows[0]?.authorization_status, 'result_available');
      assert.equal(state.rows[0]?.sms_code, '482913');
      assert.equal(state.rows[0]?.event_received_at?.toISOString(), '2026-08-09T00:15:00.000Z');
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
        await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        const activationId = [...activationIds.keys()].at(-1); assert.ok(activationId);

        now = new Date('2026-08-09T00:20:00.001Z');
        const webhook = await app.inject({
          method: 'POST', url: `/${config.heroSmsWebhookPath}`,
          payload: { activationId, service: 'openai', country: 1, receivedAt: item.receivedAt, code: '482913', text: `boundary ${item.label}` },
        });
        assert.equal(webhook.statusCode, 200);
        const page = await app.inject({ method: 'GET', url: `/a/${token}` });
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-09T00:10:00.000Z');
      const delivered = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId, service: 'openai', country: 1, receivedAt: '2026-08-09T00:03:00.000Z', code: '482913', text: 'too late body' },
      });
      assert.equal(delivered.statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);

      const state = await database.pool.query<{ authorization_status: string; ended_reason: string | null; token_hash: string | null; phone_number: string | null; sms_code: string | null; sms_text: string | null }>(
        `SELECT auth.status AS authorization_status, auth.ended_reason, auth.token_hash,
                activation.phone_number, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.deepEqual(state.rows[0], {
        authorization_status: 'ended', ended_reason: 'result_view_expired', token_hash: null,
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-09T00:03:00.000Z');
      await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload: {
        activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), code: '482913', text: 'cleanup body',
      } });

      now = new Date('2026-08-09T00:07:59.999Z');
      const beforeExpiry = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(beforeExpiry.statusCode, 200);
      assert.match(beforeExpiry.body, /482913|415 555 0123/);

      now = new Date('2026-08-09T00:08:00.000Z');
      const afterExpiry = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(afterExpiry.statusCode, 404);
      const state = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null; phone_number: string | null; sms_code: string | null; sms_text: string | null }>(
        `SELECT auth.status, auth.ended_reason, auth.token_hash,
                activation.phone_number, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.deepEqual(state.rows[0], {
        status: 'ended', ended_reason: 'result_view_expired', token_hash: null,
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const payload = { activationId, service: 'openai', country: 1, receivedAt: '2026-08-09T00:03:00.000Z', code: '482913', text: 'Your code is 482913' };

      assert.equal((await app.inject({ method: 'POST', url: '/wrong-webhook-path', payload })).statusCode, 404);
      assert.equal((await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '192.0.2.10', payload })).statusCode, 404);
      const delivered = await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload });
      assert.equal(delivered.statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
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
      await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-10T00:03:00.000Z');
      await opened.app.close();
      const recovered = await openApplication(heroSms, () => now);
      try {
        const recipient = await recovered.app.inject({ method: 'GET', url: `/a/${token}` });
        assert.match(recipient.body, /短信已收到，暂时无法显示验证码，请联系发送者/);
        assert.match(recipient.body, /验证码可查看至：/);
        assert.doesNotMatch(recipient.body, /剩余号码获取额度|已收到验证码/);
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
          const page = await structured.app.inject({ method: 'GET', url: `/a/${token}` });
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
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await opened.app.close(); }

    now = new Date('2026-08-10T00:20:01.000Z');
    const recovered = await openApplication(heroSms, () => now);
    try {
      const page = await recovered.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /短信已收到，暂时无法显示验证码，请联系发送者/);
      assert.match(page.body, /415 555 0123|复制号码/);
      assert.match(page.body, /验证码可查看至：/);
      assert.doesNotMatch(page.body, /剩余号码获取额度|已收到验证码/);
      assert.doesNotMatch(page.body, /可换号时间/);
    } finally { await recovered.app.close(); }

    polledCode = '731904';
    now = new Date('2026-08-10T00:21:02.000Z');
    const structured = await openApplication(heroSms, () => now);
    try {
      const page = await structured.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /731904|复制验证码/);
      assert.match(page.body, /data-countdown="2026-08-10T00:24:00.000Z"/);
    } finally { await structured.app.close(); }
  });

  test('轮询遇对象形式等待响应：静默推进约 60 秒下次轮询，不告警、不触发 webhook', async () => {
    let now = new Date('2026-08-15T00:00:00.000Z');
    const activationId = `poll-object-waiting-${randomUUID()}`;
    let activationStatusCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => {
        activationStatusCalls += 1;
        // 生产观察的真实等待响应形态：verificationType=0、sms={}、call={}（适配器归一为 delivered:false）。
        return { delivered: false };
      },
    });
    await resetTablesBeforeApplication();
    const seeding = await openApplication(heroSms, () => now);
    let token = '';
    try {
      await resetAuthorizationTables(seeding.database);
      const session = await login(seeding.app);
      const created = await createAuthorization(seeding.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await seeding.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await seeding.app.close(); }

    const { value: polled, output } = await withCapturedStdout(() => openApplication(heroSms, () => now));
    try {
      assert.equal(activationStatusCalls, 1, '重启轮询只查询一次供应商状态');
      assert.doesNotMatch(output, /\[herosms\]\[(warn|error)\]/, '等待短信不产生告警日志');
      const state = await polled.database.pool.query<{ status: string; sms_code: string | null; sms_poll_after: Date | null }>(
        'SELECT status, sms_code, sms_poll_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'waiting_sms', '等待响应不改变激活状态');
      assert.equal(state.rows[0]?.sms_code, null, '等待响应不触发 webhook 交付');
      const pollAfter = state.rows[0]?.sms_poll_after;
      assert.ok(pollAfter);
      assert.equal(pollAfter.getTime(), now.getTime() + 60_000, '下一次轮询按约 60 秒推进');
      const authorization = await polled.database.pool.query<{ status: string }>(
        'SELECT status FROM activation_authorizations WHERE token_hash = $1',
        [tokenHash(token)],
      );
      assert.equal(authorization.rows[0]?.status, 'in_progress', '轮询不触发状态变更');
    } finally { await polled.app.close(); }
  });

  test('轮询遇格式错误响应：记录 error 级日志且下一次轮询调度不受影响', async () => {
    let now = new Date('2026-08-15T01:00:00.000Z');
    const activationId = `poll-response-error-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => { throw new HeroSmsResponseError('response'); },
    });
    await resetTablesBeforeApplication();
    const seeding = await openApplication(heroSms, () => now);
    let token = '';
    try {
      await resetAuthorizationTables(seeding.database);
      const session = await login(seeding.app);
      const created = await createAuthorization(seeding.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await seeding.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await seeding.app.close(); }

    const { value: polled, output } = await withCapturedStdout(() => openApplication(heroSms, () => now));
    try {
      assert.match(output, /\[herosms\]\[error\]/, '格式错误记录 error 级日志');
      assert.doesNotMatch(output, /\[herosms\]\[warn\]/, '格式错误不伪装成网络错误');
      const state = await polled.database.pool.query<{ status: string; sms_poll_after: Date | null }>(
        'SELECT status, sms_poll_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'waiting_sms', '格式错误不改变激活状态');
      const pollAfter = state.rows[0]?.sms_poll_after;
      assert.ok(pollAfter);
      assert.equal(pollAfter.getTime(), now.getTime() + 60_000, '格式错误不影响下一次轮询调度');
    } finally { await polled.app.close(); }
  });

  test('轮询遇网络错误：记录 warn 级日志且不影响下一次轮询调度', async () => {
    let now = new Date('2026-08-15T02:00:00.000Z');
    const activationId = `poll-uncertain-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => { throw new HeroSmsResponseError('uncertain'); },
    });
    await resetTablesBeforeApplication();
    const seeding = await openApplication(heroSms, () => now);
    let token = '';
    try {
      await resetAuthorizationTables(seeding.database);
      const session = await login(seeding.app);
      const created = await createAuthorization(seeding.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await seeding.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await seeding.app.close(); }

    const { value: polled, output } = await withCapturedStdout(() => openApplication(heroSms, () => now));
    try {
      assert.match(output, /\[herosms\]\[warn\]/, '网络错误记录 warn 级日志');
      assert.doesNotMatch(output, /\[herosms\]\[error\]/, '网络错误不伪装成格式错误');
      const state = await polled.database.pool.query<{ status: string; sms_poll_after: Date | null }>(
        'SELECT status, sms_poll_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'waiting_sms', '网络错误不改变激活状态');
      const pollAfter = state.rows[0]?.sms_poll_after;
      assert.ok(pollAfter);
      assert.equal(pollAfter.getTime(), now.getTime() + 60_000, '网络错误不影响下一次轮询调度');
    } finally { await polled.app.close(); }
  });

  test('轮询遇供应商取消：记录 info 级日志，只记录不处理', async () => {
    let now = new Date('2026-08-15T03:00:00.000Z');
    const activationId = `poll-cancelled-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => ({ delivered: false, providerStatus: 'cancelled' }),
    });
    await resetTablesBeforeApplication();
    const seeding = await openApplication(heroSms, () => now);
    let token = '';
    try {
      await resetAuthorizationTables(seeding.database);
      const session = await login(seeding.app);
      const created = await createAuthorization(seeding.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await seeding.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await seeding.app.close(); }

    const { value: polled, output } = await withCapturedStdout(() => openApplication(heroSms, () => now));
    try {
      assert.match(output, /\[herosms\]\[info\]/, '供应商取消记录 info 级日志');
      assert.doesNotMatch(output, /\[herosms\]\[(warn|error)\]/, '供应商取消不产生告警');
      const state = await polled.database.pool.query<{ status: string; sms_code: string | null; sms_poll_after: Date | null }>(
        'SELECT status, sms_code, sms_poll_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'waiting_sms', '轮询对供应商取消只记录、不改变激活状态');
      assert.equal(state.rows[0]?.sms_code, null, '供应商取消不触发 webhook 交付');
      const pollAfter = state.rows[0]?.sms_poll_after;
      assert.ok(pollAfter);
      assert.equal(pollAfter.getTime(), now.getTime() + 60_000, '供应商取消不阻断下一次轮询调度');
      const authorization = await polled.database.pool.query<{ status: string }>(
        'SELECT status FROM activation_authorizations WHERE token_hash = $1',
        [tokenHash(token)],
      );
      assert.equal(authorization.rows[0]?.status, 'in_progress', '轮询不触发状态变更');
    } finally { await polled.app.close(); }
  });

  test('轮询中短信落库失败只跳过本条激活，不中断轮询且不告警', async () => {
    let now = new Date('2026-08-15T04:00:00.000Z');
    const activationId = `poll-webhook-failure-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => ({
        delivered: true, code: '482913', text: 'Your code is 482913',
        receivedAt: new Date('2026-08-15T04:00:30.000Z'),
      }),
    });
    await resetTablesBeforeApplication();
    const seeding = await openApplication(heroSms, () => now);
    let token = '';
    try {
      await resetAuthorizationTables(seeding.database);
      const session = await login(seeding.app);
      const created = await createAuthorization(seeding.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await seeding.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await seeding.app.close(); }

    // 模拟轮询把短信交给 webhook 落库时失败（如数据库抖动）：轮询是 Webhook 的恢复机制，
    // 失败只跳过本条激活留待下次任务，不得中断本轮轮询（进而中断后台任务链）或产生告警。
    const originalWebhook = ActivationAuthorizations.prototype.receiveHeroSmsWebhook;
    ActivationAuthorizations.prototype.receiveHeroSmsWebhook = async function (this: ActivationAuthorizations, _event: HeroSmsWebhookEvent) {
      throw new Error('模拟短信落库失败');
    };
    try {
      const { value: polled, output } = await withCapturedStdout(() => openApplication(heroSms, () => now));
      try {
        assert.doesNotMatch(output, /\[herosms\]\[(warn|error)\]/, '短信落库失败不产生告警日志');
        const state = await polled.database.pool.query<{ status: string; sms_code: string | null; sms_poll_after: Date | null }>(
          'SELECT status, sms_code, sms_poll_after FROM supplier_activations WHERE provider_activation_id = $1',
          [activationId],
        );
        assert.equal(state.rows[0]?.status, 'waiting_sms', '落库失败保持等待状态留待下次轮询');
        assert.equal(state.rows[0]?.sms_code, null, '短信未交付');
        const pollAfter = state.rows[0]?.sms_poll_after;
        assert.ok(pollAfter);
        assert.equal(pollAfter.getTime(), now.getTime() + 60_000, '失败不阻断下一次轮询调度');
      } finally { await polled.app.close(); }
    } finally {
      ActivationAuthorizations.prototype.receiveHeroSmsWebhook = originalWebhook;
    }
  });

  test('供应商完成失败会持久重试，应用重启后继续且不影响验证码展示', async () => {
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
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      await opened.app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload: {
        activationId, service: 'openai', country: 1, receivedAt: '2026-08-11T00:03:00.000Z', code: '482913', text: 'structured body',
      } });
      await new Promise((resolve) => setImmediate(resolve));
      const page = await opened.app.inject({ method: 'GET', url: `/a/${token}` });
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId, service: 'openai', country: 1, receivedAt: new Date(now.getTime() + 3 * 60_000).toISOString(), text: 'Your code is 482913', code: '482913' },
      });
      assert.equal(webhook.statusCode, 200);
      await new Promise((resolve) => setImmediate(resolve));
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /482913|复制验证码/);
      assert.match(page.body, /415 555 0123|复制号码/);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-12T00:02:00.000Z');
      const number = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(number.body, /更换号码/);
      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement` });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /更换后当前号码将不能继续使用/);
      assert.match(confirmation.body, /继续等待/);
      const replaced = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(replaced.statusCode, 303);
      assert.equal(cancelCalls, 1);
      assert.deepEqual(acquiredCountries, [1, 2], '后继号码只能使用未成功获取过的地区');

      const replacement = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(replacement.body, /20 7946 0123/);
      assert.match(replacement.body, /剩余号码获取额度：1 · 实际能否获取取决于供应商库存/);
      const oldData = await database.pool.query<{ status: string; phone_number: string | null; sms_code: string | null; sms_text: string | null }>(
        'SELECT status, phone_number, sms_code, sms_text FROM supplier_activations WHERE provider_activation_id = $1', [cancelledActivationId],
      );
      assert.deepEqual(oldData.rows[0], { status: 'cancelled', phone_number: null, sms_code: null, sms_text: null });
    } finally { await app.close(); }
  });

  test('后继号码通用错误仍显示统一获取文案且可通过同一授权链接重试', async () => {
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-12T04:02:00.000Z');
      const failed = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(failed.statusCode, 503);
      assert.match(failed.body, /暂时无法获取号码，请联系发送者/);
      assert.doesNotMatch(failed.body, /暂时无法更换号码/);
      assert.equal(getNumberCalls, 2);

      replacementShouldFail = false;
      const retried = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-12T06:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T06:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T06:05:59.999Z');
      const before = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(before.body, /再等/);
      assert.match(before.body, /<button[^>]*disabled[^>]*>结束使用<\/button>/);
      const tooEarly = await app.inject({ method: 'POST', url: `/a/${token}/replacement` });
      assert.equal(tooEarly.statusCode, 409);

      now = new Date('2026-08-12T06:06:00.000Z');
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /仍长时间未收到验证码，可点击结束使用并联系管理员|结束使用/);
      assert.doesNotMatch(page.body, /更换号码/);
      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement` });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /结束使用此号码|结束后当前号码将不能继续使用|继续等待|确认结束/);
      const waited = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=wait' });
      assert.equal(waited.statusCode, 303);
      assert.equal(cancelCalls, 2);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ended.statusCode, 303);
      assert.equal(cancelCalls, 3);
      assert.equal(getNumberCalls, 3, '结束使用绝不能获取第四个号码');

      const prompt = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(prompt.body, /可用号码次数已用尽，请联系发送者/);
      assert.doesNotMatch(prompt.body, /1415555015|美国|更换号码|结束使用|获取下一个号码/);
      const state = await database.pool.query<{ status: string; ended_reason: string | null; end_prompt_until: Date | null; token_hash: string | null; phone_number: string | null }>(
        `SELECT auth.status, auth.ended_reason, auth.end_prompt_until, auth.token_hash, activation.phone_number
         FROM activation_authorizations auth JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activationIds[2]],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'quota_exhausted');
      assert.equal(state.rows[0]?.end_prompt_until?.toISOString(), '2026-08-12T06:08:00.000Z');
      assert.ok(state.rows[0]?.token_hash);
      assert.equal(state.rows[0]?.phone_number, null);

      now = new Date('2026-08-12T06:07:59.999Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 200);
      now = new Date('2026-08-12T06:08:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      const cleared = await database.pool.query<{ token_hash: string | null }>(
        'SELECT token_hash FROM activation_authorizations WHERE id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)',
        [activationIds[2]],
      );
      assert.deepEqual(cleared.rows[0], { token_hash: null });
    } finally { await app.close(); }
  });

  test('换号确认与短信 Webhook 请求重叠时保留先送达的短信结果且不获取后继号码', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    const activationId = `replacement-sms-${randomUUID()}`;
    let getNumberCalls = 0;
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => { markCancellationStarted = resolve; });
    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return { activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      cancelActivation: async () => {
        markCancellationStarted();
        await cancellationReleased;
        return 'cancelled';
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-12T12:02:00.000Z');

      const replacement = app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      await cancellationStarted;
      const delivered = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        headers: { 'x-forwarded-for': '127.0.0.1', 'content-type': 'application/json' },
        payload: { activationId, service: config.openAiServiceCode, country: 1, receivedAt: now.toISOString(), code: '482913', text: 'Your code is 482913' },
      });
      assert.equal(delivered.statusCode, 200);
      releaseCancellation();

      const raced = await replacement;
      assert.equal(raced.statusCode, 202);
      assert.match(raced.body, /验证码|482913/);
      assert.doesNotMatch(raced.body, /剩余号码获取额度|已收到验证码/);
      assert.equal(getNumberCalls, 1, '短信送达后不得创建后继号码');
      const state = await database.pool.query<{ authorization_status: string; activation_count: string; sms_code: string | null }>(
        `SELECT auth.status AS authorization_status, count(*) OVER ()::text AS activation_count, activation.sms_code
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE auth.token_suffix = $1`,
        [token.slice(-8)],
      );
      assert.deepEqual(state.rows[0], { authorization_status: 'result_available', activation_count: '1', sms_code: '482913' });
    } finally {
      releaseCancellation();
      await app.close();
    }
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-12T18:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T18:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T18:06:00.000Z');
      const raced = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
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
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-12T22:02:00.000Z');
      assert.equal((await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T22:04:00.000Z');
      assert.equal((await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T22:06:00.000Z');
      const ending = await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ending.statusCode, 202);
      assert.match(ending.body, /正在结束使用/);
      assert.doesNotMatch(ending.body, /<section class="section-action"|剩余号码获取额度|可用号码次数已用尽|获取下一个号码/);
      assert.equal(getNumberCalls, 3, '取消结果不明确前不得显示终局或获取第四个号码');
    } finally { await opened.app.close(); }

    reconciled = true;
    // 专用对账调度器（issue #07）在首个应用内已按到期时间对账并持久化 +60 秒重试期限：
    // 重启前推进时间越过该期限，启动对账才能继续收敛。
    now = new Date('2026-08-12T22:07:05.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      const page = await restarted.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /可用号码次数已用尽，请联系发送者/);
      assert.doesNotMatch(page.body, /<section class="section-action"|剩余号码获取额度/);
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
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await opened.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-13T00:02:00.000Z');
      const replacing = await opened.app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(replacing.statusCode, 202);
      assert.match(replacing.body, /正在更换号码/);
      assert.doesNotMatch(replacing.body, /<section class="section-action"|剩余号码获取额度/);
      assert.equal(getNumberCalls, 1, '取消结果不明确前不得获取后继号码');
    } finally { await opened.app.close(); }

    reconciled = true;
    // 专用对账调度器（issue #07）在首个应用内已按到期时间对账并持久化 +60 秒重试期限：
    // 重启前推进时间越过该期限，启动对账才能确认取消并获取后继号码。
    now = new Date('2026-08-13T00:03:05.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(getNumberCalls, 2, '供应商确认取消后应自动获取后继号码');
      const page = await restarted.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /415 555 0123/);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-12T20:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-12T20:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-12T20:06:00.000Z');
      const ending = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
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
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /可用号码次数已用尽，请联系发送者/);
      assert.doesNotMatch(page.body, /482913|复制验证码|获取下一个号码/);
    } finally { await app.close(); }
  });

  test('激活超时后持久对账退款但不自动获取，接收者可通过同一授权链接手动获取下一个号码', async () => {
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
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-14T00:19:59.999Z');
      const justBeforeTimeout = await initial.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(justBeforeTimeout.body, /415 555 0123/);
    } finally { await initial.close(); }

    now = new Date('2026-08-14T00:20:00.000Z');
    const { app: timedOut } = await openApplication(heroSms, () => now);
    try {
      assert.equal(getNumberCalls, 1, '激活超时不得在接收者离开页面后自动获取后继号码');
      const page = await timedOut.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /号码已过期/);
      assert.match(page.body, /剩余号码获取额度：2 · 实际能否获取取决于供应商库存/);
      assert.match(page.body, /获取下一个号码/);
      assert.doesNotMatch(page.body, /415 555 0123/);
      const next = await timedOut.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(next.statusCode, 303);
      assert.equal(getNumberCalls, 2, '只有接收者再次点击才获取下一个号码');
      const nextNumberPage = await timedOut.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(nextNumberPage.body, /号码有效至/);
      assert.doesNotMatch(nextNumberPage.body, /获取号码后，请在 24 小时内使用|链接剩余时间/);
    } finally { await timedOut.close(); }

    const historyCallsBeforeRefund = historyCalls;
    refundConfirmed = true;
    const { app: reconciled } = await openApplication(heroSms, () => now);
    try {
      assert.ok(historyCalls > historyCallsBeforeRefund, '费用仍非零时必须保留退款对账任务，重启后继续确认');
      const page = await reconciled.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /20 7946 0123/, '重启后继续处理退款对账不会改变接收者当前激活');
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
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-14T06:02:00.000Z');
      assert.equal((await initial.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-14T06:04:00.000Z');
      assert.equal((await initial.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(acquisitionIndex, 3);

      // 模拟历史中已有一次确认超时，而第三次激活仍在等待短信。
      await initialDatabase.pool.query(
        "UPDATE supplier_activations SET status = 'timed_out', timed_out_at = $2, timeout_final_status_confirmed_at = $2 WHERE provider_activation_id = $1",
        [activationIds[0], now],
      );
    } finally { await initial.close(); }

    const { app: activeRestart } = await openApplication(heroSms, () => now);
    try {
      const page = await activeRestart.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /415 555 0123/);
      const session = await login(activeRestart);
      const home = await activeRestart.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      assert.match(home.body, new RegExp(`data-authorization-id="${authorizationId}"[^>]*>[\\s\\S]*?<span class="authorization-status">🔄 进行中</span>`));
    } finally { await activeRestart.close(); }

    now = new Date('2026-08-14T06:24:00.000Z');
    const { app: timedOut, database } = await openApplication(heroSms, () => now);
    try {
      const page = await timedOut.inject({ method: 'GET', url: `/a/${token}` });
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
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await initial.close(); }

    now = new Date('2026-08-15T06:20:00.000Z');
    const { app: reconciled } = await openApplication(heroSms, () => now);
    try {
      const page = await reconciled.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /482913|复制验证码/);
      assert.match(page.body, /415 555 0123|复制号码/);
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
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await initial.close(); }

    now = new Date('2026-08-15T00:20:00.000Z');
    const { app: restarted } = await openApplication(heroSms, () => now);
    try {
      const page = await restarted.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /获取下一个号码/);
      assert.doesNotMatch(page.body, /482913|Your code is|415 555 0123/);
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
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
    } finally { await initial.close(); }

    now = new Date('2026-08-16T06:20:00.000Z');
    const { value: restarted, output } = await withCapturedStdout(() => openApplication(heroSms, () => now));
    try {
      // 回归锚：超时对账遇对象形式等待响应 → 释放并继续对账，等待静默不产生告警。
      assert.doesNotMatch(output, /\[herosms\]\[(warn|error)\]/, '超时对账遇等待响应不产生告警日志');
      const page = await restarted.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /正在确认号码状态/);
      assert.doesNotMatch(page.body, /<section class="section-action"|剩余号码获取额度|获取下一个号码|获取号码/);

      const session = await login(restarted.app);
      const home = await restarted.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const detailPath = home.body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(detailPath);
      const detail = await restarted.app.inject({ method: 'GET', url: detailPath, headers: { cookie: session.cookie } });
      assert.match(detail.body, /结果待人工对账/);
      assert.doesNotMatch(detail.body, /timed_out/);
    } finally { await restarted.app.close(); }

    delivered = true;
    now = new Date('2026-08-16T06:21:00.000Z');
    const confirmed = await openApplication(heroSms, () => now);
    try {
      const page = await confirmed.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /482913|复制验证码/);
      assert.match(page.body, /415 555 0123|复制号码/);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T23:59:59.999Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 200);
      now = new Date('2026-08-21T00:00:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 200);
      assert.equal(cancelCalls, 0, '截止时已经存在的供应商激活不得因授权到期自动取消');

      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '127.0.0.1',
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), text: 'late body', code: '482913' },
      });
      assert.equal(webhook.statusCode, 200);
      const detailPath = (await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } })).body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(detailPath);
      const detail = await app.inject({ method: 'GET', url: detailPath, headers: { cookie: session.cookie } });
      assert.match(detail.body, /完成确认中|已完成/);
      const recipient = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(recipient.statusCode, 200);
      assert.match(recipient.body, /482913|复制验证码|415 555 0123/);
      now = new Date('2026-08-21T00:05:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
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
      assert.match(detail.body, /已取消/);
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

      // 08-28 00:02 两个链接同时换号：第一个锁住，第二个进入 PostgreSQL 全局队列
      now = new Date('2026-08-28T00:02:00.000Z');
      const firstRequest = app.inject({ method: 'POST', url: `/a/${firstToken}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const queuedRequest = app.inject({ method: 'POST', url: `/a/${secondToken}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
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
      assert.deepEqual(attemptedCountries, [1]);
      // 领取截止 = 08-25 00:00；位置 1 已被领取消费，换号从位置 2 开始，
      // 位置 2 返回明确无库存并把时间推进到截止，不再调用下一个候选地区。
      now = new Date('2026-08-24T00:02:00.000Z');
      const replaced = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
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
      assert.equal(getNumberCalls, 1);

      now = new Date('2026-08-02T00:05:00.000Z');
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(page.statusCode, 200);
      assert.doesNotMatch(page.body, /获取号码后，请在 24 小时内使用|链接剩余时间/);
      assert.match(page.body, /号码有效至|结束使用/);
      assert.match(page.body, /仍长时间未收到验证码，可点击结束使用并联系管理员/);
      assert.doesNotMatch(page.body, /更换号码|获取下一个号码/);

      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement` });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /结束使用此号码/);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ended.statusCode, 404);
      assert.equal(cancelCalls, 1);
      assert.equal(getNumberCalls, 1, '领取截止后不得创建后继号码');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);

      const state = await database.pool.query<{ status: string; ended_reason: string | null; token_hash: string | null }>(
        'SELECT status, ended_reason, token_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'acquisition_expired');
      assert.equal(state.rows[0]?.token_hash, null);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-08-01T00:02:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      now = new Date('2026-08-01T00:04:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' })).statusCode, 303);
      assert.equal(getNumberCalls, 3);

      now = new Date('2026-08-02T00:05:00.000Z');
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /结束使用/);
      assert.doesNotMatch(page.body, /更换号码|获取下一个号码/);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(ended.statusCode, 303);
      assert.equal(cancelCalls, 3);
      assert.equal(getNumberCalls, 3, '领取截止后的结束使用绝不能获取第四个号码');

      const prompt = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(prompt.body, /可用号码次数已用尽，请联系发送者/);
      assert.doesNotMatch(prompt.body, /1415555015|美国|更换号码|结束使用|获取下一个号码/);
      const state = await database.pool.query<{ status: string; ended_reason: string | null; end_prompt_until: Date | null; token_hash: string | null }>(
        `SELECT auth.status, auth.ended_reason, auth.end_prompt_until, auth.token_hash
         FROM activation_authorizations auth JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activationIds[2]],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'quota_exhausted');
      assert.equal(state.rows[0]?.end_prompt_until?.toISOString(), '2026-08-02T00:07:00.000Z');
      assert.ok(state.rows[0]?.token_hash);

      now = new Date('2026-08-02T00:06:59.999Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 200);
      now = new Date('2026-08-02T00:07:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      const cleared = await database.pool.query<{ token_hash: string | null }>(
        'SELECT token_hash FROM activation_authorizations WHERE id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)',
        [activationIds[2]],
      );
      assert.deepEqual(cleared.rows[0], { token_hash: null });
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
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.11);
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

      now = new Date('2026-08-05T23:59:59.999Z');
      const claimed = await app.inject({ method: 'POST', url: `/a/${tokens[0]}/numbers` });
      assert.equal(claimed.statusCode, 303);
      const page = await app.inject({ method: 'GET', url: `/a/${tokens[0]}` });
      assert.match(page.body, /data-countdown="2026-08-06T00:19:59.999Z"/);

      now = new Date('2026-08-06T00:00:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${tokens[1]}/numbers` })).statusCode, 404);
      now = new Date('2026-08-06T00:00:00.001Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${tokens[2]}/numbers` })).statusCode, 404);
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
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.11);
      const session = await login(app);
      const created = await createBatch(app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      const first = await app.inject({ method: 'POST', url: `/a/${tokens[0]}/numbers` });
      assert.equal(first.statusCode, 303);
      const firstPage = await app.inject({ method: 'GET', url: `/a/${tokens[0]}` });
      assert.match(firstPage.body, /data-countdown="2026-08-03T00:20:00.000Z"/);

      const second = await app.inject({ method: 'POST', url: `/a/${tokens[1]}/numbers` });
      assert.equal(second.statusCode, 303);
      const secondPage = await app.inject({ method: 'GET', url: `/a/${tokens[1]}` });
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
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.11);
      const session = await login(app);
      const created = await createBatch(app, session, '1');
      const token = created.body.match(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 503);

      now = new Date('2026-08-03T23:59:59.999Z');
      const late = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      // 号码窗口（至 08-02 00:19:59.999）跨过领取截止后结束，超时收尾并以领取后期限结束
      now = new Date('2026-08-02T00:20:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      assert.equal(getNumberCalls, 1, '超时收尾不得创建后继号码');
      const state = await database.pool.query<{
        status: string; ended_reason: string | null; token_hash: string | null;
        activation_status: string; phone_number: string | null;
      }>(
        `SELECT auth.status, auth.ended_reason, auth.token_hash,
                activation.status AS activation_status, activation.phone_number
         FROM activation_authorizations auth JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'ended');
      assert.equal(state.rows[0]?.ended_reason, 'acquisition_expired');
      assert.equal(state.rows[0]?.token_hash, null);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      // 截止后陈旧页面的获取按钮仍会发起请求：必须拒绝新获取，但不得清理窗口内当前号码的访问凭据。
      now = new Date('2026-08-02T00:05:00.000Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/numbers` })).statusCode, 404);
      assert.equal(cancelCalls, 0, '拒绝获取不得触发供应商取消');
      const preserved = await database.pool.query<{ status: string; token_hash: string | null }>(
        'SELECT status, token_hash FROM activation_authorizations WHERE token_suffix = $1',
        [token.slice(-8)],
      );
      assert.equal(preserved.rows[0]?.status, 'in_progress');
      assert.ok(preserved.rows[0]?.token_hash, '拒绝获取不得清理链接凭据');

      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
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
      const result = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(result.body, /482913|复制验证码/);
      assert.match(result.body, /data-countdown="2026-08-02T00:12:00.000Z"/);

      now = new Date('2026-08-02T00:12:00.001Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
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
      assert.equal(getNumberCalls, 1);

      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(page.body, /415 555 0123|复制号码/);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-01T23:59:59.999Z');
      const confirmation = await app.inject({ method: 'POST', url: `/a/${token}/replacement` });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, /确认更换号码/);
      const ended = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      now = new Date('2026-09-01T00:02:00.000Z');
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const waitingDetail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(waitingDetail.body, /📩 等待短信/);
      assert.doesNotMatch(waitingDetail.body, /撤销收尾/);
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
      const recipient = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(recipient.statusCode, 404);
      const state = await database.pool.query<{
        status: string; ended_reason: string | null; token_hash: string | null;
        phone_number: string | null; sms_code: string | null; sms_text: string | null;
      }>(
        `SELECT auth.status, auth.ended_reason, auth.token_hash,
                activation.phone_number, activation.sms_code, activation.sms_text
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE auth.id = $1`, [id],
      );
      assert.deepEqual(state.rows[0], {
        status: 'ended', ended_reason: 'admin_revoked', token_hash: null,
        phone_number: null, sms_code: null, sms_text: null,
      });
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /授权状态：🏁 已结束（管理员撤销 · 09-01 08:02）/);
      assert.doesNotMatch(detail.body, /结束原因：|结束时间：/);
      assert.match(detail.body, /已取消/);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.match(confirmation.body, /撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。/);
      assert.match(confirmation.body, /将在可取消时请求取消当前供应商激活/);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancelCalls, 0);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      const finalizingDetail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(finalizingDetail.body, /⏳ 撤销收尾，号码有效至：<span data-countdown=/);
      assert.doesNotMatch(finalizingDetail.body, /📩 等待短信/);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
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
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
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
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancellationCalls, 1);
      assert.equal(acquiredNumbers, 1);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /完成确认中|已完成/);
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
      await database.pool.query("UPDATE activation_authorizations SET status = 'ended', ended_at = $2, ended_reason = 'acquisition_expired', token_hash = NULL WHERE id = $1", [authorizationId, now]);
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
      assert.match(home.body, new RegExp(`data-authorization-id="${authorizationId}"[^>]*>[\\s\\S]*?<span class="authorization-status">🏁 已结束</span>`));
      assert.doesNotMatch(home.body, /已到期|等待短信|待处理异常|退款|费用|供应商激活|当前地区/);
      assert.doesNotMatch(home.body, /\+14155550123|482913|短信正文/);
      const eventsBeforeDetail = await database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM lifecycle_events WHERE authorization_id = $1', [authorizationId],
      );
      assert.ok(Number(eventsBeforeDetail.rows[0]?.count) >= 4, '状态变更应留下非敏感生命周期事件');

      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /授权状态：🏁 已结束（领取后期限结束 · 09-06 08:00）/);
      assert.doesNotMatch(detail.body, /结束原因：|结束时间：|获取额度：/);
      assert.match(detail.body, /供应商激活/);
      assert.match(detail.body, /first-/);
      assert.match(detail.body, /获取时间 09-06 08:00/);
      assert.match(detail.body, /已取消/);
      assert.match(detail.body, /等待短信/);
      assert.match(detail.body, /位置 3 · 法国：<\/strong>📩 等待短信/);
      assert.match(detail.body, /位置 1 · 美国：<\/strong>↩️ 已取消/);
      assert.match(detail.body, /位置 2 · 英国：<\/strong>↩️ 已取消/);
      assert.match(detail.body, /退款确认待处理 ⚠️/);
      assert.doesNotMatch(detail.body, /<h2>候选地区<\/h2>|<h2>当前供应商激活<\/h2>/);
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

  test('管理员详情按候选位置展示最近已结束号码获取结果并排除调用前中止记录', async () => {
    const now = new Date('2026-08-06T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => now);
    try {
      const session = await login(app);
      const created = await createBatch(app, session, '4');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]!);
      assert.equal(tokens.length, 4);
      const authorizationIds: string[] = [];
      for (const token of tokens) {
        const authorization = await database.pool.query<{ id: string }>(
          'SELECT id FROM activation_authorizations WHERE token_suffix = $1', [token.slice(-8)],
        );
        const id = authorization.rows[0]?.id;
        assert.ok(id);
        authorizationIds.push(id);
        await database.pool.query(
          `UPDATE activation_authorizations
           SET status = 'in_progress', claimed_at = $2, number_acquisition_expires_at = $3
           WHERE id = $1`,
          [id, now, new Date(now.getTime() + 24 * 60 * 60 * 1000)],
        );
        for (let position = 1; position <= 3; position++) {
          await database.pool.query(
            `INSERT INTO authorization_candidate_countries
              (authorization_id, position, country_id, country_name)
             VALUES ($1, $2, 1, '美国')`,
            [id, position],
          );
        }
      }

      const insertRequest = async (
        authorizationId: string,
        position: number,
        status: 'confirmed_absent' | 'failed',
        errorKind: string | null,
        updatedAt: Date,
      ) => {
        await database.pool.query(
          `INSERT INTO number_acquisition_requests
            (authorization_id, candidate_position, country_id, requested_price, status, error_kind, requested_at, updated_at)
           VALUES ($1, $2, 1, 0.8, $3, $4, $5, $6)`,
          [authorizationId, position, status, errorKind, new Date(updatedAt.getTime() - 1_000), updatedAt],
        );
      };

      const resultTimes = [
        new Date('2026-08-05T00:10:00.000Z'), new Date('2026-08-05T00:20:00.000Z'), new Date('2026-08-05T00:30:00.000Z'),
        new Date('2026-08-05T00:40:00.000Z'), new Date('2026-08-05T00:50:00.000Z'), new Date('2026-08-05T01:00:00.000Z'),
        new Date('2026-08-05T01:10:00.000Z'), new Date('2026-08-05T01:20:00.000Z'), new Date('2026-08-05T01:30:00.000Z'),
        new Date('2026-08-05T01:40:00.000Z'), new Date('2026-08-05T01:50:00.000Z'), new Date('2026-08-05T02:00:00.000Z'),
      ];
      const resultCases: Array<{ authorization: number; position: number; errorKind: string }> = [
        { authorization: 0, position: 1, errorKind: 'no-numbers' },
        { authorization: 0, position: 2, errorKind: 'confirmed_absent' },
        { authorization: 1, position: 1, errorKind: 'balance' },
        { authorization: 1, position: 2, errorKind: 'authentication' },
        { authorization: 1, position: 3, errorKind: 'account' },
        { authorization: 2, position: 1, errorKind: 'request' },
        { authorization: 2, position: 2, errorKind: 'rate-limit' },
        { authorization: 2, position: 3, errorKind: 'provider' },
        { authorization: 3, position: 1, errorKind: 'response' },
        { authorization: 3, position: 2, errorKind: 'unrecognized-failure' },
      ];
      for (const [index, resultCase] of resultCases.entries()) {
        await insertRequest(authorizationIds[resultCase.authorization]!, resultCase.position, resultCase.errorKind === 'confirmed_absent' ? 'confirmed_absent' : 'failed', resultCase.errorKind === 'confirmed_absent' ? null : resultCase.errorKind, resultTimes[index]!);
      }

      // 最新记录是调用前或流程内部中止时，查询应回溯到最近一次真实供应商调用的已结束结果。
      await insertRequest(authorizationIds[0]!, 1, 'failed', 'authorization-expired', resultTimes[10]!);
      await insertRequest(authorizationIds[0]!, 1, 'failed', 'sms-delivered', resultTimes[11]!);
      // 报价零库存没有创建请求的候选位置应只显示未消耗，不伪造结果。
      await database.pool.query(
        `UPDATE activation_authorizations SET status = 'in_progress' WHERE id = $1`, [authorizationIds[3]],
      );
      await database.pool.query(
        `UPDATE authorization_candidate_countries SET used_at = $2
         WHERE authorization_id = $1 AND position = 3`, [authorizationIds[3], now],
      );
      await insertRequest(authorizationIds[3]!, 3, 'failed', 'active-activation', resultTimes[11]!);

      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationIds[0]}`, headers: { cookie: session.cookie } });
      assert.equal(detail.statusCode, 200);
      assert.match(detail.body, /位置 1 · 美国：<\/strong>⬜ 未消耗，无库存 · 08-05 08:10/);
      assert.match(detail.body, /位置 2 · 美国：<\/strong>⬜ 未消耗，对账确认未取得号码 · 08-05 08:20/);
      assert.doesNotMatch(detail.body, /authorization-expired|sms-delivered|号码获取失败|获取时间 08-05 08:30/);

      const abnormalDetails = await Promise.all(authorizationIds.slice(1, 4).map((id) => app.inject({
        method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie },
      })));
      assert.match(abnormalDetails[0]!.body, /⬜ 未消耗，⚠️ 余额不足 · 08-05 08:30/);
      assert.match(abnormalDetails[0]!.body, /⬜ 未消耗，⚠️ 认证失败 · 08-05 08:40/);
      assert.match(abnormalDetails[0]!.body, /⬜ 未消耗，⚠️ 账号不可用 · 08-05 08:50/);
      assert.match(abnormalDetails[1]!.body, /⬜ 未消耗，⚠️ 号码请求被拒绝 · 08-05 09:00/);
      assert.match(abnormalDetails[1]!.body, /⬜ 未消耗，⚠️ 请求过于频繁 · 08-05 09:10/);
      assert.match(abnormalDetails[1]!.body, /⬜ 未消耗，⚠️ 服务暂时不可用 · 08-05 09:20/);
      assert.match(abnormalDetails[2]!.body, /⬜ 未消耗，⚠️ 响应无法识别 · 08-05 09:30/);
      assert.match(abnormalDetails[2]!.body, /⬜ 未消耗，⚠️ 号码获取失败 · 08-05 09:40/);
      assert.doesNotMatch(abnormalDetails[2]!.body, /位置 3 · 美国：<\/strong>⬜ 未消耗.*active-activation/);
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
          assert.equal(article.status, '📋 待领取');
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
      await assertFilter('unclaimed', [links[3]!.slice(-8)], '📋 待领取');
      await assertFilter('in_progress', [links[0]!.slice(-8)], '🔄 进行中');
      await assertFilter('result_available', [links[1]!.slice(-8)], '✅ 结果可查看');
      await assertFilter('ended', [links[2]!.slice(-8)], '🏁 已结束');
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
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
      assert.equal(articles[0]?.status, '🏁 已结束');
      assert.ok([...home.body.matchAll(/href="([^"]+)"/g)].every((match) => !match[1]!.includes('/a/')), '列表不得提供公开链接入口');

      // 详情页仍可打开，同样不伪造后缀
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.equal(detail.statusCode, 200);
      assert.match(detail.body, /链接末 8 位：未知/);
      assert.match(detail.body, /授权状态：🏁 已结束（管理员撤销 · 08-01 08:00）/);
    } finally { await app.close(); }
  });

  test('按生命周期裁剪管理员详情：覆盖待领取、进行中、结果可查看、额度用尽、期限结束和管理员撤销详情', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => now);
    await resetAuthorizationTables(database);
    await database.saveCandidateSettings([
      { countryId: 1, countryName: '美国' },
      { countryId: 2, countryName: '英国' },
      { countryId: 3, countryName: '法国' },
    ], 0.11);
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
      assert.match(detail1.body, /授权状态：📋 待领取/);
      assert.match(detail1.body, /创建时间/);
      assert.match(detail1.body, /撤销授权/);
      assert.doesNotMatch(detail1.body, /候选地区|供应商激活|成本|获取额度|新号码获取截止时间|授权到期时间|领取时间|结束原因|结束时间|尚无/);
      assert.doesNotMatch(detail1.body, new RegExp(token1));

      // 2. 进行中详情 (in_progress)
      const claimRes = await app.inject({
        method: 'POST', url: `/a/${token1}/numbers`,
      });
      assert.equal(claimRes.statusCode, 303);

      const detail2 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id1}`, headers: { cookie: session.cookie } });
      assert.equal(detail2.statusCode, 200);
      assert.match(detail2.body, /授权状态：🔄 进行中/);
      assert.match(detail2.body, /创建时间/);
      assert.match(detail2.body, /领取时间/);
      assert.doesNotMatch(detail2.body, /新号码获取截止时间|获取额度：/);
      assert.match(detail2.body, /位置 1 · 美国：<\/strong>📩 等待短信/);
      assert.match(detail2.body, /位置 2 · 英国：<\/strong>⬜ 未消耗/);
      assert.match(detail2.body, /位置 3 · 法国：<\/strong>⬜ 未消耗/);
      assert.doesNotMatch(detail2.body, /候选地区|当前供应商激活/);
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
      assert.match(detail3.body, /授权状态：✅ 结果可查看/);
      assert.match(detail3.body, /完整号码：/);
      assert.match(detail3.body, /验证码：/);
      assert.match(detail3.body, /654321/);
      assert.match(detail3.body, /位置 1 · 美国：<\/strong>⏳ 完成确认中/);
      assert.match(detail3.body, /撤销授权/);

      // 4. 管理员撤销详情 (admin_revoked)
      const revokeRes = await post(app, session, `/${config.adminPath}/authorizations/${id1}/revoke`, {});
      assert.equal(revokeRes.statusCode, 303);
      const detail4 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id1}`, headers: { cookie: session.cookie } });
      assert.equal(detail4.statusCode, 200);
      assert.match(detail4.body, /授权状态：🏁 已结束（管理员撤销 · 08-01 08:00）/);
      assert.doesNotMatch(detail4.body, /结束原因：|结束时间：/);
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
      assert.match(detail5.body, /授权状态：🏁 已结束（获取额度用尽 · 08-01 08:00）/);
      assert.doesNotMatch(detail5.body, /结束原因：|结束时间：|获取额度：/);
      assert.doesNotMatch(detail5.body, /撤销授权/);

      // 6. 期限结束详情 (acquisition_expired)
      const createdC = await createBatch(app, session, '1');
      const tokenC = createdC.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(tokenC);
      const homeC = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const idC = authorizationIdFromHome(homeC.body, tokenC);
      const claimC = await app.inject({ method: 'POST', url: `/a/${tokenC}/numbers` });
      assert.ok([200, 202, 303].includes(claimC.statusCode));
      await database.pool.query(
        "UPDATE activation_authorizations SET status = 'ended', ended_at = $2, ended_reason = 'acquisition_expired' WHERE token_hash = $1",
        [createHash('sha256').update(tokenC).digest('hex'), now],
      );
      const detail6 = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${idC}`, headers: { cookie: session.cookie } });
      assert.equal(detail6.statusCode, 200);
      assert.match(detail6.body, /授权状态：🏁 已结束（领取后期限结束 · 08-01 08:00）/);
      assert.doesNotMatch(detail6.body, /结束原因：|结束时间：/);
      assert.doesNotMatch(detail6.body, /撤销授权/);
    } finally { await app.close(); }
  });

  test('接收者页面生命周期与换号操作区布局：覆盖四种操作状态、两种短信结果状态、领取期限降级与结果查看期只读行为', async () => {
    let now = new Date('2026-08-04T14:30:00.000Z');
    const firstActivationId = `layout-act-1-${randomUUID()}`;
    const secondActivationId = `layout-act-2-${randomUUID()}`;
    const thirdActivationId = `layout-act-3-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        if (countryId === 1) {
          return { activationId: firstActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
        }
        if (countryId === 2) {
          return { activationId: secondActivationId, phoneNumber: '+442079460123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
        }
        return { activationId: thirdActivationId, phoneNumber: '+33142278186', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      cancelActivation: async () => 'cancelled',
    });

    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      // 1. 获取第一个号码，处于前两个号码等待状态（状态 A：等待换号）
      const claim = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claim.statusCode, 303);

      const pageStateA = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(pageStateA.statusCode, 200);
      assert.match(pageStateA.body, /aria-label="当前号码"/);
      assert.match(pageStateA.body, /415 555 0123/);
      assert.match(pageStateA.body, /号码有效至：还剩/);
      assert.match(pageStateA.body, /💡 使用说明/);
      assert.match(pageStateA.body, /aria-label="验证码"/);
      // 尚未点开始接收验证码：显示过渡提示与按钮，等待动画不显示
      assert.match(pageStateA.body, /请把号码填入目标服务后，点击下方按钮开始接收验证码/);
      assert.match(pageStateA.body, /开始接收验证码/);
      assert.doesNotMatch(pageStateA.body, /正在监听短信验证码/);
      assert.match(pageStateA.body, /剩余号码获取额度：2 · 实际能否获取取决于供应商库存/);
      assert.match(pageStateA.body, /后可换号/);
      assert.match(pageStateA.body, /<button[^>]*disabled[^>]*>更换号码<\/button>/);

      // 点开始接收验证码后：等待动画出现、过渡提示与按钮消失（状态 A'：已宣告等待）
      const recorded = await app.inject({ method: 'POST', url: `/a/${token}/verification-request` });
      assert.equal(recorded.statusCode, 303);
      const pageStateA2 = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(pageStateA2.body, /正在监听短信验证码/);
      assert.doesNotMatch(pageStateA2.body, /开始接收验证码|请把号码填入目标服务后/);

      // 2. 达到允许取消时间，处于前两个号码可操作状态（状态 B：可以换号）
      now = new Date('2026-08-04T14:32:00.000Z');
      const pageStateB = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(pageStateB.body, /剩余号码获取额度：2 · 实际能否获取取决于供应商库存/);
      assert.match(pageStateB.body, /长时间未收到验证码，可点击更换号码/);
      assert.match(pageStateB.body, /<form[^>]*action="\/a\/[^\/]+\/replacement"/);
      assert.match(pageStateB.body, /<button[^>]*type="submit"[^>]*>更换号码<\/button>/);

      // 更换为第二个号码，然后更换为第三个号码
      await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      now = new Date('2026-08-04T14:34:00.000Z');
      await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });

      // 3. 第三个号码等待状态（状态 C：等待结束使用）
      now = new Date('2026-08-04T14:34:00.000Z');
      const pageStateC = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(pageStateC.body, /剩余号码获取额度：0/);
      assert.doesNotMatch(pageStateC.body, /供应商库存/);
      assert.match(pageStateC.body, /再等/);
      assert.match(pageStateC.body, /<button[^>]*disabled[^>]*>结束使用<\/button>/);

      // 4. 第三个号码可操作状态（状态 D：可以结束使用）
      now = new Date('2026-08-04T14:36:00.000Z');
      const pageStateD = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(pageStateD.body, /剩余号码获取额度：0/);
      assert.doesNotMatch(pageStateD.body, /供应商库存/);
      assert.match(pageStateD.body, /仍长时间未收到验证码，可点击结束使用并联系管理员/);
      assert.match(pageStateD.body, /<button[^>]*type="submit"[^>]*>结束使用<\/button>/);

      // 5. 短信送达结果查看期只读行为与结构化验证码结果
      await app.inject({
        method: 'POST',
        url: `/${config.heroSmsWebhookPath}`,
        headers: { 'x-forwarded-for': '127.0.0.1', 'content-type': 'application/json' },
        payload: { activationId: thirdActivationId, service: config.openAiServiceCode, country: 3, receivedAt: '2026-08-04T14:36:30.000Z', code: '987654', text: 'Your OpenAI code is 987654' },
      });

      const pageResultAvailable = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(pageResultAvailable.statusCode, 200);
      assert.match(pageResultAvailable.body, /aria-label="当前号码"/);
      assert.match(pageResultAvailable.body, /142 278 186/);
      assert.match(pageResultAvailable.body, /法国 <span class="calling-code">\(\+33\)<\/span>/);
      assert.doesNotMatch(pageResultAvailable.body, /<p class="number-expiry"|号码有效至|<div class="steps-guide"|💡 使用说明/);
      assert.match(pageResultAvailable.body, /aria-label="验证码"/);
      assert.match(pageResultAvailable.body, /987654/);
      assert.match(pageResultAvailable.body, /复制验证码/);
      assert.match(pageResultAvailable.body, /验证码可查看至：/);
      assert.doesNotMatch(pageResultAvailable.body, /<section class="section-action"|剩余号码获取额度|已收到验证码/);

      // 6. 后端拒绝短信送达后的换号或结束使用提交
      const forbiddenAction = await app.inject({ method: 'POST', url: `/a/${token}/replacement` });
      assert.equal(forbiddenAction.statusCode, 409);

      const forbiddenConfirm = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(forbiddenConfirm.statusCode, 409);
    } finally { await app.close(); }
  });

  test('取号后未点开始接收验证码时显示过渡提示与按钮，点按钮后写入等待起点并切换为等待动画，重复提交幂等不覆盖', async () => {
    let now = new Date('2026-08-05T10:00:00.000Z');
    const activationId = `verify-start-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      // 取号成功：号码区下方显示过渡提示与按钮，等待动画不显示
      const claim = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claim.statusCode, 303);
      const before = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(before.statusCode, 200);
      assert.match(before.body, /请把号码填入目标服务后，点击下方按钮开始接收验证码/);
      assert.match(before.body, /开始接收验证码/);
      assert.match(before.body, /action="\/a\/[^\/]+\/verification-request"/);
      assert.doesNotMatch(before.body, /正在监听短信验证码/);
      assert.match(before.body, /415 555 0123/);
      assert.match(before.body, /号码有效至：还剩/);

      // 数据库等待起点为空
      const beforeRow = await database.pool.query<{ verification_requested_at: Date | null }>(
        'SELECT verification_requested_at FROM supplier_activations WHERE provider_activation_id = $1', [activationId],
      );
      assert.equal(beforeRow.rows[0]?.verification_requested_at, null);

      // 点按钮：写入等待起点、303 回链接、等待动画出现、按钮与过渡提示消失
      const recorded = await app.inject({ method: 'POST', url: `/a/${token}/verification-request` });
      assert.equal(recorded.statusCode, 303);
      assert.equal(recorded.headers.location, `/a/${token}`);
      const after = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(after.body, /正在监听短信验证码/);
      assert.doesNotMatch(after.body, /开始接收验证码|请把号码填入目标服务后/);
      const recordedRow = await database.pool.query<{ verification_requested_at: Date | null }>(
        'SELECT verification_requested_at FROM supplier_activations WHERE provider_activation_id = $1', [activationId],
      );
      assert.equal(recordedRow.rows[0]?.verification_requested_at?.toISOString(), '2026-08-05T10:00:00.000Z');

      // 一分钟后重复提交：幂等忽略、不覆盖、不重置计时
      now = new Date('2026-08-05T10:01:00.000Z');
      const repeated = await app.inject({ method: 'POST', url: `/a/${token}/verification-request` });
      assert.equal(repeated.statusCode, 303);
      const repeatedRow = await database.pool.query<{ verification_requested_at: Date | null }>(
        'SELECT verification_requested_at FROM supplier_activations WHERE provider_activation_id = $1', [activationId],
      );
      assert.equal(repeatedRow.rows[0]?.verification_requested_at?.toISOString(), '2026-08-05T10:00:00.000Z');
    } finally { await app.close(); }
  });

  test('开始接收验证码不消耗候选位置或获取额度，未点按钮仍可按取号两分钟规则换号，后继号码按钮重新出现且两号码计时独立', async () => {
    let now = new Date('2026-08-05T11:00:00.000Z');
    const activationIds: string[] = [];
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        const activationId = `verify-quota-${activationIds.length + 1}-${randomUUID()}`;
        activationIds.push(activationId);
        return {
          activationId, phoneNumber: countryId === 1 ? '+14155550123' : '+442079460123',
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      // 未点按钮时消耗额度的动作只有取号：剩余额度保持 2
      await app.inject({ method: 'POST', url: `/a/${token}/verification-request` });
      const quotaPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(quotaPage.body, /剩余号码获取额度：2 · 实际能否获取取决于供应商库存/);
      const candidateRow = await database.pool.query<{ used_count: string }>(
        'SELECT count(*)::text AS used_count FROM authorization_candidate_countries WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE token_hash = $1) AND used_at IS NOT NULL',
        [tokenHash(token)],
      );
      assert.equal(candidateRow.rows[0]?.used_count, '1');

      // 未点按钮的另一个授权满两分钟：换号入口按取号时刻正常可用，按钮态不锁换号资格
      const secondCreated = await createAuthorization(app, session);
      const secondAuthorization = secondCreated.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(secondAuthorization);
      await app.inject({ method: 'POST', url: `/a/${secondAuthorization}/numbers` });
      now = new Date('2026-08-05T11:02:00.000Z');
      const replaceReady = await app.inject({ method: 'GET', url: `/a/${secondAuthorization}` });
      assert.match(replaceReady.body, /长时间未收到验证码，可点击更换号码/);
      assert.match(replaceReady.body, /<button[^>]*type="submit"[^>]*>更换号码<\/button>/);
      // 未点按钮的号码换号确认后取得后继号码：新号码等待起点为空、按钮重新出现
      await app.inject({
        method: 'POST', url: `/a/${secondAuthorization}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      const successor = await app.inject({ method: 'GET', url: `/a/${secondAuthorization}` });
      assert.match(successor.body, /20 7946 0123/);
      assert.match(successor.body, /请把号码填入目标服务后，点击下方按钮开始接收验证码/);
      assert.match(successor.body, /开始接收验证码/);
      assert.doesNotMatch(successor.body, /正在监听短信验证码/);
      const successorRow = await database.pool.query<{ verification_requested_at: Date | null }>(
        'SELECT verification_requested_at FROM supplier_activations WHERE provider_activation_id = $1', [activationIds[1]!],
      );
      assert.equal(successorRow.rows[0]?.verification_requested_at, null);
    } finally { await app.close(); }
  });

  test('短信比开始接收验证码更早到达时直接展示验证码与结果查看期，按钮不出现、等待起点留空，伪造终态提交不写不改状态', async () => {
    let now = new Date('2026-08-05T12:00:00.000Z');
    const activationId = `verify-early-sms-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      // 未点按钮时短信送达：验证码与结果查看期原地展示，按钮与等待动画均不出现
      await app.inject({
        method: 'POST',
        url: `/${config.heroSmsWebhookPath}`,
        headers: { 'x-forwarded-for': '127.0.0.1', 'content-type': 'application/json' },
        payload: { activationId, service: config.openAiServiceCode, country: 1, receivedAt: '2026-08-05T12:00:30.000Z', code: '654321', text: 'Your OpenAI code is 654321' },
      });
      const delivered = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(delivered.body, /654321/);
      assert.match(delivered.body, /复制验证码/);
      assert.match(delivered.body, /验证码可查看至：/);
      assert.doesNotMatch(delivered.body, /开始接收验证码|请把号码填入目标服务后|正在监听短信验证码/);
      const deliveredRow = await database.pool.query<{ verification_requested_at: Date | null; sms_received_at: Date | null }>(
        'SELECT verification_requested_at, sms_received_at FROM supplier_activations WHERE provider_activation_id = $1', [activationId],
      );
      assert.equal(deliveredRow.rows[0]?.verification_requested_at, null);
      assert.equal(deliveredRow.rows[0]?.sms_received_at?.toISOString(), '2026-08-05T12:00:30.000Z');

      // 结果查看期伪造提交：安全 303 回当前页、不写入、状态不变
      const forged = await app.inject({ method: 'POST', url: `/a/${token}/verification-request` });
      assert.equal(forged.statusCode, 303);
      assert.equal(forged.headers.location, `/a/${token}`);
      const afterForge = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(afterForge.body, /654321/);
      const forgedRow = await database.pool.query<{ verification_requested_at: Date | null }>(
        'SELECT verification_requested_at FROM supplier_activations WHERE provider_activation_id = $1', [activationId],
      );
      assert.equal(forgedRow.rows[0]?.verification_requested_at, null);
    } finally { await app.close(); }
  });

  test('确认换号与确认结束使用均写放弃时刻，后继号码等待起点为空且两号码计时彼此独立', async () => {
    let now = new Date('2026-08-06T09:00:00.000Z');
    const activationIds: string[] = [];
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        const activationId = `abandon-${activationIds.length + 1}-${randomUUID()}`;
        activationIds.push(activationId);
        return {
          activationId,
          phoneNumber: countryId === 1 ? '+14155550123' : countryId === 2 ? '+442079460123' : '+33142278186',
          activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      // 第一个号码：点开始接收验证码后满两分钟确认换号
      now = new Date('2026-08-06T09:00:00.000Z');
      await app.inject({ method: 'POST', url: `/a/${token}/verification-request` });
      now = new Date('2026-08-06T09:02:00.000Z');
      const replaced = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replaced.statusCode, 303);

      // 第二个号码：等待起点为空、按钮重新出现；点按钮后写自己的等待起点
      const secondPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(secondPage.body, /请把号码填入目标服务后，点击下方按钮开始接收验证码/);
      await app.inject({ method: 'POST', url: `/a/${token}/verification-request` });

      // 第三个号码（已用尽额度）：确认结束使用
      now = new Date('2026-08-06T09:04:00.000Z');
      const ended = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(ended.statusCode, 303);
      now = new Date('2026-08-06T09:06:00.000Z');
      const endUse = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(endUse.statusCode, 303);

      // 三个号码各自独立的等待起点与放弃时刻：两条计时互不覆盖
      const rows = await database.pool.query<{
        provider_activation_id: string; verification_requested_at: Date | null; abandoned_at: Date | null;
      }>(
        'SELECT provider_activation_id, verification_requested_at, abandoned_at FROM supplier_activations WHERE provider_activation_id = ANY($1::text[]) ORDER BY acquired_at',
        [activationIds],
      );
      assert.deepEqual(rows.rows.map((row) => ({
        activation: row.provider_activation_id.slice(0, 8),
        verificationRequestedAt: row.verification_requested_at?.toISOString() ?? null,
        abandonedAt: row.abandoned_at?.toISOString() ?? null,
      })), [
        { activation: activationIds[0]!.slice(0, 8), verificationRequestedAt: '2026-08-06T09:00:00.000Z', abandonedAt: '2026-08-06T09:02:00.000Z' },
        { activation: activationIds[1]!.slice(0, 8), verificationRequestedAt: '2026-08-06T09:02:00.000Z', abandonedAt: '2026-08-06T09:04:00.000Z' },
        { activation: activationIds[2]!.slice(0, 8), verificationRequestedAt: null, abandonedAt: '2026-08-06T09:06:00.000Z' },
      ]);
    } finally { await app.close(); }
  });

  test('管理员撤销与授权到期收尾驱动的取消不写放弃时刻', async () => {
    let now = new Date('2026-08-07T00:00:00.000Z');
    const revokeActivationId = `abandon-revoke-${randomUUID()}`;
    let revokeCancelCalls = 0;
    let getNumberCalls = 0;
    let expiryCancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 1) {
          return {
            activationId: revokeActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
            activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
          };
        }
        // 第二个授权：领取发生在 08-07 12:00，领取截止 = 08-08 12:00；
        // 供应商取得时间恰为截止时刻，不交付并留给授权到期收尾取消。
        now = new Date('2026-08-08T12:00:00.000Z');
        return {
          activationId: `abandon-expiry-${randomUUID()}`, phoneNumber: '+442079460123', activationCost: 0.8, currency: 'USD',
          activationTime: new Date('2026-08-08T12:00:00.000Z'), activationEndTime: new Date('2026-08-08T12:20:00.000Z'),
        };
      },
      cancelActivation: async (activationId) => {
        if (activationId === revokeActivationId) revokeCancelCalls += 1;
        else expiryCancelCalls += 1;
        return 'cancelled';
      },
    });
    const { app, database } = await openApplication(heroSms, () => now);
    let expiryToken = '';
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);

      // 管理员撤销：确认后由撤销专用取消路径收尾，不写放弃时刻
      const firstCreated = await createAuthorization(app, session);
      const firstToken = firstCreated.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(firstToken);
      await app.inject({ method: 'POST', url: `/a/${firstToken}/numbers` });
      now = new Date('2026-08-07T00:02:00.000Z');
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const firstId = authorizationIdFromHome(home.body, firstToken);
      await post(app, session, `/${config.adminPath}/authorizations/${firstId}/revoke`, {});
      assert.equal(revokeCancelCalls, 1);
      const revokeRow = await database.pool.query<{ status: string; abandoned_at: Date | null }>(
        'SELECT status, abandoned_at FROM supplier_activations WHERE provider_activation_id = $1', [revokeActivationId],
      );
      assert.equal(revokeRow.rows[0]?.status, 'cancelled');
      assert.equal(revokeRow.rows[0]?.abandoned_at, null, '管理员撤销驱动的取消不得写放弃时刻');

      // 授权到期收尾：领取跨过截止不交付后，重启由到期取消任务收尾，不写放弃时刻
      const secondCreated = await createAuthorization(app, session);
      expiryToken = secondCreated.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(expiryToken);
      now = new Date('2026-08-07T12:00:00.000Z');
      const response = await app.inject({ method: 'POST', url: `/a/${expiryToken}/numbers` });
      assert.equal(response.statusCode, 404);
      assert.equal(expiryCancelCalls, 0, '供应商尚未允许取消时应保留持久取消任务');
    } finally { await app.close(); }

    now = new Date('2026-08-08T12:02:00.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(expiryCancelCalls, 1);
      const expiryRow = await restarted.database.pool.query<{ status: string; abandoned_at: Date | null }>(
        `SELECT activation.status, activation.abandoned_at
         FROM supplier_activations activation
         JOIN activation_authorizations auth ON auth.id = activation.authorization_id
         WHERE auth.token_hash = $1`, [tokenHash(expiryToken)],
      );
      assert.equal(expiryRow.rows[0]?.status, 'cancelled');
      assert.equal(expiryRow.rows[0]?.abandoned_at, null, '授权到期收尾驱动的取消不得写放弃时刻');
    } finally { await restarted.app.close(); }
  });

  test('管理员详情供应商激活卡片展示等待起点、送达或放弃时刻与等待耗时：成功号等多久收到、放弃号等多久放弃、未点按钮号未记录、超时不套指标、历史号码占位', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    await resetTablesBeforeApplication();
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
      await database.pool.query("UPDATE activation_authorizations SET status = 'ended', ended_at = $2, ended_reason = 'acquisition_expired', token_hash = NULL WHERE id = $1", [authorizationId, now]);
      const activationIds = ['success', 'abandoned', 'unrecorded', 'timedout'].map((suffix) => `${suffix}-${randomUUID()}`);
      for (const [index] of activationIds.entries()) {
        await database.pool.query(
          `INSERT INTO authorization_candidate_countries (authorization_id, position, country_id, country_name, used_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [authorizationId, index + 1, index + 1, ['美国', '英国', '法国', '德国'][index], now],
        );
      }
      // 成功号：已点按钮 + 短信送达；放弃号：已点按钮 + 换号确认放弃；
      // 未记录号：未点按钮但短信已送达；超时号：已点按钮但无送达无放弃；
      // 其中放弃号与超时号号码已被领域删除（phone_number 为空），成功号保留号码作为敏感窗口事实。
      for (const [index, activationId] of activationIds.entries()) {
        await database.pool.query(
          `INSERT INTO supplier_activations
             (authorization_id, candidate_position, country_id, provider_activation_id, status, activation_cost, currency,
              acquired_at, cancel_available_at, expires_at, phone_number,
              verification_requested_at, abandoned_at, sms_received_at, timeout_final_status_confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $7, $8, $9, $10, $11, $12, $13)`,
          [
            authorizationId, index + 1, index + 1, activationId,
            index === 0 ? 'sms_delivered' : index === 1 ? 'cancelled' : index === 2 ? 'completed' : 'timed_out',
            [0.8, 1.25, 2, 3][index], new Date(now.getTime() + index), new Date('2026-08-10T00:20:00.000Z'),
            index === 0 ? '+14155550123' : null,
            index === 0 ? now : index === 1 ? new Date(now.getTime() + 60_000) : index === 2 ? null : new Date(now.getTime() + 120_000),
            index === 1 ? new Date(now.getTime() + 180_000) : null,
            index === 0 ? new Date(now.getTime() + 300_000) : index === 2 ? new Date(now.getTime() + 240_000) : null,
            // 超时号已确认最终状态：初始化不会再把它改判为 manual_reconciliation，避免与短信已送达行撞唯一部分索引
            index === 3 ? now : null,
          ],
        );
      }

      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.equal(detail.statusCode, 200);

      // 成功号：等待起点、短信送达时刻与“等多久收到”，完整号码可见
      assert.match(detail.body, /位置 1 · 美国：<\/strong>📨 短信已送达，获取时间 08-10 08:00，激活 ID success-/);
      assert.match(detail.body, /完整号码：<\/strong>\+14155550123/);
      assert.match(detail.body, /等待起点 08-10 08:00，短信送达 08-10 08:05，等多久收到：等 5 分 0 秒/);

      // 放弃号：等待起点、放弃时刻与“等多久放弃”，号码已删除显示占位
      assert.match(detail.body, /位置 2 · 英国：<\/strong>↩️ 已取消，获取时间 08-10 08:00，激活 ID abandoned-/);
      assert.match(detail.body, /完整号码：<\/strong>（已删除）/);
      assert.match(detail.body, /等待起点 08-10 08:01，放弃时刻 08-10 08:03，等多久放弃：等 2 分 0 秒/);

      // 未记录号：等待起点与等待耗时均标未记录，短信送达时刻单独展示
      assert.match(detail.body, /位置 3 · 法国：<\/strong>✅ 已完成，获取时间 08-10 08:00，激活 ID unrecorded-/);
      assert.match(detail.body, /等待起点未记录，短信送达 08-10 08:04，等待耗时未记录/);

      // 超时号：不套等多久收到或等多久放弃指标，只展示状态与已有时间字段
      assert.match(detail.body, /位置 4 · 德国：<\/strong>⏰ 已超时，获取时间 08-10 08:00，激活 ID timedout-/);
      assert.match(detail.body, /等待起点 08-10 08:02/);
      const timedOutRow = detail.body.match(/<li><strong>位置 4 · 德国：<\/strong>[\s\S]*?<\/li>/)?.[0];
      assert.ok(timedOutRow);
      assert.doesNotMatch(timedOutRow, /等多久收到|等多久放弃/);

      // 列表页不加等待耗时或相关时间戳
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.doesNotMatch(home.body, /等多久收到|等多久放弃|等待起点|等待耗时/);
    } finally { await app.close(); }
  });

  test('地区不在呼叫代码映射表时接收者页面整号显示并整号复制', async () => {
    let now = new Date('2026-08-04T20:00:00.000Z');
    const activationId = `unknown-region-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '未知地区' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.11);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /未知地区/);
      assert.doesNotMatch(page.body, /\(\+1\)/);
      assert.match(page.body, /\+1 415 555 0123/, '地区未知时整号显示');
      assert.match(page.body, /data-copy-value="\+14155550123"/, '地区未知时整号复制');
    } finally { await app.close(); }
  });

  test('供应商号码与地区呼叫代码不匹配时接收者页面整号显示并整号复制', async () => {
    let now = new Date('2026-08-04T21:00:00.000Z');
    const activationId = `code-mismatch-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        assert.equal(countryId, 1, '首位置应为美国');
        return {
          activationId, phoneNumber: '+442079460123', activationCost: 0.8, currency: 'USD', activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const page = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /美国/);
      assert.doesNotMatch(page.body, /\(\+1\)/, '拆分失败时国家信息行不带呼叫代码');
      assert.match(page.body, /\+44 20 7946 0123/, '号码与地区呼叫代码不匹配时整号显示');
      assert.match(page.body, /data-copy-value="\+442079460123"/, '号码与地区呼叫代码不匹配时整号复制');
    } finally { await app.close(); }
  });

  test('供应商激活卡片：非终态激活高亮展示，终态自动降级为无高亮历史行且格式满足获取时间在激活ID之前', async () => {
    let now = new Date('2026-09-10T00:00:00.000Z');
    const { app, database } = await openApplication(scriptedHeroSms(), () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      // 领取并获取号码，进入 waiting_sms (非终态)
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);

      // 1. 在 waiting_sms 状态时，应当渲染高亮行 (class="activation-current")
      const detailActive = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.equal(detailActive.statusCode, 200);
      assert.match(detailActive.body, /<li class="activation-current">/);
      assert.match(detailActive.body, /位置 1 · 美国：<\/strong>.*等待短信/);
      assert.match(detailActive.body, /号码有效至：/);
      assert.match(detailActive.body, /激活 ID activation-1/);
      assert.match(detailActive.body, /费用 0\.80 USD/);
      assert.doesNotMatch(detailActive.body, /<li class="activation-current">[^<]*获取时间/);

      // 2. 模拟短信送达 (进入 completion_confirming 状态，仍属于 ACTIVE_ACTIVATION_STATUSES)
      const actRes = await database.pool.query<{ provider_activation_id: string }>(
        'SELECT provider_activation_id FROM supplier_activations WHERE authorization_id = $1', [id],
      );
      const actId = actRes.rows[0]?.provider_activation_id; assert.ok(actId);
      await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`,
        payload: { activationId: actId, service: 'openai', country: 1, receivedAt: '2026-09-10T00:02:00.000Z', code: '888999', text: 'Your code is 888999' },
      });

      // 3. 跨过 5 分钟后触发完成确认，状态进入 completed 终态
      now = new Date('2026-09-10T00:08:00.000Z');
      await database.pool.query("UPDATE supplier_activations SET status = 'completed', completed_at = $2 WHERE provider_activation_id = $1", [actId, now]);

      // 4. 变成 completed 终态后，应当不包含 activation-current 高亮行，原激活降级为普通历史行
      const detailCompleted = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.equal(detailCompleted.statusCode, 200);
      assert.doesNotMatch(detailCompleted.body, /class="activation-current"/);
      assert.doesNotMatch(detailCompleted.body, /号码有效至/);
      assert.match(detailCompleted.body, /位置 1 · 美国：<\/strong>✅ 已完成，获取时间 09-10 08:00，激活 ID activation-1，费用 0\.80 USD/);
      // 验证“获取时间”位于“激活 ID”之前
      const acquiredAtPos = detailCompleted.body.indexOf('获取时间');
      const activationIdPos = detailCompleted.body.indexOf('激活 ID activation-1');
      assert.ok(acquiredAtPos > 0 && activationIdPos > 0 && acquiredAtPos < activationIdPos, '获取时间必须位于激活 ID 之前');
      assert.match(detailCompleted.body, /位置 2 · 英国：<\/strong>⬜ 未消耗/);
      assert.match(detailCompleted.body, /位置 3 · 法国：<\/strong>⬜ 未消耗/);
    } finally { await app.close(); }
  });

  test('对账遇供应商仍在等待短信 → 重发取消 → 供应商确认取消 → 激活进入终局', async () => {
    let now = new Date('2026-08-20T10:00:00.000Z');
    const firstActivationId = `reconcile-waiting-${randomUUID()}`;
    let getNumberCalls = 0;
    const failedCancellations = new Set<string>();
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? firstActivationId : `reconcile-waiting-next-${randomUUID()}`,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async (activationId) => {
        // 每个激活的首次取消请求结果不明确（网络抖动），重发后才返回成功。
        if (!failedCancellations.has(activationId)) {
          failedCancellations.add(activationId);
          throw new HeroSmsResponseError('uncertain');
        }
        return 'cancelled';
      },
      activationStatus: async () => ({ delivered: false }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 303);

      now = new Date('2026-08-20T10:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      // 首次取消结果不明确 → 进入“取消确认中”，换号请求挂起等待对账。
      assert.equal(replacing.statusCode, 202);

      // 管理详情页刷新触发对账：供应商仍在等待短信 → 重发取消 → 供应商确认取消。
      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });

      const state = await database.pool.query<{ status: string }>(
        'SELECT status FROM supplier_activations WHERE provider_activation_id = $1', [firstActivationId],
      );
      assert.equal(state.rows[0]?.status, 'cancelled');
      // 换号收尾：确认取消后自动获取后继号码并回到等待短信。
      const successor = await database.pool.query<{ status: string }>(
        `SELECT status FROM supplier_activations
         WHERE authorization_id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)
           AND provider_activation_id <> $1`, [firstActivationId],
      );
      assert.equal(successor.rows[0]?.status, 'waiting_sms');
    } finally { await app.close(); }
  });

  test('对账重发取消返回 too-early → 回退等待短信并带 60 秒重试标记', async () => {
    let now = new Date('2026-08-20T11:00:00.000Z');
    const activationId = `reconcile-too-early-${randomUUID()}`;
    const failedCancellations = new Set<string>();
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123',
        activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async (id) => {
        if (!failedCancellations.has(id)) {
          failedCancellations.add(id);
          throw new HeroSmsResponseError('uncertain');
        }
        return 'too-early';
      },
      activationStatus: async () => ({ delivered: false }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T11:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);

      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });

      const state = await database.pool.query<{ status: string; cancellation_retry_after: Date | null }>(
        'SELECT status, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'waiting_sms');
      assert.ok(state.rows[0]?.cancellation_retry_after);
      assert.equal(state.rows[0]?.cancellation_retry_after.getTime(), now.getTime() + 60_000);
    } finally { await app.close(); }
  });

  test('取消对账遇等待短信重发取消返回 sms-delivered → 读取最新状态 → 按短信送达收尾并交付验证码', async () => {
    let now = new Date('2026-08-20T11:30:00.000Z');
    const activationId = `reconcile-resend-sms-delivered-${randomUUID()}`;
    let statusCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123',
        activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        // 换号确认时的首次取消结果不明确 → 进入取消确认中；对账重发取消时短信恰好送达。
        if (cancelCalls === 1) throw new HeroSmsResponseError('uncertain');
        return 'sms-delivered';
      },
      activationStatus: async () => {
        statusCalls += 1;
        // 对账先读到等待短信（归一化后的对象形式等待响应），重发取消返回 sms-delivered 后重新读取最新状态。
        if (statusCalls === 1) return { delivered: false };
        return {
          delivered: true, code: '654321', text: 'Your code is 654321',
          receivedAt: new Date('2026-08-20T11:31:00.000Z'),
        };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T11:32:05.000Z');
      // 换号/结束使用路由会把取消确认调度器按数据库中最早到期时间重排：
      // 重试期限为空时以 0 延迟触发对账，读到等待短信 → 重发取消 → sms-delivered → 读取最新状态 → webhook 交付。
      const { output } = await withCapturedStdout(async () => {
        const replacing = await app.inject({
          method: 'POST', url: `/a/${token}/replacement/confirm`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'replacement=confirm',
        });
        assert.equal(replacing.statusCode, 202);
        // 等到 webhook 交付事务落库（completion_confirming）再断言，
        // 避免只等到重发取消开始就对账尚未收尾时执行断言造成竞态。
        let deliveredStatus: string | undefined;
        await waitFor(() => {
          void database.pool.query<{ status: string }>(
            'SELECT status FROM supplier_activations WHERE provider_activation_id = $1',
            [activationId],
          ).then((result) => { deliveredStatus = result.rows[0]?.status; });
          return deliveredStatus === 'completion_confirming';
        }, 3_000);
      });
      assert.doesNotMatch(output, /\[herosms\]\[(warn|error)\]/, '等待短信与送达收尾不产生告警日志');

      assert.equal(statusCalls, 2, '对账先读等待状态，重发取消返回 sms-delivered 后重新读取最新状态');
      assert.equal(cancelCalls, 2, '等待短信触发一次重发取消');

      const state = await database.pool.query<{
        status: string; sms_code: string | null; sms_text: string | null; sms_received_at: Date | null;
      }>(
        'SELECT status, sms_code, sms_text, sms_received_at FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'completion_confirming', '短信送达后按完成收尾');
      assert.equal(state.rows[0]?.sms_code, '654321');
      assert.equal(state.rows[0]?.sms_text, 'Your code is 654321');
      assert.equal(state.rows[0]?.sms_received_at?.toISOString(), '2026-08-20T11:31:00.000Z');

      const authorization = await database.pool.query<{ status: string }>(
        'SELECT status FROM activation_authorizations WHERE id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)',
        [activationId],
      );
      assert.equal(authorization.rows[0]?.status, 'result_available', 'webhook 交付把授权推进到结果可查看');

      // 接收者视角：验证码已交付可查看，且不再提供换号/结束使用操作。
      const recipientPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(recipientPage.statusCode, 200);
      assert.match(recipientPage.body, /654321/);
      assert.doesNotMatch(recipientPage.body, /更换号码|结束使用/);
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('对账发现短信已送达且时间落在号码窗口内 → 复用短信接收逻辑交付或完成收尾', async () => {
    let now = new Date('2026-08-20T12:00:00.000Z');
    const activationId = `reconcile-delivered-${randomUUID()}`;
    const failedCancellations = new Set<string>();
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123',
        activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async (id) => {
        failedCancellations.add(id);
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => ({
        delivered: true, code: '654321', text: 'Your code is 654321',
        receivedAt: new Date('2026-08-20T12:01:00.000Z'),
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T12:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);

      // 对账发现短信已在号码窗口内送达：复用短信接收逻辑，按完成路径收尾。
      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });

      const state = await database.pool.query<{ status: string; sms_code: string | null }>(
        'SELECT status, sms_code FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'completion_confirming');
      assert.equal(state.rows[0]?.sms_code, '654321');
    } finally { await app.close(); }
  });

  test('撤销时激活已处于取消确认中且短信已送达 → 触发对账 → 按完成收尾、不恢复接收者访问', async () => {
    let now = new Date('2026-08-20T13:00:00.000Z');
    let getNumberCalls = 0;
    const firstActivationId = `reconcile-revoke-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? firstActivationId : `reconcile-revoke-next-${randomUUID()}`,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => {
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => ({
        delivered: true, code: '112233', text: 'Your code is 112233',
        receivedAt: new Date('2026-08-20T13:01:00.000Z'),
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T13:02:05.000Z');
      await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });

      // 撤销触发立即对账：短信已送达 → 按完成收尾，且不恢复接收者访问。
      await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});

      const state = await database.pool.query<{ status: string; phone_number: string | null }>(
        'SELECT status, phone_number FROM supplier_activations WHERE provider_activation_id = $1',
        [firstActivationId],
      );
      assert.equal(state.rows[0]?.status, 'completion_confirming');
      assert.equal(state.rows[0]?.phone_number, null, '撤销单敏感数据应清除');

      const recipientPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(recipientPage.statusCode, 404, '接收者访问权限不恢复');
    } finally { await app.close(); }
  });

  test('撤销单短信送达时间在号码窗口外 → 对账仍按完成收尾并清除敏感数据，不恢复接收者访问', async () => {
    let now = new Date('2026-08-20T14:00:00.000Z');
    const activationId = `reconcile-revoked-late-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => ({
        delivered: true, code: '998877', text: 'Your code is 998877',
        receivedAt: new Date('2026-08-20T14:25:00.000Z'), // 窗口 [14:00, 14:20) 之外
      }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T14:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);

      // 号码窗口结束后短信才送达（14:25 在窗口 [14:00, 14:20) 之外）；撤销触发立即对账：
      // 撤销单不受窗口约束，按完成收尾并释放号码。
      now = new Date('2026-08-20T14:25:00.000Z');
      await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});

      const state = await database.pool.query<{ status: string; phone_number: string | null }>(
        'SELECT status, phone_number FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'completion_confirming');
      assert.equal(state.rows[0]?.phone_number, null, '撤销单敏感数据应清除');

      const recipientPage = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(recipientPage.statusCode, 404, '接收者访问权限不恢复');
    } finally { await app.close(); }
  });

  test('撤销时激活已处于取消确认中且短信未送达 → 对账重发取消 → 供应商确认取消 → 进入终局', async () => {
    let now = new Date('2026-08-20T15:00:00.000Z');
    const activationId = `reconcile-revoke-waiting-${randomUUID()}`;
    const failedCancellations = new Set<string>();
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async (id) => {
        // 首次取消结果不明确（网络抖动），对账重发后才确认取消。
        if (!failedCancellations.has(id)) {
          failedCancellations.add(id);
          throw new HeroSmsResponseError('uncertain');
        }
        return 'cancelled';
      },
      activationStatus: async () => ({ delivered: false }),
    });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T15:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);

      // 撤销触发立即对账：供应商仍在等待短信 → 重发取消 → 确认取消进入终局。
      await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});

      const state = await database.pool.query<{ status: string }>(
        'SELECT status FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'cancelled');
    } finally { await app.close(); }
  });

  test('供应商请求异常后写入 60 秒重试期限，期限前连续刷新管理员详情不增加供应商调用次数', async () => {
    let now = new Date('2026-08-20T16:00:00.000Z');
    const activationId = `retry-backoff-${randomUUID()}`;
    let activationStatusCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123',
        activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        activationStatusCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T16:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);
      assert.equal(cancelCalls, 1);

      // 首次对账：claim 先行持久化 60 秒重试期限，随后供应商状态查询异常，记录保持取消确认中。
      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      const state = await database.pool.query<{ status: string; cancellation_retry_after: Date | null }>(
        'SELECT status, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'cancellation_confirming');
      assert.ok(state.rows[0]?.cancellation_retry_after);
      assert.equal(state.rows[0]?.cancellation_retry_after.getTime(), now.getTime() + 60_000);
      assert.equal(activationStatusCalls, 1);

      // 期限前连续刷新管理员详情：任何入口都不绕过重试期限，供应商调用次数保持不变。
      for (let i = 0; i < 3; i += 1) {
        await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      }
      assert.equal(activationStatusCalls, 1);
      assert.equal(cancelCalls, 1);
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('期限恰好到达时允许一次新对账，未收敛后重新延后约 60 秒', async () => {
    let now = new Date('2026-08-20T16:30:00.000Z');
    const activationId = `retry-exact-${randomUUID()}`;
    let activationStatusCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123',
        activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async () => {
        activationStatusCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T16:32:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);

      // 第一次对账后重试期限为 16:33:05，恰好到期前不再对账。
      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.equal(activationStatusCalls, 1);

      // 期限恰好到达：允许一次新的对账；仍未收敛后重新延后约 60 秒。
      now = new Date('2026-08-20T16:33:05.000Z');
      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.equal(activationStatusCalls, 2);
      const state = await database.pool.query<{ cancellation_retry_after: Date | null }>(
        'SELECT cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('启动对账、后台扫描与立即对账均只处理已到期的取消确认记录', async () => {
    let now = new Date('2026-08-20T17:00:00.000Z');
    const firstId = `eligibility-locked-${randomUUID()}`;
    const secondId = `eligibility-due-${randomUUID()}`;
    let getNumberCalls = 0;
    let tokens: string[] = [];
    // 阶段一：造两条取消确认记录，一条重试期限未到期、一条已到期。
    await resetTablesBeforeApplication();
    const seeding = await openApplication(scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? firstId : secondId,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async () => { throw new HeroSmsResponseError('uncertain'); },
    }), () => now);
    try {
      await resetAuthorizationTables(seeding.database);
      const session = await login(seeding.app);
      const created = await createBatch(seeding.app, session, '2');
      tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(tokens.length, 2);
      for (const token of tokens) {
        await seeding.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        now = new Date(now.getTime() + 2 * 60_000);
        const replacing = await seeding.app.inject({
          method: 'POST', url: `/a/${token}/replacement/confirm`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'replacement=confirm',
        });
        assert.equal(replacing.statusCode, 202);
      }
      // 第一条记录打上未到期重试期限（模拟此前对账未收敛后延后），第二条保持到期。
      await seeding.database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [firstId, new Date(now.getTime() + 10 * 60_000)],
      );
      // 全路径唤醒（issue #07）下专用调度器已按到期时间对两条记录各执行过一轮对账：
      // 显式把第二条恢复为到期状态，保持“一条未到期、一条已到期”的测试前提。
      await seeding.database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = NULL
         WHERE provider_activation_id = $1`,
        [secondId],
      );
    } finally { await seeding.app.close(); }

    // 阶段二：重启应用触发启动对账；后台扫描与启动对账调用同一对账入口，共享同一资格规则。
    const statusCalls: string[] = [];
    const { app, database } = await openApplication(scriptedHeroSms({
      getNumber: async () => { throw new Error('不应再获取号码'); },
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async (id) => {
        statusCalls.push(id);
        throw new HeroSmsResponseError('uncertain');
      },
    }), () => now);
    try {
      assert.deepEqual(statusCalls, [secondId], '启动对账只处理已到期记录');
      statusCalls.length = 0;
      const session = await login(app);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = listArticles(home.body).find((article) => article.suffix === tokens[0]!.slice(-8))?.id;
      assert.ok(authorizationId);
      // 详情刷新（立即对账入口）在期限前不得处理未到期记录。
      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.deepEqual(statusCalls, [], '立即对账在期限前不得处理未到期记录');

      // 撤销立即对账入口：第二条记录恢复到期后，撤销触发对账只处理它，
      // 未到期记录（第一条）不被撤销入口绕过。
      await database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = NULL
         WHERE provider_activation_id = $1`,
        [secondId],
      );
      statusCalls.length = 0;
      const secondAuthorizationId = listArticles(home.body).find((article) => article.suffix === tokens[1]!.slice(-8))?.id;
      assert.ok(secondAuthorizationId);
      await post(app, session, `/${config.adminPath}/authorizations/${secondAuthorizationId}/revoke`, {});
      assert.deepEqual(statusCalls, [secondId], '撤销立即对账只处理已到期记录');
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('重试期限持久化失败时不产生零延迟供应商请求循环', async () => {
    let now = new Date('2026-08-20T18:00:00.000Z');
    const activationId = `retry-persist-fail-${randomUUID()}`;
    let activationStatusCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123',
        activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        activationStatusCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });

      now = new Date('2026-08-20T18:02:05.000Z');
      // 换号进入取消确认中会立即唤醒专用对账调度器（issue #07 全路径唤醒）：
      // 在请求前安装失败触发器，使首个对账 claim 也确定性落在期限持久化失败路径上，避免与定时器竞争。
      await database.pool.query(`
        CREATE OR REPLACE FUNCTION sms_test_fail_retry_after() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'simulated retry_after persist failure'; END;
        $$ LANGUAGE plpgsql`);
      await database.pool.query(`
        CREATE TRIGGER sms_test_fail_retry_after
        BEFORE UPDATE OF cancellation_retry_after ON supplier_activations
        FOR EACH ROW EXECUTE FUNCTION sms_test_fail_retry_after()`);
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);
      assert.equal(cancelCalls, 1);

      try {
        // 期限无法持久化时本轮不得调用供应商：零延迟循环被阻断在对账 claim 之前。
        for (let i = 0; i < 3; i += 1) {
          const refreshed = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
          assert.equal(refreshed.statusCode, 200);
        }
        assert.equal(activationStatusCalls, 0);
        assert.equal(cancelCalls, 1);
      } finally {
        await database.pool.query('DROP TRIGGER IF EXISTS sms_test_fail_retry_after ON supplier_activations');
        await database.pool.query('DROP FUNCTION IF EXISTS sms_test_fail_retry_after()');
      }

      // 持久化恢复后对账立即恢复正常。
      await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.equal(activationStatusCalls, 1);
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('换号取消返回 too-early 后保留换号意图，60 秒后自动重试并在确认取消后获取后继号码', async () => {
    let now = new Date('2026-08-21T10:00:00.000Z');
    const firstActivationId = `replacement-too-early-${randomUUID()}`;
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? firstActivationId : `replacement-too-early-next-${randomUUID()}`,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => {
        cancelCalls += 1;
        return cancelCalls === 1 ? 'too-early' : 'cancelled';
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 303);

      now = new Date('2026-08-21T10:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 409);
      assert.equal(cancelCalls, 1);
      const state = await database.pool.query<{ status: string; replacement_pending: boolean; end_use_pending: boolean; cancellation_retry_after: Date | null }>(
        'SELECT status, replacement_pending, end_use_pending, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [firstActivationId],
      );
      // 换号意图必须保留，回退等待短信并持久化 60 秒重试期限。
      assert.equal(state.rows[0]?.status, 'waiting_sms');
      assert.equal(state.rows[0]?.replacement_pending, true);
      assert.equal(state.rows[0]?.end_use_pending, false);
      assert.equal(state.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await app.close(); }

    // 重试期限到达后重启：启动任务自动重新进入取消流程，确认取消后自动获取后继号码。
    now = new Date('2026-08-21T10:03:05.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 2);
      const old = await restarted.database.pool.query<{ status: string; replacement_pending: boolean; cancellation_retry_after: Date | null }>(
        'SELECT status, replacement_pending, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [firstActivationId],
      );
      assert.equal(old.rows[0]?.status, 'cancelled');
      assert.equal(old.rows[0]?.replacement_pending, false);
      assert.equal(old.rows[0]?.cancellation_retry_after, null);
      const successor = await restarted.database.pool.query<{ status: string }>(
        `SELECT status FROM supplier_activations
         WHERE authorization_id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)
           AND provider_activation_id <> $1`, [firstActivationId],
      );
      assert.equal(successor.rows[0]?.status, 'waiting_sms');
      assert.equal(getNumberCalls, 2);
    } finally { await restarted.app.close();
        const cleanup = new Database(databaseUrl!);
        try { await resetAuthorizationTables(cleanup); } finally { await cleanup.close(); } }
  });

  test('结束使用取消返回 too-early 后保留结束意图，60 秒后自动重试并进入既定终局', async () => {
    let now = new Date('2026-08-21T11:00:00.000Z');
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: `end-use-too-early-${getNumberCalls}-${randomUUID()}`,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => {
        cancelCalls += 1;
        return cancelCalls === 3 ? 'too-early' : 'cancelled';
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    const activateIds: string[] = [];
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 303);
      const replace = async (): Promise<void> => {
        const response = await app.inject({
          method: 'POST', url: `/a/${token}/replacement/confirm`,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'replacement=confirm',
        });
        assert.equal(response.statusCode, 303);
      };

      // 前两个号码换号成功并自动获取后继号码；第三个号码已用尽额度，结束使用取消返回 too-early。
      now = new Date('2026-08-21T11:02:05.000Z');
      await replace();
      now = new Date('2026-08-21T11:04:10.000Z');
      await replace();
      now = new Date('2026-08-21T11:06:15.000Z');
      const ending = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(ending.statusCode, 409);
      assert.equal(getNumberCalls, 3);
      assert.equal(cancelCalls, 3);
      const thirdActivation = await database.pool.query<{ provider_activation_id: string; status: string; replacement_pending: boolean; end_use_pending: boolean; cancellation_retry_after: Date | null }>(
        `SELECT provider_activation_id, status, replacement_pending, end_use_pending, cancellation_retry_after
         FROM supplier_activations ORDER BY acquired_at DESC LIMIT 1`,
      );
      activateIds.push(thirdActivation.rows[0]!.provider_activation_id);
      // 结束使用意图必须保留，回退等待短信并持久化 60 秒重试期限。
      assert.equal(thirdActivation.rows[0]?.status, 'waiting_sms');
      assert.equal(thirdActivation.rows[0]?.replacement_pending, false);
      assert.equal(thirdActivation.rows[0]?.end_use_pending, true);
      assert.equal(thirdActivation.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await app.close(); }

    // 重试期限到达后重启：自动重试结束使用取消并进入额度用尽终局。
    now = new Date('2026-08-21T11:07:15.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 4);
      const terminal = await restarted.database.pool.query<{ authorization_status: string; ended_reason: string | null; activation_status: string }>(
        `SELECT auth.status AS authorization_status, auth.ended_reason, activation.status AS activation_status
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`,
        [activateIds[0]!],
      );
      assert.equal(terminal.rows[0]?.authorization_status, 'ended');
      assert.equal(terminal.rows[0]?.ended_reason, 'quota_exhausted');
      assert.equal(terminal.rows[0]?.activation_status, 'cancelled');
      assert.equal(getNumberCalls, 3, '结束使用后不得获取第四个号码');
    } finally { await restarted.app.close();
        const cleanup = new Database(databaseUrl!);
        try { await resetAuthorizationTables(cleanup); } finally { await cleanup.close(); } }
  });

  test('管理员撤销取消返回 too-early 后保持访问已切断，60 秒后自动重试并收尾', async () => {
    let now = new Date('2026-08-21T12:00:00.000Z');
    const activationId = `revoked-too-early-issue06-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        return cancelCalls === 1 ? 'too-early' : 'cancelled';
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);

      now = new Date('2026-08-21T12:02:05.000Z');
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${authorizationId}/revoke`, {})).statusCode, 303);
      assert.equal(cancelCalls, 1);
      // 访问已切断，接收者页面立即 404。
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
      const state = await database.pool.query<{ status: string; authorization_revocation_cancellation_pending: boolean; cancellation_retry_after: Date | null }>(
        `SELECT status, authorization_revocation_cancellation_pending, cancellation_retry_after
         FROM supplier_activations WHERE provider_activation_id = $1`, [activationId],
      );
      // 撤销意图保留：回退等待短信并持久化 60 秒重试期限。
      assert.equal(state.rows[0]?.status, 'waiting_sms');
      assert.equal(state.rows[0]?.authorization_revocation_cancellation_pending, true);
      assert.equal(state.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await app.close(); }

    // 重试期限到达后重启：撤销取消自动重试并确认取消收尾。
    now = new Date('2026-08-21T12:03:05.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 2);
      const terminal = await restarted.database.pool.query<{ status: string; authorization_revocation_cancellation_pending: boolean; refund_confirmed: boolean }>(
        `SELECT activation.status, activation.authorization_revocation_cancellation_pending,
                (refund.amount IS NOT NULL) AS refund_confirmed
         FROM supplier_activations activation
         LEFT JOIN supplier_activation_refunds refund ON refund.supplier_activation_id = activation.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.equal(terminal.rows[0]?.status, 'cancelled');
      assert.equal(terminal.rows[0]?.authorization_revocation_cancellation_pending, false);
      assert.equal(terminal.rows[0]?.refund_confirmed, true);
    } finally { await restarted.app.close();
        const cleanup = new Database(databaseUrl!);
        try { await resetAuthorizationTables(cleanup); } finally { await cleanup.close(); } }
  });

  test('授权到期取消返回 too-early 后仍能自动重试，不因提前清除 pending 标记而滞留', async () => {
    let now = new Date('2026-08-26T00:00:00.000Z');
    const activationId = `expiry-too-early-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        // 供应商取得时间恰为领取截止时刻，跨截止确认不交付并留下授权到期取消任务。
        now = new Date('2026-08-27T00:00:00.000Z');
        return {
          activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: new Date('2026-08-27T00:00:00.000Z'), activationEndTime: new Date('2026-08-27T00:20:00.000Z'),
        };
      },
      cancelActivation: async () => {
        cancelCalls += 1;
        return cancelCalls === 1 ? 'too-early' : 'cancelled';
      },
    });
    await resetTablesBeforeApplication();
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const response = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(response.statusCode, 404);
      assert.equal(cancelCalls, 0);
    } finally { await app.close(); }

    // 允许取消后首次取消返回 too-early：保留到期 pending 标记并持久化 60 秒重试期限。
    now = new Date('2026-08-27T00:02:05.000Z');
    const tooEarly = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1);
      const state = await tooEarly.database.pool.query<{ status: string; authorization_expiry_cancellation_pending: boolean; cancellation_retry_after: Date | null }>(
        `SELECT status, authorization_expiry_cancellation_pending, cancellation_retry_after
         FROM supplier_activations WHERE provider_activation_id = $1`, [activationId],
      );
      assert.equal(state.rows[0]?.status, 'waiting_sms');
      assert.equal(state.rows[0]?.authorization_expiry_cancellation_pending, true);
      assert.equal(state.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await tooEarly.app.close(); }

    // 重试期限前重启：不得零延迟重试供应商。
    now = new Date('2026-08-27T00:02:30.000Z');
    const beforeRetry = await openApplication(heroSms, () => now);
    try { assert.equal(cancelCalls, 1); } finally { await beforeRetry.app.close(); }

    // 重试期限到达后重启：自动重试并确认取消收尾。
    now = new Date('2026-08-27T00:03:05.000Z');
    const retried = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 2);
      const terminal = await retried.database.pool.query<{ status: string; authorization_expiry_cancellation_pending: boolean }>(
        `SELECT status, authorization_expiry_cancellation_pending
         FROM supplier_activations WHERE provider_activation_id = $1`, [activationId],
      );
      assert.equal(terminal.rows[0]?.status, 'cancelled');
      assert.equal(terminal.rows[0]?.authorization_expiry_cancellation_pending, false);
    } finally { await retried.app.close(); }
  });

  test('重试期限前的重复用户操作不调用供应商，也不覆盖原操作意图', async () => {
    let now = new Date('2026-08-21T13:00:00.000Z');
    const activationId = `repeated-action-too-early-${randomUUID()}`;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { cancelCalls += 1; return 'too-early'; },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 303);
      const confirmReplacement = async (): Promise<number> => (await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      })).statusCode;

      now = new Date('2026-08-21T13:02:05.000Z');
      assert.equal(await confirmReplacement(), 409);
      assert.equal(cancelCalls, 1);
      const retryAfter = new Date('2026-08-21T13:03:05.000Z');
      const before = await database.pool.query<{ replacement_pending: boolean; end_use_pending: boolean; cancellation_retry_after: Date | null }>(
        'SELECT replacement_pending, end_use_pending, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(before.rows[0]?.replacement_pending, true);
      assert.equal(before.rows[0]?.end_use_pending, false);
      assert.equal(before.rows[0]?.cancellation_retry_after?.getTime(), retryAfter.getTime());

      // 期限前重复提交：不调用供应商、不刷新重试期限、不覆盖换号意图。
      now = new Date('2026-08-21T13:02:30.000Z');
      assert.equal(await confirmReplacement(), 409);
      assert.equal(cancelCalls, 1);
      const after = await database.pool.query<{ status: string; replacement_pending: boolean; end_use_pending: boolean; cancellation_retry_after: Date | null }>(
        'SELECT status, replacement_pending, end_use_pending, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(after.rows[0]?.status, 'waiting_sms');
      assert.equal(after.rows[0]?.replacement_pending, true);
      assert.equal(after.rows[0]?.end_use_pending, false);
      assert.equal(after.rows[0]?.cancellation_retry_after?.getTime(), retryAfter.getTime());
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('领取截止后的结束使用取消返回 too-early 后保留结束意图，60 秒后自动重试并收尾', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const activationId = `deadline-end-use-too-early-${randomUUID()}`;
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        // 领取发生在 08-01 00:00，领取截止 = 08-02 00:00；供应商在截止前 1 毫秒取得号码，窗口跨过截止
        now = new Date('2026-08-01T23:59:59.999Z');
        return { activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      cancelActivation: async () => {
        cancelCalls += 1;
        return cancelCalls === 1 ? 'too-early' : 'cancelled';
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    let token = '';
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]!; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      now = new Date('2026-08-02T00:05:00.000Z');
      const ending = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(ending.statusCode, 409);
      assert.equal(cancelCalls, 1);
      const state = await database.pool.query<{ status: string; replacement_pending: boolean; end_use_pending: boolean; cancellation_retry_after: Date | null }>(
        'SELECT status, replacement_pending, end_use_pending, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      // 领取截止后的结束使用意图同样保留，并持久化 60 秒重试期限。
      assert.equal(state.rows[0]?.status, 'waiting_sms');
      assert.equal(state.rows[0]?.replacement_pending, false);
      assert.equal(state.rows[0]?.end_use_pending, true);
      assert.equal(state.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await app.close(); }

    // 重试期限到达后重启：自动重试结束使用取消，确认取消后不创建后继号码并以领取后期限结束。
    now = new Date('2026-08-02T00:06:00.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 2);
      assert.equal(getNumberCalls, 1, '领取截止后不得创建后继号码');
      const terminal = await restarted.database.pool.query<{ status: string; end_use_pending: boolean; cancellation_retry_after: Date | null }>(
        'SELECT status, end_use_pending, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(terminal.rows[0]?.status, 'cancelled');
      assert.equal(terminal.rows[0]?.end_use_pending, false);
      assert.equal(terminal.rows[0]?.cancellation_retry_after, null);
      // 取消后授权无活跃激活：接收者访问触发领取后期限收尾（或 0 秒调度已先收尾），链接 404。
      const recipient = await restarted.app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(recipient.statusCode, 404);
      const authorization = await restarted.database.pool.query<{ status: string; ended_reason: string | null }>(
        `SELECT auth.status, auth.ended_reason
         FROM activation_authorizations auth
         JOIN supplier_activations activation ON activation.authorization_id = auth.id
         WHERE activation.provider_activation_id = $1`, [activationId],
      );
      assert.equal(authorization.rows[0]?.status, 'ended');
      assert.equal(authorization.rows[0]?.ended_reason, 'acquisition_expired');
    } finally { await restarted.app.close(); }
  });

  test('启动时无待对账记录，普通换号进入取消确认中后按到期时间自动对账，不依赖刷新、webhook 或 60 秒扫描', async () => {
    let now = new Date('2026-08-30T08:00:00.000Z');
    const activationId = `wake-replacement-${randomUUID()}`;
    let cancelCalls = 0;
    let activationStatusCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        activationStatusCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(first.statusCode, 303);

      // 应用启动时没有任何待对账记录，启动调度不武装任何 timer；两分钟后普通换号进入“取消确认中”。
      now = new Date('2026-08-30T08:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);
      assert.equal(cancelCalls, 1);

      // 不刷新管理员详情、不发送 webhook、不访问任何页面：专用调度器按最早到期时间自动对账。
      // 断言预算远小于 60 秒，60 秒全局后台扫描不可能承担本次对账，只可能是换号路由唤醒的精确调度。
      await waitFor(() => activationStatusCalls === 1, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(activationStatusCalls, 1, '对账只发生一次，重试期限已持久化');
      assert.equal(cancelCalls, 1, '对账只查询供应商状态，不重发取消');
      const state = await database.pool.query<{ status: string; cancellation_retry_after: Date | null }>(
        'SELECT status, cancellation_retry_after FROM supplier_activations WHERE provider_activation_id = $1',
        [activationId],
      );
      assert.equal(state.rows[0]?.status, 'cancellation_confirming');
      assert.equal(state.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('结束使用、撤销和授权到期新建或延后对账时间后均重新安排最早 timer', async () => {
    // —— 阶段一：结束使用进入“取消确认中”后重新安排对账调度 ——
    let now = new Date('2026-08-30T10:00:00.000Z');
    let getNumberCalls = 0;
    let cancelCalls = 0;
    let activationStatusCalls = 0;
    const endUseHeroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: `end-use-wake-${getNumberCalls}-${randomUUID()}`,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => {
        cancelCalls += 1;
        if (cancelCalls <= 2) return 'cancelled';
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        activationStatusCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const firstApp = await openApplication(endUseHeroSms, () => now);
    try {
      await resetAuthorizationTables(firstApp.database);
      const session = await login(firstApp.app);
      const created = await createAuthorization(firstApp.app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await firstApp.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      const replace = async (): Promise<number> => (await firstApp.app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      })).statusCode;

      now = new Date('2026-08-30T10:02:05.000Z');
      assert.equal(await replace(), 303);
      now = new Date('2026-08-30T10:04:10.000Z');
      assert.equal(await replace(), 303);
      now = new Date('2026-08-30T10:06:15.000Z');
      assert.equal(await replace(), 202);
      assert.equal(getNumberCalls, 3);
      assert.equal(cancelCalls, 3);
      // 不刷新页面：结束使用进入“取消确认中”后，调度器按到期时间自动对账并保留结束使用意图。
      await waitFor(() => activationStatusCalls >= 1, 2_000);
      const ending = await firstApp.database.pool.query<{ status: string; end_use_pending: boolean; cancellation_retry_after: Date | null }>(
        `SELECT status, end_use_pending, cancellation_retry_after
         FROM supplier_activations ORDER BY acquired_at DESC LIMIT 1`,
      );
      assert.equal(ending.rows[0]?.status, 'cancellation_confirming');
      assert.equal(ending.rows[0]?.end_use_pending, true, '结束使用意图保留');
      assert.equal(ending.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await firstApp.app.close(); }
    const firstCleanup = new Database(databaseUrl!);
    try { await resetAuthorizationTables(firstCleanup); } finally { await firstCleanup.close(); }

    // —— 阶段二：管理员撤销把激活转入“取消确认中”后重新安排对账调度 ——
    now = new Date('2026-08-30T12:00:00.000Z');
    const revokeActivationId = `wake-revoke-${randomUUID()}`;
    cancelCalls = 0;
    activationStatusCalls = 0;
    const revokeHeroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId: revokeActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        activationStatusCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const revokeApp = await openApplication(revokeHeroSms, () => now);
    try {
      await resetAuthorizationTables(revokeApp.database);
      const session = await login(revokeApp.app);
      const created = await createAuthorization(revokeApp.app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await revokeApp.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      const home = await revokeApp.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const authorizationId = authorizationIdFromHome(home.body, token);

      now = new Date('2026-08-30T12:02:05.000Z');
      assert.equal((await post(revokeApp.app, session, `/${config.adminPath}/authorizations/${authorizationId}/revoke`, {})).statusCode, 303);
      assert.equal(cancelCalls, 1);
      // 撤销的立即取消请求异常后记录留在“取消确认中”：调度器按到期时间自动对账，不依赖详情刷新。
      await waitFor(() => activationStatusCalls >= 1, 2_000);
      const revoked = await revokeApp.database.pool.query<{ status: string; authorization_revocation_cancellation_pending: boolean; cancellation_retry_after: Date | null }>(
        `SELECT status, authorization_revocation_cancellation_pending, cancellation_retry_after
         FROM supplier_activations WHERE provider_activation_id = $1`,
        [revokeActivationId],
      );
      assert.equal(revoked.rows[0]?.status, 'cancellation_confirming');
      assert.equal(revoked.rows[0]?.authorization_revocation_cancellation_pending, true, '撤销意图保留');
      assert.equal(revoked.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await revokeApp.app.close(); }
    const revokeCleanup = new Database(databaseUrl!);
    try { await resetAuthorizationTables(revokeCleanup); } finally { await revokeCleanup.close(); }

    // —— 阶段三：授权到期创建新的对账时间后重新安排最早 timer ——
    now = new Date('2026-08-31T10:00:00.000Z');
    const expiryActivationId = `wake-expiry-${randomUUID()}`;
    const normalActivationId = `wake-expiry-normal-${randomUUID()}`;
    getNumberCalls = 0;
    cancelCalls = 0;
    const statusIds: string[] = [];
    const expiryHeroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        if (getNumberCalls === 1) {
          // 第一个授权跨领取截止确认号码：不交付，产生授权到期取消任务。
          now = new Date('2026-09-01T10:00:00.000Z');
          return {
            activationId: expiryActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
            activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
          };
        }
        now = new Date('2026-08-31T10:00:01.000Z');
        return {
          activationId: normalActivationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => {
        cancelCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async (activationId) => {
        statusIds.push(activationId);
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const expiryApp = await openApplication(expiryHeroSms, () => now);
    try {
      await resetAuthorizationTables(expiryApp.database);
      const session = await login(expiryApp.app);
      const created = await createBatch(expiryApp.app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(tokens.length, 2);
      // 第一个授权跨截止确认：创建授权到期取消任务（waiting_sms + 到期取消标记），不交付。
      const crossed = await expiryApp.app.inject({ method: 'POST', url: `/a/${tokens[0]!}/numbers` });
      assert.equal(crossed.statusCode, 404);
      assert.equal(getNumberCalls, 1);
      // 把到期任务的时间改写为“两分钟前取得且可取消时间已过”（CHECK 约束要求可取消时间不早于取得时间），
      // 使它的到期时间进入过去，成为最早到期任务；第二个授权随后正常取得号码。
      await expiryApp.database.pool.query(
        `UPDATE supplier_activations
         SET acquired_at = $2, cancel_available_at = $3
         WHERE provider_activation_id = $1`,
        [expiryActivationId, new Date('2026-08-31T09:58:00.000Z'), new Date('2026-08-31T10:00:00.000Z')],
      );
      now = new Date('2026-08-31T10:00:01.000Z');
      const claimed = await expiryApp.app.inject({ method: 'POST', url: `/a/${tokens[1]!}/numbers` });
      assert.equal(claimed.statusCode, 303);
      assert.equal(getNumberCalls, 2);
      // 获取号码路由唤醒对账调度：到期任务已到期，立即领取并请求取消（不依赖后台扫描）。
      await waitFor(() => cancelCalls === 1, 1_000);

      now = new Date('2026-08-31T10:02:05.000Z');
      const replacing = await expiryApp.app.inject({
        method: 'POST', url: `/a/${tokens[1]!}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      // 第二个授权换号进入取消确认中：调度器须按最早到期时间对账到期任务。
      assert.equal(replacing.statusCode, 202);
      await waitFor(() => statusIds.includes(normalActivationId), 2_000);
      // 到期任务先被领取 timer 对账一次，换号进入后再被重新安排的 timer 对账一次；换号单只对账一次。
      assert.equal(statusIds[0], expiryActivationId, '到期单按最早到期时间先对账');
      assert.equal(statusIds.filter((id) => id === normalActivationId).length, 1, '换号单只对账一次');
      assert.equal(cancelCalls, 2, '到期单领取与换号单各请求一次取消');
      const expiryState = await expiryApp.database.pool.query<{ status: string; authorization_expiry_cancellation_pending: boolean; cancellation_retry_after: Date | null }>(
        `SELECT status, authorization_expiry_cancellation_pending, cancellation_retry_after
         FROM supplier_activations WHERE provider_activation_id = $1`,
        [expiryActivationId],
      );
      assert.equal(expiryState.rows[0]?.status, 'cancellation_confirming');
      assert.equal(expiryState.rows[0]?.authorization_expiry_cancellation_pending, true, '授权到期来源标记保留，too-early 回退后仍被调度覆盖');
      assert.equal(expiryState.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000);
    } finally { await expiryApp.app.close(); }
    const expiryCleanup = new Database(databaseUrl!);
    try { await resetAuthorizationTables(expiryCleanup); } finally { await expiryCleanup.close(); }
  });

  test('对账延后回退后撤销专用调度器按新重试期限精确处理', async () => {
    // 对账返回 too-early 时会把撤销来源的记录回退到 waiting_sms 并持久化新的重试期限：
    // 换号路由不会武装撤销调度器，回退记录只能由对账完成链重新武装的撤销专用调度器
    // 按期限精确触发，而不是等待 60 秒后台扫描。
    let now = new Date('2026-08-30T16:00:00.000Z');
    let getNumberCalls = 0;
    let cancelCalls = 0;
    const statusIds: string[] = [];
    const fallbackId = `fallback-revoked-${randomUUID()}`;
    const normalId = `fallback-normal-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? fallbackId : normalId,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => {
        cancelCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async (activationId) => {
        statusIds.push(activationId);
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const fallbackApp = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(fallbackApp.database);
      const session = await login(fallbackApp.app);
      const created = await createBatch(fallbackApp.app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(tokens.length, 2);
      for (const token of tokens) {
        const claimed = await fallbackApp.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        assert.equal(claimed.statusCode, 303);
      }
      const replace = async (token: string): Promise<number> => (await fallbackApp.app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      })).statusCode;

      now = new Date('2026-08-30T16:02:05.000Z');
      // 模拟撤销来源的对账延后回退：waiting_sms + 撤销意图 + 已过期的重试期限。
      await fallbackApp.database.pool.query(
        `UPDATE supplier_activations
         SET authorization_revocation_cancellation_pending = true, cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [fallbackId, new Date('2026-08-30T16:02:07.000Z')],
      );
      // 推进时间越过重试期限：换号路由只武装换号与取消确认调度器，
      // 撤销回退记录只能由对账完成链重新武装的撤销专用调度器按期限触发。
      now = new Date('2026-08-30T16:02:08.000Z');
      assert.equal(await replace(tokens[1]!), 202);
      await waitFor(() => cancelCalls === 2, 4_000);
      await waitFor(() => statusIds.includes(fallbackId), 2_000);
      const fallbackState = await fallbackApp.database.pool.query<{ status: string; authorization_revocation_cancellation_pending: boolean; cancellation_retry_after: Date | null }>(
        `SELECT status, authorization_revocation_cancellation_pending, cancellation_retry_after
         FROM supplier_activations WHERE provider_activation_id = $1`,
        [fallbackId],
      );
      assert.equal(fallbackState.rows[0]?.status, 'cancellation_confirming');
      assert.equal(fallbackState.rows[0]?.authorization_revocation_cancellation_pending, true, '撤销来源标记保留');
      assert.equal(fallbackState.rows[0]?.cancellation_retry_after?.getTime(), now.getTime() + 60_000, '撤销重试后对账按新期限继续');
    } finally { await fallbackApp.app.close(); }
    const fallbackCleanup = new Database(databaseUrl!);
    try { await resetAuthorizationTables(fallbackCleanup); } finally { await fallbackCleanup.close(); }
  });

  test('新增更早任务会替换原 timer，新增更晚任务不会推迟已有更早任务', async () => {
    // —— 阶段一：新增更早到期任务替换原 timer，立即对账 ——
    let now = new Date('2026-08-30T14:00:00.000Z');
    let getNumberCalls = 0;
    const statusIds: string[] = [];
    const firstId = `earlier-replaces-${randomUUID()}`;
    const secondId = `earlier-replaces-later-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? firstId : secondId,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async (activationId) => {
        statusIds.push(activationId);
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const firstApp = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(firstApp.database);
      const session = await login(firstApp.app);
      const created = await createBatch(firstApp.app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(tokens.length, 2);
      for (const token of tokens) {
        const claimed = await firstApp.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        assert.equal(claimed.statusCode, 303);
      }
      const replace = async (token: string): Promise<number> => (await firstApp.app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      })).statusCode;

      now = new Date('2026-08-30T14:02:05.000Z');
      assert.equal(await replace(tokens[0]!), 202);
      // 第一条记录首次对账把重试期限推到 60 秒后；把它的到期时间改为 +8 秒。
      await waitFor(() => statusIds.includes(firstId), 1_000);
      await firstApp.database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [firstId, new Date(now.getTime() + 8_000)],
      );
      // 第二条记录进入取消确认中（到期时间更早）：必须替换原 timer 并立即对账。
      assert.equal(await replace(tokens[1]!), 202);
      await waitFor(() => statusIds.includes(secondId), 1_500);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(statusIds, [firstId, secondId], '更早到期任务替换原 timer 后立即对账，+8 秒任务未被提前处理');
    } finally { await firstApp.app.close(); }
    const firstCleanup = new Database(databaseUrl!);
    try { await resetAuthorizationTables(firstCleanup); } finally { await firstCleanup.close(); }

    // —— 阶段二：新增更晚到期任务不推迟已有更早任务 ——
    now = new Date('2026-08-30T18:00:00.000Z');
    getNumberCalls = 0;
    statusIds.length = 0;
    const thirdId = `later-no-delay-early-${randomUUID()}`;
    const fourthId = `later-no-delay-late-${randomUUID()}`;
    const phaseBHeroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? thirdId : fourthId,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async (activationId) => {
        statusIds.push(activationId);
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const phaseB = await openApplication(phaseBHeroSms, () => now);
    try {
      await resetAuthorizationTables(phaseB.database);
      const session = await login(phaseB.app);
      const created = await createBatch(phaseB.app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(tokens.length, 2);
      for (const token of tokens) {
        const claimed = await phaseB.app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        assert.equal(claimed.statusCode, 303);
      }
      const replace = async (token: string): Promise<number> => (await phaseB.app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      })).statusCode;

      now = new Date('2026-08-30T18:02:05.000Z');
      assert.equal(await replace(tokens[0]!), 202);
      await waitFor(() => statusIds.includes(thirdId), 1_000);
      // 更早任务到期时间改为 +3 秒（重试期限此刻已由首次对账推到 +60 秒）。
      await phaseB.database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [thirdId, new Date(now.getTime() + 3_000)],
      );
      // 更晚任务进入取消确认中（到期 = now）：重新安排后先对账它，但不推迟更早任务的 +3 秒 timer。
      assert.equal(await replace(tokens[1]!), 202);
      await waitFor(() => statusIds.includes(fourthId), 1_000);
      // 把更晚任务的到期时间改为 +10 秒：不得影响已安排的更早任务。
      await phaseB.database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [fourthId, new Date(now.getTime() + 10_000)],
      );
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      assert.deepEqual(statusIds, [thirdId, fourthId], '更早任务在 +3 秒前未被提前处理');
      // 推进时间越过更早任务的到期点：其 timer 仍按原时间触发，不被更晚任务推迟。
      now = new Date('2026-08-30T18:02:09.000Z');
      await waitFor(() => statusIds.filter((id) => id === thirdId).length >= 2, 3_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(statusIds.filter((id) => id === fourthId).length, 1, '更晚任务（+10 秒）未被提前处理');
    } finally { await phaseB.app.close(); }
    const phaseBCleanup = new Database(databaseUrl!);
    try { await resetAuthorizationTables(phaseBCleanup); } finally { await phaseBCleanup.close(); }
  });

  test('一次对账完成后自动安排数据库中的下一个到期记录', async () => {
    let now = new Date('2026-08-30T20:00:00.000Z');
    let getNumberCalls = 0;
    const statusIds: string[] = [];
    const firstId = `chain-next-${randomUUID()}`;
    const secondId = `chain-next-second-${randomUUID()}`;
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? firstId : secondId,
          phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async (activationId) => {
        statusIds.push(activationId);
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createBatch(app, session, '2');
      const tokens = [...created.body.matchAll(/https:\/\/test\.example\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
      assert.equal(tokens.length, 2);
      for (const token of tokens) {
        const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        assert.equal(claimed.statusCode, 303);
      }
      const replace = async (token: string): Promise<number> => (await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      })).statusCode;

      now = new Date('2026-08-30T20:02:05.000Z');
      assert.equal(await replace(tokens[0]!), 202);
      await waitFor(() => statusIds.includes(firstId), 1_000);
      // 第一条到期时间改为 +2 秒（其重试期限此刻已由首次对账推到 +60 秒）。
      await database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [firstId, new Date(now.getTime() + 2_000)],
      );
      // 第二条进入取消确认中（到期 = now）：先对账第二条。
      assert.equal(await replace(tokens[1]!), 202);
      await waitFor(() => statusIds.includes(secondId), 1_000);
      // 推进时间越过第一条的到期点：第二条对账完成后，调度器无需任何唤醒
      // 自动安排数据库中的下一个到期记录（第一条 +2 秒）。
      now = new Date('2026-08-30T20:02:08.000Z');
      await waitFor(() => statusIds.filter((id) => id === firstId).length >= 2, 3_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(statusIds, [firstId, secondId, firstId], '对账完成后按最早到期时间自动安排下一条');
      assert.equal(statusIds.filter((id) => id === secondId).length, 1, '第二条重试期限未到不重复对账');
    } finally { await resetAuthorizationTables(database); await app.close(); }
  });

  test('应用关闭时 timer 被清理，不留下悬挂任务', async () => {
    let now = new Date('2026-08-30T22:00:00.000Z');
    const activationId = `shutdown-cleanup-${randomUUID()}`;
    let activationStatusCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async () => {
        activationStatusCalls += 1;
        throw new HeroSmsResponseError('uncertain');
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      now = new Date('2026-08-30T22:02:05.000Z');
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);
      await waitFor(() => activationStatusCalls === 1, 1_000);
      // 把重试期限改为 +1 秒，再次提交换号（409 too-early）触发调度器按新时间重新安排 timer。
      await database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [activationId, new Date(now.getTime() + 1_000)],
      );
      const tooEarly = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(tooEarly.statusCode, 409);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // 在 timer 到期前关闭应用；随后时间越过到期点，不得再有任何供应商调用。
      await app.close();
      now = new Date('2026-08-30T22:02:10.000Z');
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal(activationStatusCalls, 1, '关闭后悬挂 timer 不得继续对账');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('两个并发对账入口针对同一激活时，只发生一次 activationStatus/cancelActivation 调用序列', async () => {
    let now = new Date('2026-08-31T10:00:00.000Z');
    const activationId = `concurrent-reconcile-${randomUUID()}`;
    let statusCalls = 0;
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => {
        statusCalls += 1;
        return { delivered: false, providerStatus: 'cancelled' };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database, activationAuthorizations } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      // 手动将激活置为 cancellation_confirming，且重试期限与租约置空
      await database.pool.query(
        `UPDATE supplier_activations SET status = 'cancellation_confirming', cancellation_retry_after = NULL,
         cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL
         WHERE provider_activation_id = $1`,
        [activationId],
      );

      // 两个并发对账入口针对同一激活同时对账
      await Promise.all([
        activationAuthorizations.reconcileCancellationConfirmations(),
        activationAuthorizations.reconcileCancellationConfirmations(),
      ]);

      assert.equal(statusCalls, 1, '只发生一次 activationStatus 调用');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('两个应用实例共享数据库同时对账时，同一激活只被一个实例 claim', async () => {
    let now = new Date('2026-08-31T11:00:00.000Z');
    const activationId = `multi-instance-claim-${randomUUID()}`;
    let instance1Calls = 0;
    let instance2Calls = 0;

    const heroSms1 = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async () => {
        instance1Calls += 1;
        return { delivered: false, providerStatus: 'cancelled' };
      },
    });

    const heroSms2 = scriptedHeroSms({
      activationStatus: async () => {
        instance2Calls += 1;
        return { delivered: false, providerStatus: 'cancelled' };
      },
    });

    await resetTablesBeforeApplication();
    const { app: app1, database, activationAuthorizations: auth1 } = await openApplication(heroSms1, () => now);
    const { app: app2, activationAuthorizations: auth2 } = await openApplication(heroSms2, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app1);
      const created = await createAuthorization(app1, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app1.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      now = new Date('2026-08-31T11:02:00.000Z');
      const replacing = await app1.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 202);

      // 将重试期限与租约置空，以便两实例竞争 claim
      await database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = NULL,
         cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL
         WHERE provider_activation_id = $1`,
        [activationId],
      );

      await Promise.all([
        auth1.reconcileCancellationConfirmations(),
        auth2.reconcileCancellationConfirmations(),
      ]);

      assert.equal(instance1Calls + instance2Calls, 1, '同一激活只被一个实例 claim 并调用供应商');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app1.close().catch(() => undefined);
      await app2.close().catch(() => undefined);
    }
  });

  test('执行者在供应商调用或数据库收尾前异常后，租约到期可由后续执行者恢复', async () => {
    let now = new Date('2026-08-31T12:00:00.000Z');
    const expiredLeaseId = `lease-expired-${randomUUID()}`;
    const activeLeaseId = `lease-active-${randomUUID()}`;
    let getNumberCalls = 0;
    let reconciledIds: string[] = [];

    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? expiredLeaseId : activeLeaseId,
          phoneNumber: getNumberCalls === 1 ? '+14155550123' : '+14155550124',
          activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      activationStatus: async (id) => {
        reconciledIds.push(id);
        return { delivered: false, providerStatus: 'cancelled' };
      },
    });

    await resetTablesBeforeApplication();
    const { app, database, activationAuthorizations } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created1 = await createAuthorization(app, session);
      const token1 = created1.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token1);
      const claimed1 = await app.inject({ method: 'POST', url: `/a/${token1}/numbers` });
      assert.equal(claimed1.statusCode, 303);

      const created2 = await createAuthorization(app, session);
      const token2 = created2.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token2);
      const claimed2 = await app.inject({ method: 'POST', url: `/a/${token2}/numbers` });
      assert.equal(claimed2.statusCode, 303);

      // 手动将第 1 个激活置为“已过期的租约”（cancellation_confirming，claimed_at 6 分钟前，cancellation_retry_after 为空）
      await database.pool.query(
        `UPDATE supplier_activations
         SET status = 'cancellation_confirming',
             cancellation_reconciliation_claimed_at = $2, cancellation_reconciliation_claim_token = 'old-token',
             cancellation_retry_after = NULL
         WHERE provider_activation_id = $1`,
        [expiredLeaseId, new Date(now.getTime() - 6 * 60 * 1000)],
      );

      // 手动将第 2 个激活置为“未过期的租约”（cancellation_confirming，claimed_at 1 分钟前，cancellation_retry_after 为空）
      await database.pool.query(
        `UPDATE supplier_activations
         SET status = 'cancellation_confirming',
             cancellation_reconciliation_claimed_at = $2, cancellation_reconciliation_claim_token = 'active-token',
             cancellation_retry_after = NULL
         WHERE provider_activation_id = $1`,
        [activeLeaseId, new Date(now.getTime() - 1 * 60 * 1000)],
      );

      await activationAuthorizations.reconcileCancellationConfirmations();

      assert.deepEqual(reconciledIds, [expiredLeaseId], '已过期的租约被恢复对账，未过期的租约被跳过');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('重复确认取消不会重复获取后继号码、重复结束授权或覆盖已送达短信事实', async () => {
    let now = new Date('2026-08-31T13:00:00.000Z');
    const activationId = `repeat-confirm-${randomUUID()}`;
    let getNumberCalls = 0;

    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        return {
          activationId: getNumberCalls === 1 ? activationId : `next-${randomUUID()}`,
          phoneNumber: getNumberCalls === 1 ? '+14155550123' : '+14155550124',
          activationCost: 0.8, currency: 'USD',
          activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });

    await resetTablesBeforeApplication();
    const { app, database, activationAuthorizations } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      now = new Date('2026-08-31T13:02:00.000Z');
      // 换号确认
      const replacing = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replacing.statusCode, 303);
      assert.equal(getNumberCalls, 2, '首次确认换号获取了第 2 个号码');

      // 对已经取消收尾的 activationId 重复触发 reconcileCancellationConfirmations
      await activationAuthorizations.reconcileCancellationConfirmations();
      await activationAuthorizations.reconcileCancellationConfirmations();

      assert.equal(getNumberCalls, 2, '重复确认取消不会重复获取后继号码');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('调度函数并发调用时最多保留一个受管理 timer，最早到期任务不被丢失', async () => {
    let now = new Date('2026-08-31T14:00:00.000Z');
    const activationId1 = `timer-guard-1-${randomUUID()}`;
    const statusCalls: string[] = [];

    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId: activationId1, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => { throw new HeroSmsResponseError('uncertain'); },
      activationStatus: async (id) => {
        statusCalls.push(id);
        throw new HeroSmsResponseError('uncertain');
      },
    });

    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      now = new Date('2026-08-31T14:02:00.000Z');
      await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      // 将取消确认重试期限设为 2 秒后
      await database.pool.query(
        `UPDATE supplier_activations SET cancellation_retry_after = $2
         WHERE provider_activation_id = $1`,
        [activationId1, new Date(now.getTime() + 2_000)],
      );

      // 并发调用 5 次 GET /a/token（触发 recipientState -> 调度逻辑）
      await Promise.all([
        app.inject({ method: 'GET', url: `/a/${token}` }),
        app.inject({ method: 'GET', url: `/a/${token}` }),
        app.inject({ method: 'GET', url: `/a/${token}` }),
        app.inject({ method: 'GET', url: `/a/${token}` }),
        app.inject({ method: 'GET', url: `/a/${token}` }),
      ]);

      // 推进时间越过 2 秒
      now = new Date('2026-08-31T14:02:03.000Z');
      await waitFor(() => statusCalls.includes(activationId1), 3_000);

      assert.ok(statusCalls.includes(activationId1), '最早到期的任务没有丢失');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('授权到期取消任务请求供应商期间，并发对账不得 claim 同一激活', async () => {
    let now = new Date('2026-08-31T15:00:00.000Z');
    const activationId = `expiry-vs-reconcile-${randomUUID()}`;
    let cancelCalls = 0;
    let statusCalls = 0;
    let releaseCancel: (() => void) | undefined;
    let releaseStatus: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        await cancelGate;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        statusCalls += 1;
        await statusGate;
        return { delivered: false };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database, activationAuthorizations } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      // 授权跨截止确认产生到期取消任务：等待短信 + 到期标记 + 已允许取消
      await database.pool.query(
        `UPDATE supplier_activations SET authorization_expiry_cancellation_pending = true, cancel_available_at = $2,
           cancellation_retry_after = NULL,
           cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL
         WHERE provider_activation_id = $1`,
        [activationId, now],
      );
      const expiryTask = activationAuthorizations.cancelAcquisitionsConfirmedAfterAuthorizationExpiry();
      await waitFor(() => cancelCalls === 1, 2_000);
      // 到期取消任务正挂起在供应商取消请求上，并发对账同时启动
      const reconcileTask = activationAuthorizations.reconcileCancellationConfirmations();
      const raced = await waitOrTimeout(() => statusCalls === 1, 300);
      releaseStatus?.();
      releaseCancel?.();
      await Promise.all([expiryTask, reconcileTask]);
      assert.equal(cancelCalls, 1, '到期取消任务只调用一次供应商取消');
      assert.equal(raced, false, '并发对账不得在到期取消任务请求供应商期间 claim 同一激活');
    } finally {
      releaseCancel?.();
      releaseStatus?.();
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('管理员撤销请求供应商期间，并发对账不得 claim 同一激活', async () => {
    let now = new Date('2026-08-31T16:00:00.000Z');
    const activationId = `revoke-vs-reconcile-${randomUUID()}`;
    let cancelCalls = 0;
    let statusCalls = 0;
    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        await cancelGate;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        statusCalls += 1;
        return { delivered: false };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database, activationAuthorizations } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = authorizationIdFromHome(home.body, token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      // 推进到允许取消时间后撤销：转态取消确认中并同步请求供应商取消
      now = new Date('2026-08-31T16:02:05.000Z');
      const revokeTask = activationAuthorizations.revoke(id);
      await waitFor(() => cancelCalls === 1, 2_000);
      const reconcileTask = activationAuthorizations.reconcileCancellationConfirmations();
      const raced = await waitOrTimeout(() => statusCalls === 1, 300);
      releaseCancel?.();
      await Promise.all([revokeTask, reconcileTask]);
      assert.equal(cancelCalls, 1, '撤销只调用一次供应商取消');
      assert.equal(raced, false, '并发对账不得在撤销请求供应商期间 claim 同一激活');
    } finally {
      releaseCancel?.();
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('撤销取消后台任务请求供应商期间，并发对账不得 claim 同一激活', async () => {
    let now = new Date('2026-08-31T17:00:00.000Z');
    const activationId = `revoke-task-vs-reconcile-${randomUUID()}`;
    let cancelCalls = 0;
    let statusCalls = 0;
    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        await cancelGate;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        statusCalls += 1;
        return { delivered: false };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database, activationAuthorizations } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      // 撤销取消后台任务的待处理记录：等待短信 + 撤销标记 + 已允许取消
      await database.pool.query(
        `UPDATE supplier_activations SET authorization_revocation_cancellation_pending = true, cancel_available_at = $2,
           cancellation_retry_after = NULL,
           cancellation_reconciliation_claimed_at = NULL, cancellation_reconciliation_claim_token = NULL
         WHERE provider_activation_id = $1`,
        [activationId, now],
      );
      const revocationTask = activationAuthorizations.cancelRevokedActivations();
      await waitFor(() => cancelCalls === 1, 2_000);
      const reconcileTask = activationAuthorizations.reconcileCancellationConfirmations();
      const raced = await waitOrTimeout(() => statusCalls === 1, 300);
      releaseCancel?.();
      await Promise.all([revocationTask, reconcileTask]);
      assert.equal(cancelCalls, 1, '撤销取消任务只调用一次供应商取消');
      assert.equal(raced, false, '并发对账不得在撤销取消任务请求供应商期间 claim 同一激活');
    } finally {
      releaseCancel?.();
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('换号请求供应商期间，并发对账不得 claim 同一激活', async () => {
    let now = new Date('2026-08-31T18:00:00.000Z');
    const activationId = `replacement-vs-reconcile-${randomUUID()}`;
    let cancelCalls = 0;
    let statusCalls = 0;
    let releaseCancel: (() => void) | undefined;
    const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
        activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      cancelActivation: async () => {
        cancelCalls += 1;
        await cancelGate;
        throw new HeroSmsResponseError('uncertain');
      },
      activationStatus: async () => {
        statusCalls += 1;
        return { delivered: false };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database, activationAuthorizations } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      now = new Date('2026-08-31T18:02:05.000Z');
      // 换号路由同步请求供应商取消：请求挂起期间并发对账同时启动。
      // 释放租约后路由唤醒的调度会合法地重发取消（既有对账语义），不计入竞态窗口。
      const replacementTask = app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      await waitFor(() => cancelCalls === 1, 2_000);
      const reconcileTask = activationAuthorizations.reconcileCancellationConfirmations();
      const raced = await waitOrTimeout(() => statusCalls === 1 || cancelCalls === 2, 300);
      releaseCancel?.();
      await Promise.all([replacementTask, reconcileTask]);
      assert.equal(raced, false, '并发对账不得在换号请求供应商期间 claim 同一激活');
      assert.ok(cancelCalls >= 1, '换号至少调用一次供应商取消');
    } finally {
      releaseCancel?.();
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('号码获取按当前每号最高价透传 maxPrice，且预算内可取库存为 0 的候选位置被跳过', async () => {
    const fixedNow = new Date('2026-08-01T00:00:00.000Z');
    const getNumberCalls: Array<{ serviceCode: string; countryId: number; maxPrice?: number }> = [];
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [
        // 国家 1：默认价 0.15，总库存 10，但 map 在每号最高价 0.11 下预算内库存为 0
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.15, totalStock: 10, map: { '0.15': 10 } },
        // 国家 2：默认价 0.08，总库存 5，map 在每号最高价 0.11 下预算内库存为 5
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.08, totalStock: 5, map: { '0.08': 5 } },
      ],
      getNumber: async (serviceCode, countryId, maxPrice) => {
        getNumberCalls.push({ serviceCode, countryId, maxPrice });
        return {
          activationId: `act-maxprice-${countryId}`,
          phoneNumber: '+442079460123',
          activationCost: 0.08,
          currency: 'USD',
          activationTime: fixedNow,
          activationEndTime: new Date(fixedNow.getTime() + 1_200_000),
        };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);

      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);

      assert.equal(getNumberCalls.length, 1);
      assert.deepEqual(getNumberCalls[0], {
        serviceCode: 'openai',
        countryId: 2,
        maxPrice: 0.11,
      }, '应该跳过预算内库存为零的国家1，向国家2发起取号请求，且透传每号最高价 0.11');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('修改每号最高价后，已领取的激活授权在后续取号时立即采用新最高价', async () => {
    let now = new Date('2026-08-01T00:00:00.000Z');
    const getNumberCalls: Array<{ serviceCode: string; countryId: number; maxPrice?: number }> = [];
    let acquiredCount = 0;
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [
        // 国家 1：0.15 档位 10 个；0.11 上限时预算内为 0，0.20 上限时预算内为 10
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.15, totalStock: 10, map: { '0.15': 10 } },
        // 国家 2：0.08 档位 5 个；0.11 与 0.20 上限时预算内均 > 0
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.08, totalStock: 5, map: { '0.08': 5 } },
      ],
      getNumber: async (serviceCode, countryId, maxPrice) => {
        getNumberCalls.push({ serviceCode, countryId, maxPrice });
        acquiredCount += 1;
        return {
          activationId: `act-live-maxprice-${acquiredCount}`,
          phoneNumber: acquiredCount === 1 ? '+442079460123' : '+14155550123',
          activationCost: 0.08,
          currency: 'USD',
          activationTime: now,
          activationEndTime: new Date(now.getTime() + 1_200_000),
        };
      },
      cancelActivation: async () => 'cancelled',
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);

      // 首次取号：0.11 下国家 1 预算内库存为 0，取号国家 2
      const firstClaim = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(firstClaim.statusCode, 303);
      assert.equal(getNumberCalls.length, 1);
      assert.equal(getNumberCalls[0]?.countryId, 2);
      assert.equal(getNumberCalls[0]?.maxPrice, 0.11);

      // 修改每号最高价配置为 0.20
      await database.saveCandidateSettings([
        { countryId: 1, countryName: '美国' },
        { countryId: 2, countryName: '英国' },
        { countryId: 3, countryName: '法国' },
      ], 0.20);

      // 换号：已领取的授权再次请求取号，实时读取 DB 最新最高价 0.20；国家 1（位置 1）尚未消耗且此时预算内库存为 10 > 0
      now = new Date(now.getTime() + 130_000);
      const replaceResponse = await app.inject({
        method: 'POST', url: `/a/${token}/replacement/confirm`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'replacement=confirm',
      });
      assert.equal(replaceResponse.statusCode, 303);

      assert.equal(getNumberCalls.length, 2);
      assert.equal(getNumberCalls[1]?.countryId, 1);
      assert.equal(getNumberCalls[1]?.maxPrice, 0.20);
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });

  test('号码获取遭遇实时 no-numbers 错误时推进下一个候选位置', async () => {
    const fixedNow = new Date('2026-08-01T00:00:00.000Z');
    const attemptedCountries: number[] = [];
    const heroSms = scriptedHeroSms({
      offers: async (): Promise<HeroSmsOffer[]> => [
        { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 2, map: { '0.08': 2 } },
        { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 3, map: { '0.09': 3 } },
      ],
      getNumber: async (_serviceCode, countryId) => {
        attemptedCountries.push(countryId);
        if (countryId === 1) throw new HeroSmsResponseError('no-numbers');
        return {
          activationId: `act-no-numbers-retry-${countryId}`,
          phoneNumber: '+442079460123',
          activationCost: 0.09,
          currency: 'USD',
          activationTime: fixedNow,
          activationEndTime: new Date(fixedNow.getTime() + 1_200_000),
        };
      },
    });
    await resetTablesBeforeApplication();
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      await resetAuthorizationTables(database);
      const session = await login(app);
      const created = await createAuthorization(app, session);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1];
      assert.ok(token);

      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      assert.deepEqual(attemptedCountries, [1, 2], '尝试国家1遇到 no-numbers 后，自动推进并取得国家2的号码');
    } finally {
      await resetAuthorizationTables(database).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
  });
}
