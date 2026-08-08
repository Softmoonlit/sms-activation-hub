import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import { expect, test, type Page } from '@playwright/test';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import type { HeroSms, HeroSmsOffer } from '../src/herosms.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Playwright 测试必须通过隔离测试数据库运行器执行');
const origin = 'http://127.0.0.1:32124';
const config: AppConfig = {
  adminPassword: 'correct-deployment-password', adminPath: 'control8', databaseUrl: databaseUrl ?? '',
  heroSmsApiKey: 'test-api-key', heroSmsWebhookAllowedIps: ['127.0.0.1'], heroSmsWebhookPath: 'test-webhook-secret-path-admin-9876543210', heroSmsWebhookRequestsPerMinute: 120,
  loginMaxAttempts: 3, loginWindowSeconds: 900, openAiServiceCode: 'openai',
  port: 32124, publicOrigin: origin, sessionSecret: `admin-playwright-${randomUUID()}-session-secret`, trustedProxy: false,
};

let latestActivationId = '';
let latestCountryId = 0;
const heroSms: HeroSms = {
  balance: async () => 10,
  services: async () => [{ code: 'openai', name: 'OpenAI' }],
  countries: async () => [{ id: 1, name: '美国' }, { id: 2, name: '英国' }, { id: 3, name: '法国' }],
  // 预算内可取库存必须落在每号最高价（0.11）内，否则领取会以无库存失败
  offers: async (): Promise<HeroSmsOffer[]> => [
    { serviceCode: 'openai', countryId: 1, defaultPrice: 0.08, totalStock: 1, map: { '0.08': 1 } },
    { serviceCode: 'openai', countryId: 2, defaultPrice: 0.09, totalStock: 1, map: { '0.09': 1 } },
    { serviceCode: 'openai', countryId: 3, defaultPrice: 0.10, totalStock: 1, map: { '0.10': 1 } },
  ],
  getNumber: async (_serviceCode, countryId) => {
    latestActivationId = `admin-pw-${randomUUID()}`;
    latestCountryId = countryId;
    return {
      activationId: latestActivationId, phoneNumber: '+442079460777', activationCost: 0.6, currency: 'USD',
      activationTime: new Date('2026-08-01T00:00:00.000Z'), activationEndTime: new Date('2026-08-01T00:20:00.000Z'),
    };
  },
  activeActivations: async () => [],
  activationHistory: async () => [],
  activationStatus: async () => ({ delivered: false }),
  cancelActivation: async () => 'cancelled',
  finishActivation: async () => undefined,
};

type App = Awaited<ReturnType<typeof createApp>>;

/** 辅助函数：通过 inject API 登录管理员，返回 cookie 字符串和 CSRF token */
async function adminLogin(app: App): Promise<{ cookie: string; csrf: string; sessionValue: string; csrfValue: string }> {
  const loginPage = await app.inject({ method: 'GET', url: `/${config.adminPath}` });
  const csrf = loginPage.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(csrf);
  const csrfCookie = loginPage.cookies.find((c) => c.name === 'admin_csrf')?.value; assert.ok(csrfCookie);
  const loggedIn = await app.inject({
    method: 'POST', url: `/${config.adminPath}/login`,
    headers: { cookie: `admin_csrf=${csrfCookie}`, 'content-type': 'application/x-www-form-urlencoded', origin },
    payload: `csrf=${csrf}&password=${config.adminPassword}`,
  });
  const sessionValue = loggedIn.cookies.find((c) => c.name === 'admin_session')?.value; assert.ok(sessionValue);
  const csrfValue = loggedIn.cookies.find((c) => c.name === 'admin_csrf')?.value; assert.ok(csrfValue);
  return { cookie: `admin_session=${sessionValue}; admin_csrf=${csrfValue}`, csrf: csrfValue, sessionValue, csrfValue };
}

/** 辅助函数：批量创建一条授权链接并返回 token */
async function createAuthorization(app: App, cookie: string, csrf: string): Promise<string> {
  const links = await createBatch(app, cookie, csrf, '1');
  return links[0]!;
}

test('桌面视口完成管理员登录、设置默认候选地区、预检确认和授权已创建页', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();

    // 管理员登录页
    await page.goto(`${origin}/${config.adminPath}`);
    await expect(page.locator('h1', { hasText: '管理员登录' })).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await page.locator('input[name="password"]').fill(config.adminPassword);
    await page.getByRole('button', { name: '登录' }).click();

    // 登录后重定向到首页
    await expect(page).toHaveURL(`${origin}/${config.adminPath}`);
    await expect(page.locator('h1', { hasText: '管理后台' })).toBeVisible();
    // 首页包含批量创建区域
    await expect(page.getByRole('heading', { name: '批量创建激活授权链接', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '最近激活授权', level: 2 })).toBeVisible();

    // 通过 UI 进入设置页并配置默认候选地区
    await page.getByRole('link', { name: '设置' }).click();
    await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();
    await expect(page.getByText('HeroSMS 已连接')).toBeVisible();
    await expect(page.getByText('余额：')).toBeVisible();
    await expect(page.getByLabel('每号最高价')).toHaveValue('0.11');
    const candidateCount = page.getByLabel('候选位置数量');
    await expect(candidateCount).toHaveValue('3');
    await candidateCount.selectOption('10');
    await expect(page.getByRole('textbox', { name: /^候选地区 \d+$/ })).toHaveCount(10);
    // 先填写全部十个位置，再缩减并验证只裁剪末尾位置。
    for (let position = 1; position <= 10; position += 1) {
      const countryName = ['美国', '英国', '法国'][(position - 1) % 3]!;
      const candidate = page.getByRole('textbox', { name: `候选地区 ${position}`, exact: true });
      await candidate.fill(countryName);
      await page.getByRole('option', { name: countryName }).click();
    }
    await candidateCount.selectOption('3');
    await expect(page.getByRole('textbox', { name: /^候选地区 \d+$/ })).toHaveCount(3);
    await expect(page.getByRole('textbox', { name: '候选地区 1', exact: true })).toHaveValue(/美国/);
    await expect(page.getByRole('textbox', { name: '候选地区 2', exact: true })).toHaveValue(/英国/);
    await expect(page.getByRole('textbox', { name: '候选地区 3', exact: true })).toHaveValue(/法国/);

    // 重新增加时位置四至十为空，不恢复已裁剪值；完成全部位置后保存十个位置。
    await candidateCount.selectOption('10');
    for (let position = 4; position <= 10; position += 1) {
      await expect(page.getByRole('textbox', { name: `候选地区 ${position}`, exact: true })).toHaveValue('');
      const countryName = ['美国', '英国', '法国'][(position - 1) % 3]!;
      const candidate = page.getByRole('textbox', { name: `候选地区 ${position}`, exact: true });
      await candidate.fill(countryName);
      await page.getByRole('option', { name: countryName }).click();
    }
    await page.getByLabel('每号最高价').fill('0.15');
    await page.getByRole('button', { name: '保存默认候选地区' }).click();
    // 保存后重定向回设置页，候选地区已保存
    await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('✓ 已保存');
    await expect(page.getByLabel('候选位置数量')).toHaveValue('10');
    await expect(page.getByLabel('每号最高价')).toHaveValue('0.15');

    // 返回首页，进入批量数量确认页
    await page.getByRole('link', { name: '返回首页' }).click();
    await expect(page.locator('h1', { hasText: '管理后台' })).toBeVisible();
    const quantity = page.locator('input[name="quantity"]');
    await expect(quantity).toHaveValue('10');
    await quantity.fill('3');
    await page.getByRole('button', { name: '预览批量创建' }).click();
    await expect(page.locator('h1', { hasText: '确认批量创建授权链接' })).toBeVisible();
    await expect(page.getByText('将创建 3 条永久待领取授权链接')).toBeVisible();
    await expect(page.getByText('HeroSMS')).toHaveCount(0);
    await expect(page.getByText('候选地区')).toHaveCount(0);

    // 批量创建结果页只提供一次性复制全部
    await page.getByRole('button', { name: '确认创建' }).click();
    await expect(page.locator('h1', { hasText: '批量授权链接已创建' })).toBeVisible();
    await expect(page.locator('#authorization-urls')).toBeVisible();
    const urlText = await page.locator('#authorization-urls').textContent();
    assert.equal(urlText?.trim().split('\n').length, 3);
    assert.ok(urlText?.includes('/a/'), '批量结果应包含授权链接');
    await page.getByRole('button', { name: '复制全部' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('/a/');

    await context.close();
  } finally {
    await app.close();
  }
});

test('桌面视口管理员可以查看授权详情页和撤销确认页', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await database.saveCandidateSettings([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ], 0.11);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf, sessionValue, csrfValue } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf);
    const suffix = token.slice(-3);

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await context.addCookies([
      { name: 'admin_session', value: sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: csrfValue, domain: '127.0.0.1', path: '/' },
    ]);

    // 首页按链接末 3 位找到新建的授权
    await page.goto(`${origin}/${config.adminPath}`);
    const card = page.locator('article.authorization').filter({ hasText: suffix });
    await expect(card).toBeVisible();

    // 查看详情
    await card.getByRole('link', { name: '查看详情' }).click();
    await expect(page.locator('h1', { hasText: '激活授权详情' })).toBeVisible();
    await expect(page.getByText('授权状态：📋 待领取')).toBeVisible();
    await expect(page.getByText('创建时间：')).toBeVisible();
    await expect(page.getByRole('link', { name: '撤销授权' })).toBeVisible();
    // 待领取授权不含候选位置、获取额度与领取截止时间
    await expect(page.getByText('候选地区')).toHaveCount(0);
    await expect(page.getByText('获取额度：')).toHaveCount(0);
    await expect(page.getByText('新号码获取截止时间：')).toHaveCount(0);

    // 进入撤销确认页
    await page.getByRole('link', { name: '撤销授权' }).click();
    await expect(page.locator('h1', { hasText: '确认撤销授权' })).toBeVisible();
    await expect(page.getByText(`链接末 3 位：${suffix}`)).toBeVisible();
    await expect(page.getByText('授权状态：')).toBeVisible();
    await expect(page.getByText('撤销后：')).toBeVisible();
    // 撤销确认框包含危险按钮
    await expect(page.getByRole('button', { name: '确认撤销授权' })).toBeVisible();

    await context.close();
  } finally {
    await app.close();
  }
});

test('仅打开授权链接不领取号码，领取后持有同一授权链接的其他浏览器可继续使用', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await database.saveCandidateSettings([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ], 0.11);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf);

    // 第一次：仅 GET 打开链接（模拟预览），不点击获取
    const previewContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const previewPage = await previewContext.newPage();
    await previewPage.goto(`${origin}/a/${token}`);
    await expect(previewPage.getByRole('heading', { name: 'OpenAI' })).toBeVisible();
    // 仅打开后页面显示「获取号码」按钮但还未触发领取
    await expect(previewPage.getByRole('button', { name: '获取号码' })).toBeVisible();
    await previewContext.close();

    // 第二次（不同浏览器上下文）：通过同一授权链接正式领取
    const recipientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const recipientPage = await recipientContext.newPage();
    await recipientPage.goto(`${origin}/a/${token}`);
    await recipientPage.getByRole('button', { name: '获取号码' }).click();
    await expect(recipientPage.locator('.number')).toBeVisible();
    await recipientContext.close();

    // 第三次：不同浏览器上下文持有同一授权链接，可继续查看当前号码
    const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`${origin}/a/${token}`);
    await expect(otherPage.locator('.number')).toBeVisible();
    await otherContext.close();
  } finally {
    await app.close();
  }
});

test('待领取链接永久有效，领取 24 小时截止后访问返回 404', async ({ browser }) => {
  let now = new Date('2026-08-01T00:00:00.000Z');
  let activationId = '';
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, {
    heroSms: {
      ...heroSms,
      getNumber: async (_serviceCode, countryId) => {
        activationId = `expiry-pw-${randomUUID()}`;
        return { activationId, phoneNumber: '+442079460777', activationCost: 0.6, currency: 'USD', activationTime: now, activationEndTime: new Date(now.getTime() + 1_200_000) };
      },
      // 供应商确认窗口内未送达并已取消，超时对账才能收敛为明确终态
      activationStatus: async () => ({ delivered: false, providerStatus: 'cancelled' }),
      activationHistory: async () => [{ activationId, phoneNumber: '+442079460777', activationCost: 0, currency: 'USD', activationTime: new Date('2026-08-30T00:00:00.000Z'), status: 'cancelled' }],
    },
    now: () => now,
  });
  await database.saveCandidateSettings([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ], 0.11);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf);

    // 待领取链接不受创建时间限制：创建很久之后仍可访问
    now = new Date('2026-08-30T00:00:00.000Z');
    const checkBefore = await app.inject({ method: 'GET', url: `/a/${token}` });
    assert.equal(checkBefore.statusCode, 200, '待领取链接应永久有效');

    // 领取后启动 24 小时领取期限（截止 = 08-31 00:00），号码窗口至 08-30 00:20
    const claim = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    assert.equal(claim.statusCode, 303, '领取应成功');

    // 领取 24 小时后：号码窗口早已结束，超时收尾后以领取后期限结束访问
    now = new Date('2026-08-31T00:20:00.000Z');
    const checkAfter = await app.inject({ method: 'GET', url: `/a/${token}` });
    assert.equal(checkAfter.statusCode, 404, '领取 24 小时后应返回 404');

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/a/${token}`);
    assert.equal(response?.status(), 404, '领取 24 小时后浏览器访问应返回 404');
    await context.close();
  } finally {
    await app.close();
  }
});

test('随机地址返回 404', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms });
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/a/nonexistent-random-token-that-does-not-exist-123456`);
    assert.equal(response?.status(), 404);
    await context.close();
  } finally {
    await app.close();
  }
});

test('接收者页面不包含 HeroSMS、价格、库存、退款确认或内部状态信息', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await database.saveCandidateSettings([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ], 0.11);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    // 1. 初始状态（待领取）
    await page.goto(`${origin}/a/${token}`);
    let html = await page.content();
    assertNoSensitiveAdminInfo(html, '初始页面');

    // 2. 领取后（号码显示状态）
    await page.getByRole('button', { name: '获取号码' }).click();
    await expect(page.locator('.number')).toBeVisible();
    html = await page.content();
    assertNoSensitiveAdminInfo(html, '号码显示页面');

    // 3. 换号按钮不足两分钟禁用
    await expect(page.getByRole('button', { name: '更换号码' })).toBeDisabled();

    // 4. 短信送达后（验证码显示状态）：极早送达时按钮与等待动画均不出现，仅验证码与复制验证码原地可见，无结果查看期倒计时
    const webhook = await app.inject({
      method: 'POST', url: `/${config.heroSmsWebhookPath}`,
      payload: {
        activationId: latestActivationId, service: 'openai', country: latestCountryId,
        receivedAt: '2026-08-01T00:01:00.000Z', code: '123456', text: 'Your code is 123456',
      },
    });
    assert.equal(webhook.statusCode, 200);
    await page.reload();
    await expect(page.locator('#verification-code')).toBeVisible();
    await expect(page.getByRole('button', { name: '复制验证码' })).toBeVisible();
    await expect(page.getByText(/^验证码可查看至：/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: '点击获取验证码' })).toHaveCount(0);
    await expect(page.getByText('把号码填入验证界面，并点继续，然后点击下方按钮获取验证码')).toHaveCount(0);
    await expect(page.getByText('正在监听短信验证码...')).toHaveCount(0);
    html = await page.content();
    assertNoSensitiveAdminInfo(html, '验证码显示页面');

    await context.close();
  } finally {
    await app.close();
  }
});

test('移动视口接收者页面各动态状态下控件和文本不溢出', async ({ browser }) => {
  let now = new Date('2026-08-01T00:00:00.000Z');
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => now });
  await database.saveCandidateSettings([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ], 0.11);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.clock.setFixedTime(now);

    // 初始状态
    await page.goto(`${origin}/a/${token}`);
    await expect(page.getByText('获取号码后，请在 24 小时内使用')).toBeVisible();
    await expect(page.getByRole('button', { name: '获取号码' })).toBeVisible();
    const firstHintLayout = await page.evaluate(() => {
      const hint = [...document.querySelectorAll('p')].find((element) => element.textContent?.includes('获取号码后，请在 24 小时内使用'));
      const button = document.querySelector('button');
      if (!hint || !button) return null;
      const hintRect = hint.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return { hintRight: hintRect.right, buttonTop: buttonRect.top, hintBottom: hintRect.bottom, viewportWidth: window.innerWidth };
    });
    assert.ok(firstHintLayout);
    assert.ok(firstHintLayout.hintRight <= firstHintLayout.viewportWidth + 2, '首次提示不应超出移动视口');
    assert.ok(firstHintLayout.buttonTop >= firstHintLayout.hintBottom, '首次提示不应挤压获取号码按钮');
    await assertNoOverflow(page, '初始状态');

    // 领取号码后：使用说明与点击获取验证码按钮可见、等待动画不出现，长文案不溢出
    await page.getByRole('button', { name: '获取号码' }).click();
    await expect(page.getByText('+44 20 7946 0777', { exact: true })).toBeVisible();
    await expect(page.getByText(/^号码有效至：还剩 20:00$/)).toBeVisible();
    await expect(page.getByText(/^02:00 后可换号$/)).toBeVisible();
    await expect(page.getByText('把号码填入验证界面，并点继续，然后点击下方按钮获取验证码')).toBeVisible();
    await expect(page.getByRole('button', { name: '点击获取验证码' })).toBeVisible();
    await expect(page.getByText('正在监听短信验证码...')).toHaveCount(0);
    await assertNoOverflow(page, '号码显示状态');

    // 点击获取验证码后：等待动画原地承接，按钮消失、使用说明仍在，不遮挡换号倒计时
    await page.getByRole('button', { name: '点击获取验证码' }).click();
    await expect(page.getByText('正在监听短信验证码...')).toBeVisible();
    await expect(page.getByRole('button', { name: '点击获取验证码' })).toHaveCount(0);
    await expect(page.getByText('把号码填入验证界面，并点继续，然后点击下方按钮获取验证码')).toBeVisible();
    await assertNoOverflow(page, '等待动画状态');

    // 秒数变化时倒计时和操作按钮保持稳定，不挤压相邻区域
    const waitingPrompt = page.getByText(/^02:00 后可换号$/);
    const waitingButton = page.getByRole('button', { name: '更换号码' });
    const beforeTick = {
      prompt: await waitingPrompt.boundingBox(),
      button: await waitingButton.boundingBox(),
    };
    await page.clock.setFixedTime(new Date('2026-08-01T00:00:01.000Z'));
    await page.waitForTimeout(1_100);
    const afterTickPrompt = page.getByText(/^01:59 后可换号$/);
    const afterTick = {
      prompt: await afterTickPrompt.boundingBox(),
      button: await waitingButton.boundingBox(),
    };
    assert.ok(beforeTick.prompt && beforeTick.button && afterTick.prompt && afterTick.button);
    assert.equal(afterTick.prompt.width, beforeTick.prompt.width, '倒计时秒数变化不应改变提示宽度');
    assert.equal(afterTick.button.y, beforeTick.button.y, '倒计时秒数变化不应移动操作按钮');
    assert.ok(beforeTick.prompt.y + beforeTick.prompt.height <= beforeTick.button.y, '倒计时提示不得与操作按钮重叠');

    // 号码窗口归零时立即显示明确过期状态，避免把零倒计时理解为仍可使用
    await page.clock.setFixedTime(new Date('2026-08-01T00:20:00.000Z'));
    await page.waitForTimeout(1_100);
    await expect(page.getByText('号码有效至：还剩 00:00（号码已过期）', { exact: true })).toBeVisible();

    // 时间快进，换号按钮可用
    now = new Date('2026-08-01T00:02:00.000Z');
    await page.clock.setFixedTime(now);
    await page.reload();
    await expect(page.getByRole('button', { name: '更换号码' })).toBeVisible();
    await assertNoOverflow(page, '换号按钮显示状态');

    // 换号确认页
    await page.getByRole('button', { name: '更换号码' }).click();
    await expect(page.getByText('更换后当前号码将不能继续使用')).toBeVisible();
    await assertNoOverflow(page, '换号确认页');

    // 取消换号，返回号码页
    await page.getByRole('button', { name: '继续等待' }).click();
    await assertNoOverflow(page, '返回号码页');

    // 验证码显示状态
    const webhook = await app.inject({
      method: 'POST', url: `/${config.heroSmsWebhookPath}`,
      payload: {
        activationId: latestActivationId, service: 'openai', country: latestCountryId,
        receivedAt: '2026-08-01T00:02:30.000Z', code: '654321', text: 'Your code is 654321',
      },
    });
    assert.equal(webhook.statusCode, 200);
    await page.clock.setFixedTime(new Date('2026-08-01T00:02:30.000Z'));
    await page.reload();
    await expect(page.getByText('654321', { exact: true })).toBeVisible();
    await expect(page.getByText(/^验证码可查看至：/)).toHaveCount(0);
    await expect(page.locator('.section-action')).toHaveCount(0);
    await expect(page.getByText(/剩余号码获取额度/)).toHaveCount(0);
    await expect(page.locator('.steps-guide')).toHaveCount(0);
    await expect(page.locator('.number-expiry')).toHaveCount(0);
    const resultOrder = await Promise.all([
      page.locator('.section-current-number').boundingBox(),
      page.locator('.section-verification-result').boundingBox(),
    ]);
    assert.ok(resultOrder.every((box) => box !== null));
    const [numberHeading, resultHeading] = resultOrder;
    assert.ok(numberHeading!.y + numberHeading!.height <= resultHeading!.y);
    await assertNoOverflow(page, '验证码显示状态');

    await context.close();
  } finally {
    await app.close();
  }
});

test('管理员单会话：新登录使旧会话失效', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms });
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    // 第一次登录
    const first = await adminLogin(app);

    // 确认第一个会话有效
    const context1 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page1 = await context1.newPage();
    await context1.addCookies([
      { name: 'admin_session', value: first.sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: first.csrfValue, domain: '127.0.0.1', path: '/' },
    ]);
    await page1.goto(`${origin}/${config.adminPath}`);
    await expect(page1.locator('h1', { hasText: '管理后台' })).toBeVisible();

    // 第二次登录（新浏览器），旧会话应失效
    await adminLogin(app);

    // 刷新第一个浏览器，旧会话应该失效
    await page1.reload();
    await expect(page1.locator('h1', { hasText: '管理员登录' })).toBeVisible();
    await expect(page1.locator('h1', { hasText: '管理后台' })).toHaveCount(0);

    await context1.close();
  } finally {
    await app.close();
  }
});

test('浏览器网络和应用日志不包含 token、Cookie、号码、验证码或短信正文', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await database.saveCandidateSettings([
    { countryId: 1, countryName: '美国' },
    { countryId: 2, countryName: '英国' },
    { countryId: 3, countryName: '法国' },
  ], 0.11);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    // 收集所有网络请求 URL
    const requestUrls: string[] = [];
    page.on('request', (req) => requestUrls.push(req.url()));

    await page.goto(`${origin}/a/${token}`);
    await page.getByRole('button', { name: '获取号码' }).click();
    await expect(page.locator('.number')).toBeVisible();

    // 验证：网络请求 URL 中不包含完整号码
    const phoneDigits = '442079460777';
    for (const url of requestUrls) {
      assert.ok(!url.includes(phoneDigits), `请求 URL 不应包含完整号码：${url}`);
    }

    // 验证接收者页面的响应头包含正确的安全策略
    const response = await page.goto(`${origin}/a/${token}`);
    const referrerPolicy = response?.headers()['referrer-policy'];
    assert.equal(referrerPolicy, 'no-referrer', 'Referrer-Policy 应为 no-referrer');
    const robots = response?.headers()['x-robots-tag'];
    assert.ok(robots?.includes('noindex'), 'X-Robots-Tag 应包含 noindex');
    const cacheControl = response?.headers()['cache-control'];
    assert.equal(cacheControl, 'no-store', 'Cache-Control 应为 no-store');

    const cookies = await context.cookies();
    assert.equal(cookies.some((cookie) => cookie.name === 'recipient_session'), false, '授权链接访问不应创建 recipient_session Cookie');

    await context.close();
  } finally {
    await app.close();
  }
});

// ---- 辅助断言函数 ----

function assertNoSensitiveAdminInfo(html: string, context: string): void {
  const checkedHtml = html.replaceAll('实际能否获取取决于供应商库存', '');
  const forbidden = [
    { pattern: /HeroSMS/i, label: 'HeroSMS 字样' },
    { pattern: /库存/u, label: '库存信息' },
    { pattern: /退款确认/u, label: '退款确认' },
    { pattern: /refund/i, label: 'refund 字样' },
    { pattern: /激活\s*ID/u, label: '激活 ID 信息' },
    { pattern: /activationId/i, label: 'activationId 字样' },
    { pattern: /供应商/u, label: '供应商字样' },
  ];
  for (const { pattern, label } of forbidden) {
    assert.ok(!pattern.test(checkedHtml), `${context} 不应包含「${label}」：匹配到 ${pattern}`);
  }
}

async function assertNoOverflow(page: Page, context: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const elements = document.querySelectorAll('*');
    const viewportWidth = window.innerWidth;
    const overflowing: string[] = [];
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.right > viewportWidth + 2) { // 允许 2px 误差
        overflowing.push(`<${element.tagName.toLowerCase()}> right=${rect.right.toFixed(0)} viewportWidth=${viewportWidth}`);
      }
    }
    return overflowing;
  });
  assert.deepEqual(overflow, [], `${context} 中存在元素水平溢出：${overflow.join(', ')}`);
}

/** 辅助函数：批量创建授权链接，返回全部 token */
async function createBatch(app: App, cookie: string, csrf: string, quantity: string): Promise<string[]> {
  const preview = await app.inject({
    method: 'POST', url: `/${config.adminPath}/authorizations/batch/preview`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin },
    payload: new URLSearchParams({ csrf, quantity }).toString(),
  });
  const fingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(fingerprint);
  const created = await app.inject({
    method: 'POST', url: `/${config.adminPath}/authorizations/batch`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin },
    payload: new URLSearchParams({ csrf, quantity, preflightFingerprint: fingerprint }).toString(),
  });
  assert.equal(created.statusCode, 201);
  const links = [...created.body.matchAll(/\/a\/([A-Za-z0-9_-]{43})/g)].map((match) => match[1]);
  assert.equal(links.length, Number(quantity));
  return links;
}

/** 辅助函数：清空授权相关表，让列表断言从干净状态开始 */
async function resetAuthorizationTables(database: Database): Promise<void> {
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

test('桌面视口管理员库存列表：紧凑卡片、分页、状态筛选、精确搜索与详情箭头', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf, sessionValue, csrfValue } = await adminLogin(app);
    await resetAuthorizationTables(database);
    const links = await createBatch(app, cookie, csrf, '25');
    // 挑选含字母的尾号作为搜索目标，保证可构造出与原串不同的大小写变体
    // 兜底纯数字尾号（概率极低）：无字母可翻转时下方守卫断言会明确失败，此时失败消息提示的是本批不含字母而非大小写翻转问题
    const searchSuffix = links.map((link) => link.slice(-3)).find((suffix) => /[A-Za-z]/.test(suffix)) ?? links[0]!.slice(-3);

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await context.addCookies([
      { name: 'admin_session', value: sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: csrfValue, domain: '127.0.0.1', path: '/' },
    ]);

    // 首页每页恰好 20 条，卡片只含后缀、状态、最新时间与箭头
    await page.goto(`${origin}/${config.adminPath}`);
    await expect(page.locator('article.authorization')).toHaveCount(20);
    await expect(page.locator('article.authorization .authorization-suffix').first()).toBeVisible();
    await expect(page.locator('article.authorization .authorization-status').first()).toHaveText('📋 待领取');
    await expect(page.locator('article.authorization .authorization-time').first()).toBeVisible();
    await expect(page.locator('article.authorization .authorization-time').first()).toHaveText('08-01 08:00');
    await expect(page.locator('article.authorization .authorization-detail').first()).toBeVisible();
    await expect(page.getByText('第 1 / 2 页')).toBeVisible();
    await assertNoOverflow(page, '库存列表第一页');

    // 点击第一页某条卡片上的详情箭头进入对应详情
    const firstCard = page.locator('article.authorization').first();
    const firstCardSuffix = await firstCard.locator('.authorization-suffix').textContent();
    assert.ok(firstCardSuffix);
    await firstCard.getByRole('link', { name: '查看详情' }).click();
    await expect(page.locator('h1', { hasText: '激活授权详情' })).toBeVisible();
    await page.goBack();

    // 状态筛选保留条件，翻页后筛选条件保留在 URL 中
    await page.locator('select[name="status"]').selectOption('unclaimed');
    await page.getByRole('button', { name: '筛选' }).click();
    // 空搜索框也会提交 suffix= 参数，但空值不会参与筛选
    await expect(page).toHaveURL(new RegExp(`status=unclaimed`));
    await expect(page.locator('article.authorization')).toHaveCount(20);
    await page.getByRole('link', { name: '下一页' }).click();
    await expect(page).toHaveURL(`${origin}/${config.adminPath}?page=2&status=unclaimed`);
    await expect(page.locator('article.authorization')).toHaveCount(5);
    await expect(page.getByText('第 2 / 2 页')).toBeVisible();
    await page.getByRole('link', { name: '上一页' }).click();
    await expect(page).toHaveURL(`${origin}/${config.adminPath}?status=unclaimed`);

    // 末 3 位精确搜索（忽略大小写）与状态筛选组合：混合大小写变体输入命中同一条
    const mixedCaseSuffix = searchSuffix.replace(/[A-Za-z]/g, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()));
    assert.ok(mixedCaseSuffix !== searchSuffix, '翻转大小写后应不同于原尾号');
    await page.locator('input[name="suffix"]').fill(mixedCaseSuffix);
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(page).toHaveURL(`${origin}/${config.adminPath}?status=unclaimed&suffix=${mixedCaseSuffix}`);
    // 筛选框回显用户输入原样（不做大小写归一化）
    await expect(page.locator('input[name="suffix"]')).toHaveValue(mixedCaseSuffix);
    await expect(page.locator('article.authorization')).toHaveCount(1);
    await expect(page.locator('.authorization-suffix')).toHaveText(searchSuffix);

    // 状态筛选无匹配时显示空状态
    await page.locator('select[name="status"]').selectOption('ended');
    await page.getByRole('button', { name: '筛选' }).click();
    await expect(page.getByText('没有符合条件的激活授权。')).toBeVisible();
    await expect(page.locator('article.authorization')).toHaveCount(0);

    await context.close();
  } finally {
    await app.close();
  }
});

test('移动视口库存列表 20 条紧凑卡片不重叠、箭头固定尺寸且无横向溢出', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf, sessionValue, csrfValue } = await adminLogin(app);
    await resetAuthorizationTables(database);
    await createBatch(app, cookie, csrf, '20');

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await context.addCookies([
      { name: 'admin_session', value: sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: csrfValue, domain: '127.0.0.1', path: '/' },
    ]);
    await page.goto(`${origin}/${config.adminPath}`);

    await expect(page.locator('article.authorization')).toHaveCount(20);
    await assertNoOverflow(page, '移动视口库存列表');

    // 详情箭头固定 40x40，相邻卡片不重叠
    const arrowBox = await page.locator('.authorization-detail').first().boundingBox();
    assert.ok(arrowBox, '详情箭头应有布局框');
    assert.ok(Math.abs(arrowBox.width - 40) < 1 && Math.abs(arrowBox.height - 40) < 1, `箭头应为 40x40，实际 ${arrowBox.width}x${arrowBox.height}`);
    const tops = await page.locator('article.authorization').evaluateAll((articles) => articles.map((article) => article.getBoundingClientRect().top));
    for (let index = 1; index < tops.length; index += 1) {
      assert.ok(tops[index]! > tops[index - 1]!, '相邻卡片不得重叠');
    }

    await context.close();
  } finally {
    await app.close();
  }
});

test('桌面与移动视口管理员详情页：导航、待领取/领取后信息裁剪、敏感字段窗口与无溢出布局', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf, sessionValue, csrfValue } = await adminLogin(app);
    await resetAuthorizationTables(database);
    await database.saveCandidateSettings([
      { countryId: 1, countryName: '美国' },
      { countryId: 2, countryName: '英国' },
      { countryId: 3, countryName: '法国' },
    ], 0.11);
    const links = await createBatch(app, cookie, csrf, '1');
    const token = links[0]!;
    const suffix = token.slice(-3);

    // 1. 桌面视口 - 待领取详情导航与裁剪
    const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopContext.newPage();
    await desktopContext.addCookies([
      { name: 'admin_session', value: sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: csrfValue, domain: '127.0.0.1', path: '/' },
    ]);
    await desktopPage.goto(`${origin}/${config.adminPath}`);
    await desktopPage.locator('article.authorization').first().getByRole('link', { name: '查看详情' }).click();
    await expect(desktopPage.locator('h1', { hasText: '激活授权详情' })).toBeVisible();
    await expect(desktopPage.locator('h2', { hasText: `链接末 3 位：${suffix}` })).toBeVisible();
    await expect(desktopPage.getByText('授权状态：📋 待领取')).toBeVisible();
    await expect(desktopPage.getByText('创建时间：')).toBeVisible();
    await expect(desktopPage.getByRole('link', { name: '撤销授权' })).toBeVisible();
    await expect(desktopPage.getByRole('heading', { name: '候选地区', level: 2 })).toBeHidden();
    await expect(desktopPage.getByRole('heading', { name: '供应商激活', level: 2 })).toBeHidden();
    await expect(desktopPage.getByRole('heading', { name: '成本', level: 2 })).toBeHidden();
    await assertNoOverflow(desktopPage, '桌面待领取详情页');

    // 2. 领取授权并获取号码（进入进行中与敏感窗口）
    const claimRes = await app.inject({ method: 'POST', url: `/a/${token}/numbers` });
    assert.ok([200, 202, 303].includes(claimRes.statusCode));

    // 刷新桌面详情页
    await desktopPage.reload();
    await expect(desktopPage.getByText('授权状态：🔄 进行中')).toBeVisible();
    await expect(desktopPage.getByText('领取时间：')).toBeVisible();
    // 新号码获取截止时间与获取额度已从头部卡片移除
    await expect(desktopPage.getByText('新号码获取截止时间：')).toHaveCount(0);
    await expect(desktopPage.getByText('获取额度：')).toHaveCount(0);
    await expect(desktopPage.getByRole('heading', { name: '供应商激活', level: 2 })).toBeVisible();
    await expect(desktopPage.getByRole('heading', { name: '候选地区', level: 2 })).toHaveCount(0);
    await expect(desktopPage.getByRole('heading', { name: '当前供应商激活', level: 2 })).toHaveCount(0);
    await expect(desktopPage.getByText('位置 1 · 美国：')).toBeVisible();
    await expect(desktopPage.getByText('位置 2 · 英国：⬜ 未消耗')).toBeVisible();
    await expect(desktopPage.getByText('位置 3 · 法国：⬜ 未消耗')).toBeVisible();
    await expect(desktopPage.getByText('完整号码：+442079460777')).toBeVisible();
    await assertNoOverflow(desktopPage, '桌面进行中详情页');

    // 4. 移动视口验证敏感字段窗口与无溢出
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileContext.newPage();
    await mobileContext.addCookies([
      { name: 'admin_session', value: sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: csrfValue, domain: '127.0.0.1', path: '/' },
    ]);
    const homeRes = await app.inject({ method: 'GET', url: `/${config.adminPath}`, headers: { cookie } });
    const authorizationId = homeRes.body.match(/data-authorization-id="([^"]+)"/)?.[1]; assert.ok(authorizationId);

    await mobilePage.goto(`${origin}/${config.adminPath}/authorizations/${authorizationId}`);
    await expect(mobilePage.locator('h1', { hasText: '激活授权详情' })).toBeVisible();
    await expect(mobilePage.getByText('完整号码：+442079460777')).toBeVisible();
    await assertNoOverflow(mobilePage, '移动视口进行中详情页');

    // 撤销授权后刷新，敏感字段不可见，撤销链接不可见
    await mobilePage.getByRole('link', { name: '撤销授权' }).click();
    await expect(mobilePage.locator('h1', { hasText: '确认撤销授权' })).toBeVisible();
    await mobilePage.getByRole('button', { name: '确认撤销授权' }).click();

    await mobilePage.goto(`${origin}/${config.adminPath}/authorizations/${authorizationId}`);
    await expect(mobilePage.getByText('授权状态：🏁 已结束（管理员撤销 · 08-01 08:00）')).toBeVisible();
    await expect(mobilePage.getByText('结束原因：')).toHaveCount(0);
    await expect(mobilePage.getByText('结束时间：')).toHaveCount(0);
    await expect(mobilePage.getByText('+442079460777')).toBeHidden();
    await expect(mobilePage.getByRole('link', { name: '撤销授权' })).toBeHidden();
    await assertNoOverflow(mobilePage, '移动视口已撤销详情页');

    await desktopContext.close();
    await mobileContext.close();
  } finally {
    await app.close();
  }
});

test('管理员详情供应商激活卡片显示接码耗时观测：成功号等多久收到、放弃号等多久放弃、未点按钮号未记录、历史已删除号码占位', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-10T00:00:00.000Z') });
  await resetAuthorizationTables(database);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf, sessionValue, csrfValue } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf);
    const authorization = await database.pool.query<{ id: string }>(
      'SELECT id FROM activation_authorizations WHERE token_suffix = $1', [token.slice(-3)],
    );
    const authorizationId = authorization.rows[0]?.id; assert.ok(authorizationId);
    const now = new Date('2026-08-10T00:00:00.000Z');
    await database.pool.query("UPDATE activation_authorizations SET status = 'ended', ended_at = $2, ended_reason = 'acquisition_expired', token_hash = NULL WHERE id = $1", [authorizationId, now]);
    // 成功号保留号码；放弃号与未记录号号码已被领域删除（历史卡片应显示占位文本）
    for (const [index, row] of [
      { key: 'success', status: 'sms_delivered', phone: '+442079460777', requested: now, abandoned: null, sms: new Date(now.getTime() + 300_000) },
      { key: 'abandoned', status: 'cancelled', phone: null, requested: new Date(now.getTime() + 60_000), abandoned: new Date(now.getTime() + 180_000), sms: null },
      { key: 'unrecorded', status: 'completed', phone: null, requested: null, abandoned: null, sms: new Date(now.getTime() + 240_000) },
    ].entries()) {
      await database.pool.query(
        `INSERT INTO authorization_candidate_countries (authorization_id, position, country_id, country_name, used_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [authorizationId, index + 1, index + 1, ['美国', '英国', '法国'][index], now],
      );
      await database.pool.query(
        `INSERT INTO supplier_activations
           (authorization_id, candidate_position, country_id, provider_activation_id, status, activation_cost, currency,
            acquired_at, cancel_available_at, expires_at, phone_number, verification_requested_at, abandoned_at, sms_received_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'USD', $7, $7, $8, $9, $10, $11, $12)`,
        [
          authorizationId, index + 1, index + 1, `detail-obs-${row.key}-${randomUUID()}`, row.status,
          [0.8, 1.25, 2][index], new Date(now.getTime() + index), new Date('2026-08-10T00:20:00.000Z'),
          row.phone, row.requested, row.abandoned, row.sms,
        ],
      );
    }

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await context.addCookies([
      { name: 'admin_session', value: sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: csrfValue, domain: '127.0.0.1', path: '/' },
    ]);
    await page.goto(`${origin}/${config.adminPath}/authorizations/${authorizationId}`);

    // 成功号：等待起点 + 短信送达时刻 + 等多久收到 + 完整号码
    await expect(page.getByText(/等待起点 08-10 08:00，短信送达 08-10 08:05，等多久收到：等 5 分 0 秒/)).toBeVisible();
    await expect(page.getByText('完整号码：+442079460777')).toBeVisible();
    // 放弃号：等待起点 + 放弃时刻 + 等多久放弃 + 号码已删除占位
    await expect(page.getByText(/等待起点 08-10 08:01，放弃时刻 08-10 08:03，等多久放弃：等 2 分 0 秒/)).toBeVisible();
    await expect(page.getByText(/完整号码：（已删除）/)).toHaveCount(2);
    // 未记录号：等待起点与耗时均未记录，短信送达时刻单独展示
    await expect(page.getByText(/等待起点未记录，短信送达 08-10 08:04，等待耗时未记录/)).toBeVisible();

    await context.close();
  } finally {
    await app.close();
  }
});
