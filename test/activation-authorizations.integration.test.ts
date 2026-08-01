import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
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
  balance: number;
  stock: number;
  quotes: HeroSms['quotes'];
  getNumber: HeroSms['getNumber'];
  activeActivations: HeroSms['activeActivations'];
  activationHistory: HeroSms['activationHistory'];
  activationStatus: HeroSms['activationStatus'];
  cancelActivation: HeroSms['cancelActivation'];
  finishActivation: HeroSms['finishActivation'];
}> = {}): HeroSms {
  return {
    balance: async () => overrides.balance ?? 10,
    services: async () => [{ code: 'openai', name: 'OpenAI' }],
    countries: async () => [{ id: 1, name: '美国' }, { id: 2, name: '英国' }, { id: 3, name: '法国' }],
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
  test('激活授权集成测试需要 TEST_DATABASE_URL', () => {
    throw new Error('未设置 TEST_DATABASE_URL；请通过 npm test 运行完整测试');
  });
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
      assert.match(firstGet.body, /获取号码/);
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

  test('首次领取原子绑定浏览器，按实时价格和库存获取号码并可由绑定浏览器恢复', async () => {
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
        if (countryId === 2) throw new HeroSmsResponseError('no-numbers');
        return {
          activationId, phoneNumber: '+442079460123', activationCost: 0.9, currency: 'USD',
          activationTime: fixedNow, activationEndTime: new Date('2026-08-01T00:20:00.000Z'),
        };
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

      const initial = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(initial.body, /OpenAI/);
      assert.match(initial.body, /data-countdown=.*正在获取号码/);
      assert.doesNotMatch(initial.body, /美国|英国|法国|HeroSMS|价格|库存/);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(claimed.statusCode, 303);
      assert.deepEqual(attemptedCountries, [2, 3], '应按实时价格排序，并在明确无库存后尝试下一地区');
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      const numberPage = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.equal(numberPage.statusCode, 200);
      assert.match(numberPage.body, /法国|\+44 20 7946 0123/);
      assert.match(numberPage.body, /data-copy-value="\+442079460123"/);
      assert.match(numberPage.body, /授权剩余时间|号码有效至|可换号时间|剩余可用号码次数：2/);
      assert.doesNotMatch(numberPage.body, new RegExp(`${activationId}|HeroSMS|价格|库存`));

      const lostCookie = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.match(lostCookie.body, /此链接不可用，请联系发送者/);
      const cannotRebind = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(cannotRebind.statusCode, 409);
      assert.match(cannotRebind.body, /此链接不可用，请联系发送者/);

      const stored = await database.pool.query<{ used_at: Date | null }>(
        `SELECT candidate.used_at FROM authorization_candidate_countries candidate
         WHERE candidate.authorization_id = (SELECT authorization_id FROM supplier_activations WHERE provider_activation_id = $1)
         ORDER BY candidate.position`,
        [activationId],
      );
      assert.deepEqual(stored.rows.map((row) => row.used_at !== null), [false, false, true], '只有成功取得号码的地区才被消耗');
    } finally { await app.close(); }
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
      const first = await createAuthorization(opened.app, session, { recipientIdentifier: randomUUID() });
      const second = await createAuthorization(opened.app, session, { recipientIdentifier: randomUUID() });
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

      const third = await createAuthorization(opened.app, session, { recipientIdentifier: randomUUID() });
      const thirdToken = third.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(thirdToken);
      now = new Date('2026-08-02T00:00:00.001Z');
      assert.equal((await opened.app.inject({ method: 'POST', url: `/a/${thirdToken}/numbers` })).statusCode, 404);
      assert.equal(calls, 2, '截止后不得调用 HeroSMS');
    } finally { await opened.app.close(); }
  });

  test('三个候选地区均明确无库存时保留全部地区和获取额度', async () => {
    const fixedNow = new Date('2026-08-04T12:00:00.000Z');
    const attemptedCountries: number[] = [];
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        attemptedCountries.push(countryId);
        throw new HeroSmsResponseError('no-numbers');
      },
    });
    const { app, database } = await openApplication(heroSms, () => fixedNow);
    try {
      const session = await login(app);
      const recipientIdentifier = `no-stock-${randomUUID()}`;
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const response = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(response.statusCode, 409);
      assert.match(response.body, /当前暂无可用号码，请联系发送者/);
      assert.deepEqual(attemptedCountries, [1, 2, 3]);
      const candidates = await database.pool.query<{ used_at: Date | null }>(
        `SELECT candidate.used_at FROM authorization_candidate_countries candidate
         JOIN activation_authorizations auth ON auth.id = candidate.authorization_id
         WHERE auth.recipient_identifier = $1 ORDER BY candidate.position`,
        [recipientIdentifier],
      );
      assert.deepEqual(candidates.rows.map((candidate) => candidate.used_at), [null, null, null]);
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
        const recipientIdentifier = `${kind}-${randomUUID()}`;
        const created = await createAuthorization(app, session, { recipientIdentifier });
        const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
        const failed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
        assert.equal(failed.statusCode, 503);
        assert.match(failed.body, /暂时无法获取号码，请联系发送者/);
        const recipientCookie = `recipient_session=${cookieValue(failed, 'recipient_session')}`;
        const unused = await database.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM authorization_candidate_countries
           WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE recipient_identifier = $1)
             AND used_at IS NOT NULL`,
          [recipientIdentifier],
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
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
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
      const first = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const second = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const firstToken = first.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(firstToken);
      const secondToken = second.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(secondToken);
      const uncertain = await app.inject({ method: 'POST', url: `/a/${firstToken}/numbers` });
      assert.equal(uncertain.statusCode, 202);
      assert.match(uncertain.body, /号码获取结果待发送者处理/);
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
      const created = await createAuthorization(opened.app, session, { recipientIdentifier: randomUUID() });
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
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const payload = { activationId, service: 'openai', country: 1, receivedAt: '2026-08-09T00:03:00.000Z', code: '482913', text: 'Your code is 482913' };

      assert.equal((await app.inject({ method: 'POST', url: '/wrong-webhook-path', payload })).statusCode, 404);
      assert.equal((await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '192.0.2.10', payload })).statusCode, 404);
      const delivered = await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload });
      assert.equal(delivered.statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload })).statusCode, 200, '重复投递应幂等成功');
      await new Promise((resolve) => setImmediate(resolve));

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
      assert.deepEqual(state.rows[0], { authorization_status: 'sms_delivered', activation_status: 'completed', events: '1' });

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
      const created = await createAuthorization(opened.app, session, { recipientIdentifier: randomUUID() });
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
    let recipientCookie = '';
    try {
      const session = await login(opened.app);
      const created = await createAuthorization(opened.app, session, { recipientIdentifier: randomUUID() });
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
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
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

  test('已用尽三个地区时不会显示或执行换号，从而保留第三个号码', async () => {
    let now = new Date('2026-08-12T06:00:00.000Z');
    let cancelCalls = 0;
    const heroSms = scriptedHeroSms({ cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; } });
    const { app, database } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const recipientIdentifier = randomUUID();
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const first = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(first, 'recipient_session')}`;
      await database.pool.query(
        `UPDATE authorization_candidate_countries SET used_at = $1
         WHERE authorization_id = (SELECT id FROM activation_authorizations WHERE recipient_identifier = $2)`,
        [now, recipientIdentifier],
      );
      now = new Date('2026-08-12T06:02:00.000Z');
      const page = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.doesNotMatch(page.body, /更换号码/);
      const rejected = await app.inject({ method: 'POST', url: `/a/${token}/replacement/confirm`, headers: { cookie: recipientCookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'replacement=confirm' });
      assert.equal(rejected.statusCode, 409);
      assert.equal(cancelCalls, 0);
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
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
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
      const created = await createAuthorization(opened.app, session, { recipientIdentifier: randomUUID() });
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
      const created = await createAuthorization(initial, session, { recipientIdentifier: randomUUID() });
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

  test('第三次激活超时后授权额度已用尽，同一接收者可以创建新授权', async () => {
    let now = new Date('2026-08-14T06:00:00.000Z');
    const recipientIdentifier = randomUUID();
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
      const created = await createAuthorization(initial, session, { recipientIdentifier });
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
      assert.match(home.body, new RegExp(`${recipientIdentifier}</strong> · 进行中`));
    } finally { await activeRestart.close(); }

    now = new Date('2026-08-14T06:24:00.000Z');
    const { app: timedOut, database } = await openApplication(heroSms, () => now);
    try {
      const page = await timedOut.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /可用号码次数已用尽/);
      assert.doesNotMatch(page.body, /获取下一个号码|获取号码/);

      const session = await login(timedOut);
      const home = await timedOut.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.match(home.body, /额度已用尽/);

      // 模拟修复部署前已经确认第三次超时、但授权仍错误停在“进行中”的数据。
      await database.pool.query(
        "UPDATE activation_authorizations SET status = 'in_progress' WHERE recipient_identifier = $1",
        [recipientIdentifier],
      );
    } finally { await timedOut.close(); }

    const { app: migrated } = await openApplication(heroSms, () => now);
    try {
      const session = await login(migrated);
      const home = await migrated.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      assert.match(home.body, /额度已用尽/);
      const recreated = await createAuthorization(migrated, session, { recipientIdentifier });
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
      const created = await createAuthorization(initial, session, { recipientIdentifier: randomUUID() });
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
    } finally { await initial.close(); }

    now = new Date('2026-08-15T06:20:00.000Z');
    const { app: reconciled } = await openApplication(heroSms, () => now);
    try {
      const page = await reconciled.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /短信已收到，暂时无法显示验证码，请联系发送者/);
      assert.doesNotMatch(page.body, /获取下一个号码|获取号码|482913/);
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
      const created = await createAuthorization(initial, session, { recipientIdentifier: randomUUID() });
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
    const heroSms = scriptedHeroSms({
      getNumber: async () => ({
        activationId, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD', activationTime: now,
        activationEndTime: new Date(now.getTime() + 1_200_000),
      }),
      activationStatus: async () => ({ delivered: false }),
    });
    const { app: initial } = await openApplication(heroSms, () => now);
    let token = '';
    let recipientCookie = '';
    try {
      const session = await login(initial);
      const created = await createAuthorization(initial, session, { recipientIdentifier: randomUUID() });
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await initial.inject({ method: 'POST', url: `/a/${token}/numbers` });
      recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
    } finally { await initial.close(); }

    now = new Date('2026-08-16T06:20:00.000Z');
    const { app: restarted } = await openApplication(heroSms, () => now);
    try {
      const page = await restarted.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(page.body, /正在确认激活超时/);
      assert.doesNotMatch(page.body, /获取下一个号码|获取号码/);

      const session = await login(restarted);
      const home = await restarted.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const detailPath = home.body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(detailPath);
      const detail = await restarted.inject({ method: 'GET', url: detailPath, headers: { cookie: session.cookie } });
      assert.match(detail.body, /manual_reconciliation/);
      assert.doesNotMatch(detail.body, /timed_out/);
    } finally { await restarted.close(); }
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
    const recipientIdentifier = randomUUID();
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      now = new Date('2026-08-20T23:50:00.000Z');
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;

      now = new Date('2026-08-20T23:59:59.999Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 200);
      now = new Date('2026-08-21T00:00:00.000Z');
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
      assert.equal(cancelCalls, 0, '截止时已经存在的供应商激活不得因授权到期自动取消');

      const webhook = await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '127.0.0.1',
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), text: 'late body', code: '482913' },
      });
      assert.equal(webhook.statusCode, 200);
      const detailPath = (await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } })).body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1]; assert.ok(detailPath);
      const detail = await app.inject({ method: 'GET', url: detailPath, headers: { cookie: session.cookie } });
      assert.match(detail.body, /completion_confirming|completed/);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).statusCode, 404);
    } finally { await app.close(); }
  });

  test('截止前发出的号码获取在截止后成功时不交付，并在允许取消后自动供应商取消', async () => {
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
          activationTime: new Date('2026-08-22T23:59:59.999Z'), activationEndTime: new Date('2026-08-23T00:19:59.999Z'),
        };
      },
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    let detailPath = '';
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      detailPath = (await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } })).body.match(/href="(\/control7\/authorizations\/[0-9a-f-]{36})"/)?.[1] ?? '';
      assert.ok(detailPath);
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      now = new Date('2026-08-22T23:59:59.999Z');
      const response = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      assert.equal(response.statusCode, 404);
      assert.equal(getNumberCalls, 1);
      assert.equal(cancelCalls, 0, '供应商尚未允许取消时应保留持久取消任务');
    } finally { await app.close(); }

    now = new Date('2026-08-23T00:01:59.998Z');
    const beforeAllowed = await openApplication(heroSms, () => now);
    try { assert.equal(cancelCalls, 0); } finally { await beforeAllowed.app.close(); }

    now = new Date('2026-08-23T00:01:59.999Z');
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

  test('截止前结果不确定的获取在截止后对账成功时仍不交付且不创建后继激活', async () => {
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
        activationTime: new Date('2026-08-26T23:59:59.999Z'), status: 'STATUS_WAIT_CODE',
      }],
      cancelActivation: async () => { cancelCalls += 1; return 'cancelled'; },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      now = new Date('2026-08-26T23:59:59.999Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/numbers` })).statusCode, 404);
      assert.equal(getNumberCalls, 1);
      assert.equal(cancelCalls, 0);
      assert.equal((await app.inject({ method: 'GET', url: `/a/${token}` })).statusCode, 404);
    } finally { await app.close(); }

    now = new Date('2026-08-27T00:01:59.999Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1, '对账确认的迟到号码应在允许时自动取消');
      assert.equal(getNumberCalls, 1, '迟到号码取消后不得创建后继激活');
    } finally { await restarted.app.close(); }
  });

  test('全局获取队列等待跨过截止秒时，只有截止前已经发出的供应商请求继续收尾', async () => {
    let now = new Date('2026-08-28T00:00:00.000Z');
    let getNumberCalls = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const heroSms = scriptedHeroSms({
      getNumber: async () => {
        getNumberCalls += 1;
        await firstBlocked;
        return {
          activationId: `expiry-queued-${randomUUID()}`, phoneNumber: '+14155550123', activationCost: 0.8, currency: 'USD',
          activationTime: new Date('2026-08-28T23:59:59.999Z'), activationEndTime: new Date('2026-08-29T00:19:59.999Z'),
        };
      },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const first = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const second = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const firstToken = first.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(firstToken);
      const secondToken = second.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(secondToken);

      now = new Date('2026-08-28T23:59:59.999Z');
      const firstRequest = app.inject({ method: 'POST', url: `/a/${firstToken}/numbers` });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const queuedRequest = app.inject({ method: 'POST', url: `/a/${secondToken}/numbers` });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(getNumberCalls, 1, '第二个请求应在 PostgreSQL 全局队列中等待');

      now = new Date('2026-08-29T00:00:00.000Z');
      releaseFirst();
      assert.equal((await firstRequest).statusCode, 404, '截止前发出但截止后成功的号码不得交付');
      assert.equal((await queuedRequest).statusCode, 404, '排队资格不能越过授权期限');
      assert.equal(getNumberCalls, 1, '截止后不得为队列中的请求调用 HeroSMS');
    } finally { await app.close(); }
  });

  test('明确无库存响应跨过授权截止秒后，不再调用下一个候选地区', async () => {
    let now = new Date('2026-08-24T00:00:00.000Z');
    const attemptedCountries: number[] = [];
    const heroSms = scriptedHeroSms({
      getNumber: async (_serviceCode, countryId) => {
        attemptedCountries.push(countryId);
        now = new Date('2026-08-25T00:00:00.000Z');
        throw new HeroSmsResponseError('no-numbers');
      },
    });
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const created = await createAuthorization(app, session, { recipientIdentifier: randomUUID() });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      now = new Date('2026-08-24T23:59:59.999Z');
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/numbers` })).statusCode, 404);
      assert.deepEqual(attemptedCountries, [1]);
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
    const { app } = await openApplication(heroSms, () => now);
    try {
      const session = await login(app);
      const recipientIdentifier = `撤销确认-${randomUUID()}`;
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      now = new Date('2026-09-01T00:02:00.000Z');
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = home.body.match(new RegExp(`${recipientIdentifier}</strong>.*?authorizations\\/([0-9a-f-]{36})\\/revoke`))?.[1]; assert.ok(id);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.equal(confirmation.statusCode, 200);
      assert.match(confirmation.body, new RegExp(recipientIdentifier));
      assert.match(confirmation.body, /<strong>授权状态：<\/strong>进行中/);
      assert.match(confirmation.body, /<strong>当前激活状态：<\/strong>waiting_sms/);
      assert.match(confirmation.body, /<strong>当前地区：<\/strong>美国/);
      assert.match(confirmation.body, /<strong>已获取次数：<\/strong>1/);
      assert.match(confirmation.body, /立即请求取消当前供应商激活/);

      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      assert.equal(cancelCalls, 1);
      const recipient = await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } });
      assert.match(recipient.body, /此链接不可用，请联系发送者/);
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /已撤销/);
      assert.match(detail.body, /cancelled/);
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
      const recipientIdentifier = `延迟撤销-${randomUUID()}`;
      const created = await createAuthorization(app, session, { recipientIdentifier });
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = home.body.match(new RegExp(`${recipientIdentifier}</strong>.*?authorizations\\/([0-9a-f-]{36})\\/revoke`))?.[1]; assert.ok(id);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.match(confirmation.body, /将在可取消时请求取消当前供应商激活/);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancelCalls, 0);
      assert.match((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).body, /此链接不可用，请联系发送者/);
    } finally { await app.close(); }

    now = new Date('2026-09-02T00:01:59.999Z');
    const beforeAllowed = await openApplication(heroSms, () => now);
    try { assert.equal(cancelCalls, 0); } finally { await beforeAllowed.app.close(); }
    now = new Date('2026-09-02T00:02:00.000Z');
    const allowed = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1);
      assert.match((await allowed.app.inject({ method: 'GET', url: `/a/${token}` })).body, /此链接不可用，请联系发送者/);
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
      const recipientIdentifier = `过早取消-${randomUUID()}`;
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = home.body.match(new RegExp(`${recipientIdentifier}</strong>.*?authorizations\\/([0-9a-f-]{36})\\/revoke`))?.[1]; assert.ok(id);
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
      const recipientIdentifier = `短信撤销-${randomUUID()}`;
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      assert.equal((await app.inject({
        method: 'POST', url: `/${config.heroSmsWebhookPath}`, remoteAddress: '127.0.0.1',
        payload: { activationId, service: 'openai', country: 1, receivedAt: now.toISOString(), text: '验证码 482913', code: '482913' },
      })).statusCode, 200);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = home.body.match(new RegExp(`${recipientIdentifier}</strong>.*?authorizations\\/([0-9a-f-]{36})\\/revoke`))?.[1]; assert.ok(id);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.match(confirmation.body, /只终止接收者访问，不请求供应商取消/);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancelCalls, 0);
      assert.equal(acquiredNumbers, 1);
      assert.match((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).body, /此链接不可用，请联系发送者/);
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
      const recipientIdentifier = `对账撤销-${randomUUID()}`;
      const created = await createAuthorization(app, session, { recipientIdentifier });
      token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1] ?? ''; assert.ok(token);
      assert.equal((await app.inject({ method: 'POST', url: `/a/${token}/numbers` })).statusCode, 202);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = home.body.match(new RegExp(`${recipientIdentifier}</strong>.*?authorizations\\/([0-9a-f-]{36})\\/revoke`))?.[1]; assert.ok(id);
      const confirmation = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}/revoke`, headers: { cookie: session.cookie } });
      assert.match(confirmation.body, /先完成供应商对账，确认号码后取消/);
      assert.match(confirmation.body, /<strong>当前地区：<\/strong>美国/);
      assert.match(confirmation.body, /<strong>当前激活状态：<\/strong>(?:获取结果确认中|结果待人工对账)/);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.match((await app.inject({ method: 'GET', url: `/a/${token}` })).body, /此链接不可用，请联系发送者/);
    } finally { await app.close(); }

    reconciliationFindsNumber = true;
    now = new Date('2026-09-04T00:02:00.000Z');
    const restarted = await openApplication(heroSms, () => now);
    try {
      assert.equal(cancelCalls, 1);
      assert.match((await restarted.app.inject({ method: 'GET', url: `/a/${token}` })).body, /此链接不可用，请联系发送者/);
    } finally { await restarted.app.close(); }
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
      const recipientIdentifier = `取消短信竞态-${randomUUID()}`;
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const claimed = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
      const recipientCookie = `recipient_session=${cookieValue(claimed, 'recipient_session')}`;
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = home.body.match(new RegExp(`${recipientIdentifier}</strong>.*?authorizations\\/([0-9a-f-]{36})\\/revoke`))?.[1]; assert.ok(id);
      assert.equal((await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {})).statusCode, 303);
      assert.equal(cancellationCalls, 1);
      assert.equal(acquiredNumbers, 1);
      assert.match((await app.inject({ method: 'GET', url: `/a/${token}`, headers: { cookie: recipientCookie } })).body, /此链接不可用，请联系发送者/);
      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${id}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /completion_confirming|completed/);
    } finally { await app.close(); }
  });

  test('管理员撤销待领取授权后，真实链接在 24 小时内显示统一不可用，截止后返回 404', async () => {
    let now = new Date('2026-08-18T00:00:00.000Z');
    const { app } = await openApplication(scriptedHeroSms(), () => now);
    try {
      const session = await login(app);
      const recipientIdentifier = randomUUID();
      const created = await createAuthorization(app, session, { recipientIdentifier });
      const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
      const home = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: session.cookie } });
      const id = home.body.match(new RegExp(`${recipientIdentifier}</strong>.*?authorizations\\/([0-9a-f-]{36})\\/revoke`))?.[1]; assert.ok(id);
      const revoked = await post(app, session, `/${config.adminPath}/authorizations/${id}/revoke`, {});
      assert.equal(revoked.statusCode, 303);
      const unavailable = await app.inject({ method: 'GET', url: `/a/${token}` });
      assert.equal(unavailable.statusCode, 200);
      assert.match(unavailable.body, /此链接不可用，请联系发送者/);

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
      const recipientIdentifier = `成本历史-${randomUUID()}`;
      await createAuthorization(app, session, { recipientIdentifier });
      const authorization = await database.pool.query<{ id: string }>(
        'SELECT id FROM activation_authorizations WHERE recipient_identifier = $1', [recipientIdentifier],
      );
      const authorizationId = authorization.rows[0]?.id; assert.ok(authorizationId);
      await database.pool.query("UPDATE activation_authorizations SET status = 'expired', token_hash = NULL WHERE id = $1", [authorizationId]);
      const activationIds = ['first', 'second', 'third'].map((suffix) => `${suffix}-${randomUUID()}`);
      for (const [index, activationId] of activationIds.entries()) {
        await database.pool.query(
          `INSERT INTO supplier_activations
             (authorization_id, country_id, provider_activation_id, status, activation_cost, currency, acquired_at, cancel_available_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'USD', $6, $6, $7)`,
          [authorizationId, index + 1, activationId, index === 2 ? 'waiting_sms' : 'cancelled', [0.8, 1.25, 2][index], new Date(now.getTime() + index), new Date('2026-09-06T00:20:00.000Z')],
        );
      }
      await database.pool.query(
        'UPDATE authorization_candidate_countries SET used_at = $2 WHERE authorization_id = $1', [authorizationId, now],
      );
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
      assert.match(home.body, /已到期/);
      assert.match(home.body, /等待短信/);
      assert.match(home.body, /待处理异常/);
      assert.doesNotMatch(home.body, /\+14155550123|482913|短信正文/);
      const eventsBeforeDetail = await database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM lifecycle_events WHERE authorization_id = $1', [authorizationId],
      );
      assert.ok(Number(eventsBeforeDetail.rows[0]?.count) >= 4, '状态变更应留下非敏感生命周期事件');

      const detail = await app.inject({ method: 'GET', url: `/${config.adminPath}/authorizations/${authorizationId}`, headers: { cookie: session.cookie } });
      assert.match(detail.body, /授权状态：已到期/);
      assert.match(detail.body, /供应商激活/);
      assert.match(detail.body, /first-/);
      assert.match(detail.body, /获取时间 2026-09-06T00:00:00\.000Z/);
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
}
