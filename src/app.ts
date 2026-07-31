import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { AdminAuthentication, ADMIN_SESSION_MAX_AGE_SECONDS, LoginRateLimitedError } from './admin-auth.js';
import { CandidateLocationValidationError, DefaultCandidateLocations, type CandidateLocationSettings } from './default-candidate-locations.js';
import { type AppConfig, randomToken } from './config.js';
import { Database } from './database.js';
import { HeroSmsHttpAdapter, type HeroSms } from './herosms.js';

const ADMIN_COOKIE = 'admin_session';
const CSRF_COOKIE = 'admin_csrf';
const HEROSMS_COMPATIBILITY_URL = 'https://hero-sms.com/stubs/handler_api.php';

interface LoginBody {
  csrf?: string;
  password?: string;
}

interface CsrfBody {
  csrf?: string;
}

interface SettingsBody extends CsrfBody {
  candidate1?: string;
  candidate2?: string;
  candidate3?: string;
}

function htmlPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; color: #17202a; background: #f5f7f8; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(calc(100% - 32px), 480px); }
    .panel { background: #fff; border: 1px solid #d7dde1; border-radius: 6px; padding: 28px; box-shadow: 0 2px 8px #17202a12; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 650; }
    p { margin: 0 0 24px; color: #53616c; line-height: 1.55; }
    label { display: grid; gap: 8px; font-size: 14px; font-weight: 600; }
    input, select { box-sizing: border-box; width: 100%; height: 40px; border: 1px solid #9daab2; border-radius: 4px; padding: 8px 10px; font: inherit; }
    select { background: #fff; }
    button { margin-top: 20px; min-height: 40px; border: 0; border-radius: 4px; padding: 8px 16px; background: #117a65; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .error { margin: 0 0 16px; color: #a12424; font-size: 14px; }
    .shell { width: min(calc(100% - 48px), 1000px); }
    .shell header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #d7dde1; padding-bottom: 16px; }
    .shell h1 { margin: 0; }
    .shell header { gap: 16px; }
    nav a { color: #0f6655; font-size: 14px; font-weight: 600; text-decoration: none; }
    .shell form button { margin: 0; background: #52616b; }
    .settings { max-width: 560px; padding: 32px 0; }
    .settings form { display: grid; gap: 16px; }
    .settings form button { justify-self: start; background: #117a65; }
    .empty { padding: 32px 0; color: #53616c; }
  </style>
</head>
<body>${content}</body>
</html>`;
}

function loginPage(path: string, csrfToken: string, error?: string): string {
  const errorMarkup = error ? `<p class="error" role="alert">${error}</p>` : '';
  return htmlPage('管理员登录', `<main><section class="panel"><h1>管理员登录</h1><p>请输入部署时配置的管理密码。</p>${errorMarkup}<form method="post" action="/${path}/login"><input type="hidden" name="csrf" value="${csrfToken}"><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">登录</button></form></section></main>`);
}

function adminPage(title: string, heading: string, path: string, csrfToken: string, navigationPath: string, navigationLabel: string, content: string): string {
  return htmlPage(title, `<main class="shell"><header><h1>${heading}</h1><nav><a href="${navigationPath}">${navigationLabel}</a></nav><form method="post" action="/${path}/logout"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">退出登录</button></form></header>${content}</main>`);
}

function adminShell(path: string, csrfToken: string): string {
  return adminPage('管理后台', '管理后台', path, csrfToken, `/${path}/settings`, '设置', '<p class="empty">激活授权管理将在这里提供。</p>');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function settingsPage(path: string, csrfToken: string, settings: CandidateLocationSettings, error?: string): string {
  const optionMarkup = (selectedId: number | undefined) => settings.locations.map((location) => {
    const selected = location.id === selectedId ? ' selected' : '';
    const quote = location.price === undefined || location.stock === undefined ? '暂无报价' : `价格 ${location.price.toString()}，库存 ${location.stock}`;
    return `<option value="${location.id}"${selected}>${escapeHtml(location.name)}，${quote}</option>`;
  }).join('');
  const selects = [0, 1, 2].map((position) => `<label>候选地区 ${position + 1}<select name="candidate${position + 1}" required><option value="" disabled${settings.configuredCountryIds[position] === undefined ? ' selected' : ''}>请选择地区</option>${optionMarkup(settings.configuredCountryIds[position])}</select></label>`).join('');
  const errorMarkup = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  return adminPage('默认候选地区', '设置', path, csrfToken, `/${path}`, '返回首页', `<section class="settings"><p><strong>HeroSMS 已连接</strong></p><p>余额：${settings.balance.toFixed(2)}</p>${errorMarkup}<form method="post" action="/${path}/settings"><input type="hidden" name="csrf" value="${csrfToken}">${selects}<button type="submit">保存默认候选地区</button></form></section>`);
}

function settingsUnavailablePage(path: string, csrfToken: string): string {
  return adminPage('默认候选地区', '设置', path, csrfToken, `/${path}`, '返回首页', '<section class="settings"><p class="error" role="alert">暂时无法读取 HeroSMS 设置。</p></section>');
}

function csrfFrom(request: FastifyRequest): string | undefined {
  const body = request.body as CsrfBody | undefined;
  return body?.csrf;
}

function candidateCountryIds(body: SettingsBody): number[] | undefined {
  const values = [body.candidate1, body.candidate2, body.candidate3];
  if (values.some((value) => !value || !/^\d+$/.test(value))) {
    return undefined;
  }
  const countryIds = values.map((value) => Number(value));
  return countryIds.every(Number.isSafeInteger) ? countryIds : undefined;
}

function loginFailure(reply: FastifyReply, adminPath: string, statusCode: number, message: string): FastifyReply {
  const csrfToken = randomToken();
  setLoginCsrf(reply, csrfToken);
  return reply.code(statusCode).type('text/html; charset=utf-8').send(loginPage(adminPath, csrfToken, message));
}

function isSameOrigin(request: FastifyRequest, config: AppConfig): boolean {
  return request.headers.origin === config.publicOrigin
    || (request.headers.origin === 'null' && request.headers['sec-fetch-site'] === 'same-origin');
}

function setLoginCsrf(reply: FastifyReply, csrfToken: string): void {
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    maxAge: 600,
    path: '/',
    sameSite: 'strict',
    secure: true,
  });
}

function cookiesForSession(reply: FastifyReply, sessionId: string, csrfToken: string): void {
  reply.setCookie(ADMIN_COOKIE, sessionId, {
    httpOnly: true,
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'strict',
    secure: true,
  });
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'strict',
    secure: true,
  });
}

export interface AppDependencies {
  heroSms?: HeroSms;
}

export async function createApp(config: AppConfig, database = new Database(config.databaseUrl), dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  await database.initialize();
  const authentication = new AdminAuthentication(config, database);
  const heroSms = dependencies.heroSms ?? new HeroSmsHttpAdapter({
    apiKey: config.heroSmsApiKey,
    baseUrl: HEROSMS_COMPATIBILITY_URL,
  });
  const defaultCandidateLocations = new DefaultCandidateLocations(database, heroSms, config.openAiServiceCode);
  const app = Fastify({ logger: false, trustProxy: config.trustedProxy });
  await app.register(cookie);
  await app.register(formbody);

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/health', async () => ({ status: 'ok' }));

  const adminRoot = `/${config.adminPath}`;
  app.get(adminRoot, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (session) {
      cookiesForSession(reply, session.id, session.csrfToken);
      return reply.type('text/html; charset=utf-8').send(adminShell(config.adminPath, session.csrfToken));
    }

    const csrfToken = randomToken();
    setLoginCsrf(reply, csrfToken);
    return reply.type('text/html; charset=utf-8').send(loginPage(config.adminPath, csrfToken));
  });

  app.post<{ Body: LoginBody }>(`${adminRoot}/login`, async (request, reply) => {
    const csrfToken = csrfFrom(request);
    if (!isSameOrigin(request, config) || !csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return loginFailure(reply, config.adminPath, 403, '请求已被拒绝。');
    }

    try {
      const session = await authentication.createSession(request.body.password ?? '', request.ip);
      if (!session) {
        return loginFailure(reply, config.adminPath, 401, '密码或请求无效。');
      }
      cookiesForSession(reply, session.id, session.csrfToken);
      return reply.redirect(adminRoot, 303);
    } catch (error) {
      if (error instanceof LoginRateLimitedError) {
        return loginFailure(reply, config.adminPath, 429, '密码或请求无效。');
      }
      throw error;
    }
  });

  app.get(`${adminRoot}/settings`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (!session) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    }
    cookiesForSession(reply, session.id, session.csrfToken);
    try {
      const settings = await defaultCandidateLocations.settings();
      return reply.type('text/html; charset=utf-8').send(settingsPage(config.adminPath, session.csrfToken, settings));
    } catch {
      return reply.code(503).type('text/html; charset=utf-8').send(settingsUnavailablePage(config.adminPath, session.csrfToken));
    }
  });

  app.post<{ Body: SettingsBody }>(`${adminRoot}/settings`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }

    const countryIds = candidateCountryIds(request.body);
    try {
      if (!countryIds) {
        throw new CandidateLocationValidationError();
      }
      await defaultCandidateLocations.replace(countryIds);
      return reply.redirect(`${adminRoot}/settings`, 303);
    } catch (error) {
      if (error instanceof CandidateLocationValidationError) {
        try {
          const settings = await defaultCandidateLocations.settings();
          return reply.code(422).type('text/html; charset=utf-8').send(settingsPage(config.adminPath, session.csrfToken, settings, error.message));
        } catch {
          return reply.code(503).type('text/html; charset=utf-8').send(settingsUnavailablePage(config.adminPath, session.csrfToken));
        }
      }
      return reply.code(503).type('text/html; charset=utf-8').send(settingsUnavailablePage(config.adminPath, session.csrfToken));
    }
  });

  app.post<{ Body: CsrfBody }>(`${adminRoot}/logout`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }

    await authentication.revokeSession(session.id);
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.redirect(adminRoot, 303);
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).type('text/plain; charset=utf-8').send('Not Found'));
  app.addHook('onClose', async () => database.close());
  return app;
}
