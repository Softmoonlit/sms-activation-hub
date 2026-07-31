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
const heroSms: HeroSms = {
  balance: async () => 10,
  services: async () => [{ code: 'openai', name: 'OpenAI' }],
  countries: async () => [{ id: 1, name: '美国' }, { id: 2, name: '英国' }, { id: 3, name: '法国' }],
  quotes: async () => [{ countryId: 1, price: 1.2, stock: 1 }, { countryId: 2, price: 0.6, stock: 1 }, { countryId: 3, price: 0.9, stock: 1 }],
  getNumber: async () => {
    latestActivationId = `pw-${randomUUID()}`;
    return {
      activationId: latestActivationId, phoneNumber: '+442079460123', activationCost: 0.6, currency: 'USD',
      activationTime: new Date('2026-08-01T00:00:00.000Z'), activationEndTime: new Date('2026-08-01T00:20:00.000Z'),
    };
  },
  activeActivations: async () => [],
  activationHistory: async () => [],
  activationStatus: async () => ({ delivered: false }),
  finishActivation: async () => undefined,
};

test('移动视口完成领取、浏览器绑定、号码显示和复制', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  await app.listen({ host: '127.0.0.1', port: 32123 });
  try {
    const loginPage = await app.inject({ method: 'GET', url: `/${config.adminPath}` });
    const csrf = loginPage.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
    const csrfCookie = loginPage.cookies.find((cookie) => cookie.name === 'admin_csrf')?.value; assert.ok(csrfCookie);
    const loggedIn = await app.inject({ method: 'POST', url: `/${config.adminPath}/login`, headers: { cookie: `admin_csrf=${csrfCookie}`, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: `csrf=${csrf}&password=${config.adminPassword}` });
    const adminSession = loggedIn.cookies.find((cookie) => cookie.name === 'admin_session')?.value; assert.ok(adminSession);
    const adminCsrf = loggedIn.cookies.find((cookie) => cookie.name === 'admin_csrf')?.value; assert.ok(adminCsrf);
    const cookie = `admin_session=${adminSession}; admin_csrf=${adminCsrf}`;
    const recipientIdentifier = randomUUID();
    const preview = await app.inject({ method: 'POST', url: `/${config.adminPath}/authorizations/preview`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: new URLSearchParams({ csrf: adminCsrf, recipientIdentifier }).toString() });
    const fingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(fingerprint);
    const created = await app.inject({ method: 'POST', url: `/${config.adminPath}/authorizations`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin }, payload: new URLSearchParams({ csrf: adminCsrf, recipientIdentifier, preflightFingerprint: fingerprint }).toString() });
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

    const webhook = await app.inject({ method: 'POST', url: `/${config.heroSmsWebhookPath}`, payload: {
      activationId: latestActivationId, service: 'openai', country: 2, receivedAt: '2026-08-01T00:03:00.000Z',
      code: '482913', text: 'Your code is 482913',
    } });
    assert.equal(webhook.statusCode, 200);
    await page.reload();
    await expect(page.locator('#verification-code')).toHaveText('482913');
    await expect(page.getByRole('button', { name: '复制验证码' })).toBeVisible();
    await expect(page.getByRole('button', { name: '获取号码' })).toHaveCount(0);
    await expect(page.getByText('可换号时间')).toHaveCount(0);
    await page.getByRole('button', { name: '复制验证码' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('482913');

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
