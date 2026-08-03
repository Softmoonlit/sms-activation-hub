import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import { expect, test } from '@playwright/test';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import type { HeroSms } from '../src/herosms.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Playwright 测试必须通过隔离测试数据库运行器执行');
const origin = 'http://127.0.0.1:32123';
const config: AppConfig = {
  adminPassword: 'correct-deployment-password', adminPath: 'control7', databaseUrl: databaseUrl ?? '',
  heroSmsApiKey: 'test-api-key', heroSmsWebhookAllowedIps: ['127.0.0.1'], heroSmsWebhookPath: 'test-webhook-secret-path-1234567890', heroSmsWebhookRequestsPerMinute: 120,
  loginMaxAttempts: 3, loginWindowSeconds: 900, openAiServiceCode: 'openai',
  port: 32123, publicOrigin: origin, sessionSecret: `playwright-${randomUUID()}-session-secret`, trustedProxy: false,
};
let latestActivationId = '';
let latestCountryId = 0;
let acquisitionCount = 0;
const heroSms: HeroSms = {
  balance: async () => 10,
  services: async () => [{ code: 'openai', name: 'OpenAI' }],
  countries: async () => [{ id: 1, name: '美国' }, { id: 2, name: '英国' }, { id: 3, name: '法国' }],
  quotes: async () => [{ countryId: 1, price: 1.2, stock: 1 }, { countryId: 2, price: 0.6, stock: 1 }, { countryId: 3, price: 0.9, stock: 1 }],
  getNumber: async (_serviceCode, countryId) => {
    acquisitionCount += 1;
    latestActivationId = `pw-${randomUUID()}`;
    latestCountryId = countryId;
    return {
      activationId: latestActivationId, phoneNumber: ['+442079460123', '+14155550123', '+33142278186'][acquisitionCount - 1]!, activationCost: 0.6, currency: 'USD',
      activationTime: new Date('2026-08-01T00:00:00.000Z'), activationEndTime: new Date('2026-08-01T00:20:00.000Z'),
    };
  },
  activeActivations: async () => [],
  activationHistory: async () => [],
  activationStatus: async () => ({ delivered: false }),
  cancelActivation: async () => 'cancelled',
  finishActivation: async () => undefined,
};

test('移动视口完成领取、浏览器绑定、三次号码操作和结束使用确认', async ({ browser }) => {
  acquisitionCount = 0;
  let now = new Date('2026-08-01T00:00:00.000Z');
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => now });
  await database.replaceDefaultCandidateLocations([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ]);
  await app.listen({ host: '127.0.0.1', port: 32123 });
  try {
    const loginPage = await app.inject({ method: 'GET', url: `/${config.adminPath}` });
    const csrf = loginPage.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
    const csrfCookie = loginPage.cookies.find((cookie) => cookie.name === 'admin_csrf')?.value; assert.ok(csrfCookie);
    const loggedIn = await app.inject({ method: 'POST', url: `/${config.adminPath}/login`, headers: { cookie: `admin_csrf=${csrfCookie}`, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: `csrf=${csrf}&password=${config.adminPassword}` });
    const adminSession = loggedIn.cookies.find((cookie) => cookie.name === 'admin_session')?.value; assert.ok(adminSession);
    const adminCsrf = loggedIn.cookies.find((cookie) => cookie.name === 'admin_csrf')?.value; assert.ok(adminCsrf);
    const cookie = `admin_session=${adminSession}; admin_csrf=${adminCsrf}`;
    const preview = await app.inject({ method: 'POST', url: `/${config.adminPath}/authorizations/batch/preview`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: new URLSearchParams({ csrf: adminCsrf, quantity: '1' }).toString() });
    const fingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(fingerprint);
    const created = await app.inject({ method: 'POST', url: `/${config.adminPath}/authorizations/batch`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: new URLSearchParams({ csrf: adminCsrf, quantity: '1', preflightFingerprint: fingerprint }).toString() });
    assert.equal(created.statusCode, 201);
    const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(`${origin}/a/${token}`);
    await expect(page.getByRole('heading', { name: 'OpenAI' })).toBeVisible();
    await page.getByRole('button', { name: '获取号码' }).click();
    await expect(page.locator('.number')).toHaveText('+44 20 7946 0123');
    await expect(page.getByText('剩余可用号码次数：2')).toBeVisible();
    await page.getByRole('button', { name: '复制号码' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('+442079460123');

    now = new Date('2026-08-01T00:02:00.000Z');
    await page.reload();
    await page.getByRole('button', { name: '更换号码' }).click();
    await expect(page.getByText('更换后当前号码将不能继续使用')).toBeVisible();
    await page.getByRole('button', { name: '继续等待' }).click();
    await expect(page.locator('.number')).toHaveText('+44 20 7946 0123');
    await page.getByRole('button', { name: '更换号码' }).click();
    await page.getByRole('button', { name: '确认更换号码' }).click();
    await expect(page.locator('.number')).toHaveText('+1 415 555 0123');

    now = new Date('2026-08-01T00:04:00.000Z');
    await page.reload();
    await expect(page.getByText('可换号时间')).toBeVisible();
    await page.getByRole('button', { name: '更换号码' }).click();
    await page.getByRole('button', { name: '确认更换号码' }).click();
    await expect(page.locator('.number')).toHaveText('+331 422 781 86');
    await expect(page.getByText('可结束时间')).toBeVisible();

    now = new Date('2026-08-01T00:06:00.000Z');
    await page.reload();
    await page.getByRole('button', { name: '结束使用' }).click();
    await expect(page.getByRole('heading', { name: '结束使用此号码' })).toBeVisible();
    await expect(page.getByText('结束后当前号码将不能继续使用')).toBeVisible();
    await page.getByRole('button', { name: '继续等待' }).click();
    await expect(page.getByRole('button', { name: '结束使用' })).toBeVisible();
    await page.getByRole('button', { name: '结束使用' }).click();
    await page.getByRole('button', { name: '确认结束' }).click();
    await expect(page.getByText('可用号码次数已用尽，请联系发送者')).toBeVisible();
    await expect(page.locator('.number')).toHaveCount(0);
    await expect(page.getByText('美国')).toHaveCount(0);
    assert.equal(acquisitionCount, 3);

    const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`${origin}/a/${token}`);
    await expect(otherPage.getByText('此链接不可用，请联系发送者')).toBeVisible();
    await otherContext.close();
    await context.close();
  } finally {
    await app.close();
  }
});
