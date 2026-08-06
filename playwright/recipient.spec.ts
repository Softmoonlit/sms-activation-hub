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
let cancelCount = 0;
const phoneNumberByCountry: Record<number, string> = { 1: '+14155550123', 2: '+442079460123', 3: '+33142278186' };
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
      activationId: latestActivationId, phoneNumber: phoneNumberByCountry[countryId]!, activationCost: 0.6, currency: 'USD',
      activationTime: new Date('2026-08-01T00:00:00.000Z'), activationEndTime: new Date('2026-08-01T00:20:00.000Z'),
    };
  },
  activeActivations: async () => [],
  activationHistory: async () => [],
  activationStatus: async () => ({ delivered: false }),
  cancelActivation: async () => {
    cancelCount += 1;
    return 'cancelled';
  },
  finishActivation: async () => undefined,
};

test('三个独立浏览器通过同一授权链接完成领取、换号和结束使用确认', async ({ browser }) => {
  acquisitionCount = 0;
  cancelCount = 0;
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

    // 浏览器 A：仅打开授权链接并看到获取号码操作，不触发领取或号码获取。
    const openingContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const openingPage = await openingContext.newPage();
    await openingPage.clock.setFixedTime(now);
    await openingPage.goto(`${origin}/a/${token}`);
    await expect(openingPage.getByRole('heading', { name: 'OpenAI' })).toBeVisible();
    await expect(openingPage.getByText('获取号码后，请在 24 小时内使用')).toBeVisible();
    await expect(openingPage.getByRole('button', { name: '获取号码' })).toBeVisible();
    await expect(openingPage.getByText(/剩余号码获取额度/)).toHaveCount(0);
    await openingContext.close();

    // 浏览器 B：使用同一授权链接领取并看到首个号码。
    const claimingContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const claimingPage = await claimingContext.newPage();
    await claimingPage.clock.setFixedTime(now);
    await claimingPage.goto(`${origin}/a/${token}`);
    await claimingPage.getByRole('button', { name: '获取号码' }).click();
    await expect(claimingPage.getByText('415 555 0123', { exact: true })).toBeVisible();
    await expect(claimingPage.getByText('(+1)', { exact: true })).toBeVisible();
    await expect(claimingPage.getByText('剩余号码获取额度：2 · 实际能否获取取决于供应商库存')).toBeVisible();
    await expect(claimingPage.getByText(/^02:00 后可换号$/)).toBeVisible();
    await expect(claimingPage.getByRole('button', { name: '更换号码' })).toBeDisabled();
    await claimingContext.close();

    // 浏览器 C：独立上下文且不复制任何接收者 Cookie，通过同一授权链接查看浏览器 B 领取的当前号码并继续换号。
    const continuingContext = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await continuingContext.newPage();
    await page.clock.setFixedTime(now);
    await page.goto(`${origin}/a/${token}`);
    await expect(page.getByText('415 555 0123', { exact: true })).toBeVisible();
    await expect(page.getByText('(+1)', { exact: true })).toBeVisible();
    await expect(page.locator('.section-current-number')).toBeVisible();
    await expect(page.locator('.section-verification-result')).toBeVisible();
    await expect(page.getByText('复制上方号码并填入，同时切换对应国家代码，点击短信（即从Whatsapp切换到短信），最后点击继续；系统将自动接收并显示验证码。')).toBeVisible();
    await expect(page.getByText(/^号码有效至：还剩 20:00$/)).toBeVisible();
    await expect(page.getByText('正在监听短信验证码...')).toBeVisible();
    await expect(page.getByText('剩余号码获取额度：2 · 实际能否获取取决于供应商库存')).toBeVisible();
    await expect(page.getByText(/^02:00 后可换号$/)).toBeVisible();
    await expect(page.getByRole('button', { name: '更换号码' })).toBeDisabled();

    // 验证可见内容的实际纵向顺序：当前号码区 < 使用说明 < 验证码结果区 < 换号操作区
    const currentNumBox = await page.locator('.section-current-number').boundingBox();
    const guideBox = await page.getByText('💡 使用说明', { exact: true }).boundingBox();
    const resultBox = await page.locator('.section-verification-result').boundingBox();
    const actionBox = await page.getByText('剩余号码获取额度：2 · 实际能否获取取决于供应商库存', { exact: true }).boundingBox();
    assert.ok(currentNumBox && guideBox && resultBox && actionBox);
    assert.ok(currentNumBox.y < guideBox.y);
    assert.ok(guideBox.y < resultBox.y);
    assert.ok(resultBox.y < actionBox.y);

    await page.getByRole('button', { name: '复制号码' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('4155550123');

    // 可控服务端时间和页面时间在领取后推进两分钟，使浏览器 C 能进入并确认换号流程。
    now = new Date('2026-08-01T00:02:00.000Z');
    await page.clock.setFixedTime(now);
    await page.reload();
    await expect(page.getByText('长时间未收到验证码，可点击更换号码')).toBeVisible();
    await expect(page.getByRole('button', { name: '更换号码' })).toBeEnabled();
    await page.getByRole('button', { name: '更换号码' }).click();
    await expect(page.getByText('更换后当前号码将不能继续使用')).toBeVisible();
    await page.getByRole('button', { name: '继续等待' }).click();
    await expect(page.getByText('415 555 0123', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '更换号码' }).click();
    await page.getByRole('button', { name: '确认更换号码' }).click();
    await expect(page.getByText('20 7946 0123', { exact: true })).toBeVisible();
    await expect(page.getByText('(+44)', { exact: true })).toBeVisible();
    await expect(page.getByText('剩余号码获取额度：1 · 实际能否获取取决于供应商库存')).toBeVisible();
    // 跨浏览器换号只取消一次当前号码；号码获取累计两次（浏览器 B 领取一次 + 浏览器 C 换号一次）。
    assert.equal(cancelCount, 1);
    assert.equal(acquisitionCount, 2);
    await page.getByRole('button', { name: '复制号码' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('2079460123');

    now = new Date('2026-08-01T00:04:00.000Z');
    await page.clock.setFixedTime(now);
    await page.reload();
    await expect(page.getByRole('button', { name: '更换号码' })).toBeEnabled();
    await page.getByRole('button', { name: '更换号码' }).click();
    await page.getByRole('button', { name: '确认更换号码' }).click();
    await expect(page.getByText('142 278 186', { exact: true })).toBeVisible();
    await expect(page.getByText('(+33)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '复制号码' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('142278186');
    now = new Date('2026-08-01T00:06:00.000Z');
    await page.clock.setFixedTime(now);
    await page.reload();
    await expect(page.getByText('仍长时间未收到验证码，可点击结束使用并联系管理员')).toBeVisible();
    await expect(page.getByRole('button', { name: '结束使用' })).toBeEnabled();
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
    assert.equal(cancelCount, 3);

    const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`${origin}/a/${token}`);
    await expect(otherPage.getByText('可用号码次数已用尽，请联系发送者')).toBeVisible();
    await expect(otherPage.getByText('此链接不可用，请联系发送者')).toHaveCount(0);
    await otherContext.close();
    await continuingContext.close();
  } finally {
    await app.close();
  }
});
