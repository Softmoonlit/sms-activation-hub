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
  adminPassword: 'correct-deployment-password',
  adminPath: 'control7',
  databaseUrl: databaseUrl ?? '',
  heroSmsApiKey: 'test-api-key',
  heroSmsWebhookAllowedIps: ['127.0.0.1'],
  heroSmsWebhookPath: 'test-webhook-secret-path-1234567890',
  heroSmsWebhookRequestsPerMinute: 120,
  loginMaxAttempts: 3,
  loginWindowSeconds: 900,
  openAiServiceCode: 'openai',
  port: 3001,
  publicOrigin: origin,
  sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
  trustedProxy: false,
};

const heroSms: HeroSms = {
  balance: async () => 12.5,
  services: async () => [{ code: 'openai', name: 'OpenAI' }],
  countries: async () => [
    { id: 1, name: '中国' },
    { id: 2, name: '美国' },
    { id: 3, name: '英国' },
    { id: 4, name: '法国' },
  ],
  quotes: async () => [
    { countryId: 1, price: 0.1234, stock: 0 },
    { countryId: 2, price: 0.18, stock: 4 },
    { countryId: 3, price: 0.2, stock: 3 },
    { countryId: 4, price: 0.22, stock: 5 },
  ],
  getNumber: async () => { throw new Error('设置测试不应获取号码'); },
  activeActivations: async () => [],
  activationHistory: async () => [],
  activationStatus: async () => ({ delivered: false }),
  cancelActivation: async () => 'cancelled',
  finishActivation: async () => undefined,
};

const unavailableHeroSms: HeroSms = {
  ...heroSms,
  balance: async () => { throw new Error('HeroSMS 暂时不可用'); },
  services: async () => { throw new Error('HeroSMS 暂时不可用'); },
  countries: async () => { throw new Error('HeroSMS 暂时不可用'); },
  quotes: async () => { throw new Error('HeroSMS 暂时不可用'); },
};

const unsafeNameHeroSms: HeroSms = {
  ...heroSms,
  countries: async () => [{ id: 5, name: '</script><script>alert(1)</script>' }],
  quotes: async () => [{ countryId: 5, price: 0.2, stock: 1 }],
};

type LoginMaterial = { csrf: string; csrfCookie: string };
type InjectionResponse = Awaited<ReturnType<FastifyInstance['inject']>>;
type OpenApplication = { app: FastifyInstance; database: Database };

function cookieValue(response: InjectionResponse, name: string): string {
  const cookie = response.cookies.find((entry) => entry.name === name);
  assert.ok(cookie, `响应应设置 ${name} Cookie`);
  return cookie.value;
}

function csrfValue(body: string): string {
  const match = body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/);
  assert.ok(match, '页面应包含 CSRF token');
  return match[1];
}

async function openApplication(heroSmsOverride: HeroSms = heroSms): Promise<OpenApplication> {
  const testConfig = { ...config, sessionSecret: `${config.sessionSecret}-${randomUUID()}` };
  const database = new Database(testConfig.databaseUrl);
  const app = await createApp(testConfig, database, { heroSms: heroSmsOverride });
  return { app, database };
}

async function login(app: FastifyInstance): Promise<{ adminCookie: string; csrfCookie: string }> {
  const page = await app.inject({ method: 'GET', url: `/${config.adminPath}` });
  const csrf = csrfValue(page.body);
  const csrfCookie = cookieValue(page, 'admin_csrf');
  const response = await app.inject({
    method: 'POST',
    url: `/${config.adminPath}/login`,
    headers: {
      cookie: `admin_csrf=${csrfCookie}`,
      'content-type': 'application/x-www-form-urlencoded',
      origin,
    },
    payload: `csrf=${encodeURIComponent(csrf)}&password=${encodeURIComponent(config.adminPassword)}`,
  });
  assert.equal(response.statusCode, 303);
  return { adminCookie: cookieValue(response, 'admin_session'), csrfCookie: cookieValue(response, 'admin_csrf') };
}

function sessionCookie(session: { adminCookie: string; csrfCookie: string }): string {
  return `admin_session=${session.adminCookie}; admin_csrf=${session.csrfCookie}`;
}

if (!databaseUrl) {
  test('管理员设置集成测试需要 TEST_DATABASE_URL', () => {
    throw new Error('未设置 TEST_DATABASE_URL；请通过 npm test 运行完整测试');
  });
} else {
  test('候选位置数量默认三，并可完整保存十个有序位置', async () => {
    const { app, database } = await openApplication();
    try {
      await database.pool.query('DELETE FROM default_candidate_countries');
      const session = await login(app);
      const headers = { cookie: sessionCookie(session), 'content-type': 'application/x-www-form-urlencoded', origin };

      const settings = await app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers });
      assert.equal(settings.statusCode, 200);
      assert.match(settings.body, /候选位置数量/);
      assert.match(settings.body, /name="candidateCount"/);
      assert.match(settings.body, /<option value="3" selected>/);
      assert.equal((settings.body.match(/name="candidate\d+"/g) || []).length, 3);

      const saved = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/settings`,
        headers,
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}&candidateCount=10&${Array.from({ length: 10 }, (_, index) => `candidate${index + 1}=${index % 4 + 1}`).join('&')}`,
      });
      assert.equal(saved.statusCode, 303);
      assert.deepEqual((await database.completeDefaultCandidateLocations())?.map((location) => location.countryId), [1, 2, 3, 4, 1, 2, 3, 4, 1, 2]);

      const afterSave = await app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers });
      assert.match(afterSave.body, /<option value="10" selected>/);
      assert.equal((afterSave.body.match(/name="candidate\d+"/g) || []).length, 10);
    } finally {
      await app.close();
    }
  });

  test('设置提交拒绝非法数量与不连续位置，并原子保留原配置', async () => {
    const { app, database } = await openApplication();
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '中国' },
        { countryId: 2, countryName: '美国' },
        { countryId: 3, countryName: '英国' },
      ]);
      const session = await login(app);
      const headers = { cookie: sessionCookie(session), 'content-type': 'application/x-www-form-urlencoded', origin };
      const original = await database.defaultCandidateLocations();
      const invalidPayloads = [
        'candidateCount=2&candidate1=1&candidate2=2',
        `candidateCount=11&${Array.from({ length: 11 }, (_, index) => `candidate${index + 1}=1`).join('&')}`,
        'candidateCount=3.5&candidate1=1&candidate2=2&candidate3=3',
        'candidate1=1&candidate2=2&candidate3=3',
        'candidateCount=3&candidate1=1&candidate3=3',
        'candidateCount=3&candidate1=1&candidate2=&candidate3=3',
        'candidateCount=3&candidate1=1&candidate2=2&candidate3=3&candidate4=4',
      ];
      for (const invalidPayload of invalidPayloads) {
        const rejected = await app.inject({
          method: 'POST',
          url: `/${config.adminPath}/settings`,
          headers,
          payload: `csrf=${encodeURIComponent(session.csrfCookie)}&${invalidPayload}`,
        });
        assert.equal(rejected.statusCode, 422, invalidPayload);
        assert.deepEqual(await database.defaultCandidateLocations(), original, invalidPayload);
      }
    } finally {
      await app.close();
    }
  });

  test('配置替换进行中时领取读取等待提交，只取得完整的新配置', async () => {
    const { app, database } = await openApplication();
    const writer = await database.pool.connect();
    try {
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '中国' },
        { countryId: 2, countryName: '美国' },
        { countryId: 3, countryName: '英国' },
      ]);
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE default_candidate_countries IN EXCLUSIVE MODE');
      await writer.query('DELETE FROM default_candidate_countries');
      for (let position = 1; position <= 4; position += 1) {
        await writer.query(
          'INSERT INTO default_candidate_countries (position, country_id, country_name) VALUES ($1, $2, $3)',
          [position, position % 2 + 1, position % 2 ? '美国' : '中国'],
        );
      }

      const claimedConfiguration = database.transaction((client) => database.completeDefaultCandidateLocationsFor(client));
      const beforeCommit = await Promise.race([
        claimedConfiguration.then(() => 'resolved'),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 30)),
      ]);
      assert.equal(beforeCommit, 'blocked', '领取读取必须等待配置原子替换提交');

      for (let position = 5; position <= 8; position += 1) {
        await writer.query(
          'INSERT INTO default_candidate_countries (position, country_id, country_name) VALUES ($1, $2, $3)',
          [position, position % 2 + 1, position % 2 ? '美国' : '中国'],
        );
      }
      await writer.query('COMMIT');
      const copied = await claimedConfiguration;
      assert.deepEqual(copied?.map((location) => location.position), [1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      await app.close();
    }
  });

  test('管理员查看 HeroSMS 状态并保存三个默认候选地区', async () => {
    const { app, database } = await openApplication();
    try {
      const session = await login(app);
      const settings = await app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers: { cookie: sessionCookie(session) } });
      assert.equal(settings.statusCode, 200);
      assert.match(settings.body, /HeroSMS 已连接/);
      assert.match(settings.body, /12\.50/);
      assert.match(settings.body, /中国/);
      assert.match(settings.body, /库存 0/);
      assert.match(settings.body, /价格 0\.1234/);
      const locationsScriptStart = settings.body.indexOf('const LOCS=');
      const locationsScriptEnd = settings.body.indexOf(';const INIT=', locationsScriptStart);
      assert.ok(locationsScriptStart >= 0 && locationsScriptEnd > locationsScriptStart, '设置页应包含地区数据脚本');
      const locationsScript = settings.body.slice(locationsScriptStart, locationsScriptEnd);
      const francePos = locationsScript.indexOf('法国');
      const usPos = locationsScript.indexOf('美国');
      const ukPos = locationsScript.indexOf('英国');
      const chinaPos = locationsScript.indexOf('中国');
      assert.ok(francePos < usPos && usPos < ukPos && ukPos < chinaPos, '候选国家选项应按中文拼音首字母排序（法国 < 美国 < 英国 < 中国）');

      const saved = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/settings`,
        headers: { cookie: sessionCookie(session), 'content-type': 'application/x-www-form-urlencoded', origin },
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}&candidateCount=3&candidate1=1&candidate2=2&candidate3=3`,
      });
      assert.equal(saved.statusCode, 303);
      assert.equal(saved.headers.location, `/${config.adminPath}/settings?saved=1`);

      const afterSave = await app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers: { cookie: sessionCookie(session) } });
      assert.match(afterSave.body, /name="candidate1" value="1"/);
      assert.match(afterSave.body, /name="candidate2" value="2"/);
      assert.match(afterSave.body, /name="candidate3" value="3"/);
      assert.deepEqual(await database.defaultCandidateLocations(), [
        { position: 1, countryId: 1, countryName: '中国' },
        { position: 2, countryId: 2, countryName: '美国' },
        { position: 3, countryId: 3, countryName: '英国' },
      ]);
      assert.deepEqual(await database.completeDefaultCandidateLocations(), [
        { position: 1, countryId: 1, countryName: '中国' },
        { position: 2, countryId: 2, countryName: '美国' },
        { position: 3, countryId: 3, countryName: '英国' },
      ]);
    } finally {
      await app.close();
    }
  });

  test('管理员可以保存重复地区但不能保存不可查询地区', async () => {
    const { app, database } = await openApplication();
    try {
      const session = await login(app);
      const headers = { cookie: sessionCookie(session), 'content-type': 'application/x-www-form-urlencoded', origin };
      const initial = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/settings`,
        headers,
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}&candidateCount=3&candidate1=1&candidate2=2&candidate3=3`,
      });
      assert.equal(initial.statusCode, 303);

      const duplicatesAllowed = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/settings`,
        headers,
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}&candidateCount=3&candidate1=1&candidate2=1&candidate3=1`,
      });
      assert.equal(duplicatesAllowed.statusCode, 303);

      const rejected = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/settings`,
        headers,
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}&candidateCount=3&candidate1=1&candidate2=1&candidate3=99`,
      });
      assert.equal(rejected.statusCode, 422);
      assert.match(rejected.body, /三至十个可查询的候选地区/);

      const settings = await app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers: { cookie: sessionCookie(session) } });
      assert.equal((settings.body.match(/name="candidate1" value="1"/g) || []).length, 1);
      assert.equal((settings.body.match(/name="candidate2" value="1"/g) || []).length, 1);
      assert.equal((settings.body.match(/name="candidate3" value="1"/g) || []).length, 1);
      assert.deepEqual(await database.defaultCandidateLocations(), [
        { position: 1, countryId: 1, countryName: '中国' },
        { position: 2, countryId: 1, countryName: '中国' },
        { position: 3, countryId: 1, countryName: '中国' },
      ]);
    } finally {
      await app.close();
    }
  });

  test('旧配置不完整时设置页提示重新保存，保存后补齐三个候选地区', async () => {
    const { app, database } = await openApplication();
    try {
      // 旧配置被收缩迁移裁剪为不足三个位置时（迁移删除缺失地区名称的行），配置视为不完整；
      // 先显式构造完整配置再删除位置 3，不依赖其他测试留下的状态。
      await database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '中国' },
        { countryId: 2, countryName: '美国' },
        { countryId: 3, countryName: '英国' },
      ]);
      await database.pool.query('DELETE FROM default_candidate_countries WHERE position = 3');
      const session = await login(app);
      const settings = await app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers: { cookie: sessionCookie(session) } });
      assert.equal(settings.statusCode, 200);
      assert.match(settings.body, /当前默认候选位置配置不完整，请重新选择并保存。/);
      assert.match(settings.body, /name="candidate1" value="1"/);
      assert.match(settings.body, /name="candidate2" value="2"/);
      assert.match(settings.body, /name="candidate3" value=""/);

      const saved = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/settings`,
        headers: { cookie: sessionCookie(session), 'content-type': 'application/x-www-form-urlencoded', origin },
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}&candidateCount=3&candidate1=1&candidate2=2&candidate3=1`,
      });
      assert.equal(saved.statusCode, 303);
      assert.deepEqual(await database.completeDefaultCandidateLocations(), [
        { position: 1, countryId: 1, countryName: '中国' },
        { position: 2, countryId: 2, countryName: '美国' },
        { position: 3, countryId: 1, countryName: '中国' },
      ]);
    } finally {
      await app.close();
    }
  });

  test('设置页安全嵌入 HeroSMS 地区名称', async () => {
    const { app } = await openApplication(unsafeNameHeroSms);
    try {
      const session = await login(app);
      const settings = await app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers: { cookie: sessionCookie(session) } });
      assert.equal(settings.statusCode, 200);
      assert.doesNotMatch(settings.body, /<\/script><script>alert\(1\)<\/script>/);
      assert.match(settings.body, /\\u003c\/script\\u003e\\u003cscript\\u003ealert\(1\)\\u003c\/script\\u003e/);
    } finally {
      await app.close();
    }
  });

  test('HeroSMS 不可用时仍显示已保存的完整候选配置且保存不会写入部分配置', async () => {
    const initial = await openApplication();
    try {
      await initial.database.replaceDefaultCandidateLocations([
        { countryId: 1, countryName: '中国' },
        { countryId: 2, countryName: '美国' },
        { countryId: 1, countryName: '中国' },
      ]);
    } finally {
      await initial.app.close();
    }

    const unavailable = await openApplication(unavailableHeroSms);
    try {
      const session = await login(unavailable.app);
      const settings = await unavailable.app.inject({ method: 'GET', url: `/${config.adminPath}/settings`, headers: { cookie: sessionCookie(session) } });
      assert.equal(settings.statusCode, 200);
      assert.match(settings.body, /暂时无法读取 HeroSMS 设置/);
      assert.match(settings.body, /中国，地区 ID 1/);
      assert.match(settings.body, /美国，地区 ID 2/);
      assert.match(settings.body, /name="candidate1" value="1"/);
      assert.match(settings.body, /name="candidate2" value="2"/);
      assert.match(settings.body, /name="candidate3" value="1"/);

      const rejected = await unavailable.app.inject({
        method: 'POST',
        url: `/${config.adminPath}/settings`,
        headers: { cookie: sessionCookie(session), 'content-type': 'application/x-www-form-urlencoded', origin },
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}&candidateCount=3&candidate1=2&candidate2=2&candidate3=2`,
      });
      assert.equal(rejected.statusCode, 503);
      assert.deepEqual(await unavailable.database.completeDefaultCandidateLocations(), [
        { position: 1, countryId: 1, countryName: '中国' },
        { position: 2, countryId: 2, countryName: '美国' },
        { position: 3, countryId: 1, countryName: '中国' },
      ]);
    } finally {
      await unavailable.app.close();
    }
  });
}
