import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/database.js';

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
  port: 3000,
  publicOrigin: origin,
  sessionSecret: 'test-session-secret-that-is-at-least-32-characters',
  trustedProxy: false,
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

async function openApplication(overrides: Partial<AppConfig> = {}): Promise<OpenApplication> {
  const testConfig = { ...config, ...overrides, sessionSecret: `${config.sessionSecret}-${randomUUID()}` };
  const database = new Database(testConfig.databaseUrl);
  const app = await createApp(testConfig, database);
  return { app, database };
}

async function loginMaterial(app: FastifyInstance): Promise<LoginMaterial> {
  const response = await app.inject({ method: 'GET', url: `/${config.adminPath}` });
  assert.equal(response.statusCode, 200);
  return { csrf: csrfValue(response.body), csrfCookie: cookieValue(response, 'admin_csrf') };
}

async function submitLogin(app: FastifyInstance, material: LoginMaterial, password: string, requestOrigin = origin, fetchSite?: string): Promise<InjectionResponse> {
  return app.inject({
    method: 'POST',
    url: `/${config.adminPath}/login`,
    headers: {
      cookie: `admin_csrf=${material.csrfCookie}`,
      'content-type': 'application/x-www-form-urlencoded',
      origin: requestOrigin,
      ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
    },
    payload: `csrf=${encodeURIComponent(material.csrf)}&password=${encodeURIComponent(password)}`,
  });
}

async function login(app: FastifyInstance, password = config.adminPassword): Promise<{ adminCookie: string; csrfCookie: string }> {
  const response = await submitLogin(app, await loginMaterial(app), password);
  assert.equal(response.statusCode, 303);
  return {
    adminCookie: cookieValue(response, 'admin_session'),
    csrfCookie: cookieValue(response, 'admin_csrf'),
  };
}

if (!databaseUrl) {
  test('管理员认证集成测试需要 TEST_DATABASE_URL', () => {
    throw new Error('未设置 TEST_DATABASE_URL；请通过 npm test 运行完整测试');
  });
} else {
  test('健康检查可用，公开和常见后台路径均为 404', async () => {
    const { app } = await openApplication();
    try {
      assert.deepEqual((await app.inject('/health')).json(), { status: 'ok' });
      for (const path of ['/', '/admin', '/login', '/does-not-exist']) {
        assert.equal((await app.inject(path)).statusCode, 404, `${path} 应为 404`);
      }
    } finally {
      await app.close();
    }
  });

  test('管理员可登录，Cookie 具备安全属性且 CSRF 请求受到保护', async () => {
    const { app } = await openApplication();
    try {
      const session = await login(app);
      const shell = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: `admin_session=${session.adminCookie}` } });
      assert.match(shell.body, /管理后台/);
      assert.match(shell.headers['set-cookie']?.toString() ?? '', /HttpOnly; Secure; SameSite=Strict/);

      const rejected = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/logout`,
        headers: { cookie: `admin_session=${session.adminCookie}; admin_csrf=${session.csrfCookie}`, origin },
        payload: {},
      });
      assert.equal(rejected.statusCode, 403);

      const loggedOut = await app.inject({
        method: 'POST',
        url: `/${config.adminPath}/logout`,
        headers: {
          cookie: `admin_session=${session.adminCookie}; admin_csrf=${session.csrfCookie}`,
          'content-type': 'application/x-www-form-urlencoded',
          origin,
        },
        payload: `csrf=${encodeURIComponent(session.csrfCookie)}`,
      });
      assert.equal(loggedOut.statusCode, 303);
      const afterLogout = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: `admin_session=${session.adminCookie}` } });
      assert.match(afterLogout.body, /管理员登录/);
    } finally {
      await app.close();
    }
  });

  test('同源表单的 null Origin 仍受 CSRF token 保护并可登录', async () => {
    const { app } = await openApplication();
    try {
      const response = await submitLogin(app, await loginMaterial(app), config.adminPassword, 'null', 'same-origin');
      assert.equal(response.statusCode, 303);
    } finally {
      await app.close();
    }
  });

  test('新登录撤销旧会话，应用重新初始化也撤销会话', async () => {
    const first = await openApplication();
    let firstClosed = false;
    let restarted: OpenApplication | undefined;
    try {
      const oldSession = await login(first.app);
      const newSession = await login(first.app);
      const oldPage = await first.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: `admin_session=${oldSession.adminCookie}` } });
      const newPage = await first.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: `admin_session=${newSession.adminCookie}` } });
      assert.match(oldPage.body, /管理员登录/);
      assert.match(newPage.body, /管理后台/);

      await first.app.close();
      firstClosed = true;
      restarted = await openApplication();
      const afterRestart = await restarted.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: `admin_session=${newSession.adminCookie}` } });
      assert.match(afterRestart.body, /管理员登录/);
    } finally {
      await restarted?.app.close();
      if (!firstClosed) {
        await first.app.close();
      }
    }
  });

  test('错误登录按来源限速，限速窗口内不接受正确密码', async () => {
    const { app } = await openApplication();
    try {
      let material = await loginMaterial(app);
      for (let attempt = 0; attempt < config.loginMaxAttempts; attempt += 1) {
        const response = await submitLogin(app, material, 'incorrect-password');
        assert.equal(response.statusCode, 401);
        material = { csrf: csrfValue(response.body), csrfCookie: cookieValue(response, 'admin_csrf') };
      }

      const rateLimited = await submitLogin(app, material, config.adminPassword);
      assert.equal(rateLimited.statusCode, 429);
    } finally {
      await app.close();
    }
  });

  test('过期会话与配置密码变化后的会话不能访问后台', async () => {
    const first = await openApplication();
    try {
      const session = await login(first.app);
      await first.database.pool.query("UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [session.adminCookie]);
      const expired = await first.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: `admin_session=${session.adminCookie}` } });
      assert.match(expired.body, /管理员登录/);

      const freshSession = await login(first.app);
      const changedPassword = await openApplication({ adminPassword: 'changed-deployment-password' });
      try {
        const revoked = await changedPassword.app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie: `admin_session=${freshSession.adminCookie}` } });
        assert.match(revoked.body, /管理员登录/);
      } finally {
        await changedPassword.app.close();
      }
    } finally {
      await first.app.close();
    }
  });
}
