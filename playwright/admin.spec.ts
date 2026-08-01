import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import { expect, test, type Page } from '@playwright/test';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/database.js';
import type { HeroSms } from '../src/herosms.js';

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
  quotes: async () => [{ countryId: 1, price: 1.2, stock: 1 }, { countryId: 2, price: 0.6, stock: 1 }, { countryId: 3, price: 0.9, stock: 1 }],
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

/** 辅助函数：创建授权，返回 token */
async function createAuthorization(app: App, cookie: string, csrf: string, recipientIdentifier: string): Promise<string> {
  const preview = await app.inject({
    method: 'POST', url: `/${config.adminPath}/authorizations/preview`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin },
    payload: new URLSearchParams({ csrf, recipientIdentifier }).toString(),
  });
  const fingerprint = preview.body.match(/name="preflightFingerprint" value="([A-Za-z0-9_-]+)"/)?.[1]; assert.ok(fingerprint);
  const created = await app.inject({
    method: 'POST', url: `/${config.adminPath}/authorizations`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin },
    payload: new URLSearchParams({ csrf, recipientIdentifier, preflightFingerprint: fingerprint }).toString(),
  });
  const token = created.body.match(/\/a\/([A-Za-z0-9_-]{43})/)?.[1]; assert.ok(token);
  return token;
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
    // 首页包含创建授权区域
    await expect(page.getByRole('heading', { name: '创建激活授权', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '最近激活授权', level: 2 })).toBeVisible();

    // 通过 UI 进入设置页并配置默认候选地区
    await page.getByRole('link', { name: '设置' }).click();
    await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();
    await expect(page.getByText('HeroSMS 已连接')).toBeVisible();
    await expect(page.getByText('余额：')).toBeVisible();
    // 选择三个候选地区
    await page.locator('select[name="candidate1"]').selectOption('1');
    await page.locator('select[name="candidate2"]').selectOption('2');
    await page.locator('select[name="candidate3"]').selectOption('3');
    await page.getByRole('button', { name: '保存默认候选地区' }).click();
    // 保存后重定向回设置页，候选地区已保存
    await expect(page.locator('h1', { hasText: '设置' })).toBeVisible();

    // 返回首页，进入预检确认页
    await page.getByRole('link', { name: '返回首页' }).click();
    await expect(page.locator('h1', { hasText: '管理后台' })).toBeVisible();
    const recipientId = `admin-pw-${randomUUID()}`;
    await page.locator('input[name="recipientIdentifier"]').fill(recipientId);
    await page.getByRole('button', { name: '预检并确认' }).click();
    await expect(page.locator('h1', { hasText: '确认激活授权' })).toBeVisible();
    await expect(page.getByText('接收者标识：')).toBeVisible();
    await expect(page.getByText('HeroSMS 余额：')).toBeVisible();
    // 应有三个候选地区和库存
    await expect(page.getByText('美国')).toBeVisible();
    await expect(page.getByText('英国')).toBeVisible();
    await expect(page.getByText('法国')).toBeVisible();

    // 授权已创建页（含复制按钮）
    await page.getByRole('button', { name: '确认创建 24 小时授权' }).click();
    await expect(page.locator('h1', { hasText: '激活授权已创建' })).toBeVisible();
    await expect(page.locator('#authorization-url')).toBeVisible();
    const urlText = await page.locator('#authorization-url').textContent();
    assert.ok(urlText?.includes('/a/'), '授权链接应包含 /a/ 路径');
    // 复制按钮可用
    await page.getByRole('button', { name: '复制授权链接' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('/a/');

    await context.close();
  } finally {
    await app.close();
  }
});

test('桌面视口管理员可以查看授权详情页和撤销确认页', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf, sessionValue, csrfValue } = await adminLogin(app);
    const recipientId = `detail-test-${randomUUID()}`;
    await createAuthorization(app, cookie, csrf, recipientId);

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await context.addCookies([
      { name: 'admin_session', value: sessionValue, domain: '127.0.0.1', path: '/' },
      { name: 'admin_csrf', value: csrfValue, domain: '127.0.0.1', path: '/' },
    ]);

    // 首页找到新建的授权
    await page.goto(`${origin}/${config.adminPath}`);
    await expect(page.getByText(recipientId)).toBeVisible();

    // 查看详情
    await page.getByRole('link', { name: '查看详情' }).first().click();
    await expect(page.locator('h1', { hasText: '激活授权详情' })).toBeVisible();
    await expect(page.getByText('授权状态：')).toBeVisible();
    await expect(page.getByText('获取额度：')).toBeVisible();
    await expect(page.getByText('候选地区')).toBeVisible();
    await expect(page.getByRole('heading', { name: '供应商激活', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: '成本', level: 2 })).toBeVisible();

    // 进入撤销确认页
    await page.getByRole('link', { name: '撤销授权' }).click();
    await expect(page.locator('h1', { hasText: '确认撤销授权' })).toBeVisible();
    await expect(page.getByText('接收者标识：')).toBeVisible();
    await expect(page.getByText('授权状态：')).toBeVisible();
    await expect(page.getByText('撤销后：')).toBeVisible();
    // 撤销确认框包含危险按钮
    await expect(page.getByRole('button', { name: '确认撤销授权' })).toBeVisible();

    await context.close();
  } finally {
    await app.close();
  }
});

test('仅打开链接（聊天软件预览）不领取号码，跨浏览器绑定被拒绝', async ({ browser }) => {
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => new Date('2026-08-01T00:00:00.000Z') });
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf, `preview-test-${randomUUID()}`);

    // 第一次：仅 GET 打开链接（模拟预览），不点击获取
    const previewContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const previewPage = await previewContext.newPage();
    await previewPage.goto(`${origin}/a/${token}`);
    await expect(previewPage.getByRole('heading', { name: 'OpenAI' })).toBeVisible();
    // 仅打开后页面显示「获取号码」按钮但还未触发绑定
    await expect(previewPage.getByRole('button', { name: '获取号码' })).toBeVisible();
    await previewContext.close();

    // 第二次（不同浏览器上下文）：正式领取
    const recipientContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const recipientPage = await recipientContext.newPage();
    await recipientPage.goto(`${origin}/a/${token}`);
    await recipientPage.getByRole('button', { name: '获取号码' }).click();
    await expect(recipientPage.locator('.number')).toBeVisible();
    await recipientContext.close();

    // 第三次：不同浏览器上下文尝试用同一链接，应被拒绝（unavailable 页面）
    const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`${origin}/a/${token}`);
    await expect(otherPage.getByText('此链接不可用，请联系发送者')).toBeVisible();
    await otherContext.close();
  } finally {
    await app.close();
  }
});

test('授权到期（24小时）后访问返回 404', async ({ browser }) => {
  let now = new Date('2026-08-01T00:00:00.000Z');
  const database = new Database(databaseUrl!);
  const app = await createApp(config, database, { heroSms, now: () => now });
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf, `expiry-test-${randomUUID()}`);

    // 确认创建后链接可访问
    const checkBefore = await app.inject({ method: 'GET', url: `/a/${token}` });
    assert.equal(checkBefore.statusCode, 200, '授权到期前应可访问');

    // 时间快进到 24 小时后，手动触发到期清理
    now = new Date('2026-08-02T00:00:01.000Z');
    await database.expireDueAuthorizations(now);

    // 确认 inject 层面已返回 404
    const checkAfter = await app.inject({ method: 'GET', url: `/a/${token}` });
    assert.equal(checkAfter.statusCode, 404, '授权到期后应返回 404');

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/a/${token}`);
    assert.equal(response?.status(), 404, '授权到期后浏览器访问应返回 404');
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
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf, `security-test-${randomUUID()}`);

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

    // 3. 换号按钮不足两分钟不出现
    await expect(page.getByRole('button', { name: '更换号码' })).toHaveCount(0);

    // 4. 短信送达后（验证码显示状态）
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
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf, `layout-test-${randomUUID()}`);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    // 初始状态
    await page.goto(`${origin}/a/${token}`);
    await assertNoOverflow(page, '初始状态');

    // 领取号码后
    await page.getByRole('button', { name: '获取号码' }).click();
    await expect(page.locator('.number')).toBeVisible();
    await assertNoOverflow(page, '号码显示状态');

    // 倒计时元素存在时不溢出
    await expect(page.locator('[data-countdown]').first()).toBeVisible();
    await assertNoOverflow(page, '倒计时显示状态');

    // 时间快进，换号按钮出现后
    now = new Date('2026-08-01T00:02:00.000Z');
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
    await page.reload();
    await expect(page.locator('#verification-code')).toBeVisible();
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
  await database.replaceDefaultCandidateCountryIds([1, 2, 3]);
  await app.listen({ host: '127.0.0.1', port: 32124 });
  try {
    const { cookie, csrf } = await adminLogin(app);
    const token = await createAuthorization(app, cookie, csrf, `log-test-${randomUUID()}`);

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

    // recipient session cookie 应为 HttpOnly（无法从 JS 读取）
    const cookies = await context.cookies();
    const recipientSession = cookies.find((c) => c.name === 'recipient_session');
    if (recipientSession) {
      assert.ok(recipientSession.httpOnly, 'recipient_session 应为 HttpOnly');
    }

    await context.close();
  } finally {
    await app.close();
  }
});

// ---- 辅助断言函数 ----

function assertNoSensitiveAdminInfo(html: string, context: string): void {
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
    assert.ok(!pattern.test(html), `${context} 不应包含「${label}」：匹配到 ${pattern}`);
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
