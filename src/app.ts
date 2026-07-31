import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { AdminAuthentication, ADMIN_SESSION_MAX_AGE_SECONDS, LoginRateLimitedError } from './admin-auth.js';
import { type AppConfig, randomToken } from './config.js';
import { Database } from './database.js';

const ADMIN_COOKIE = 'admin_session';
const CSRF_COOKIE = 'admin_csrf';

interface LoginBody {
  csrf?: string;
  password?: string;
}

interface CsrfBody {
  csrf?: string;
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
    main { width: min(100% - 32px, 480px); }
    .panel { background: #fff; border: 1px solid #d7dde1; border-radius: 6px; padding: 28px; box-shadow: 0 2px 8px #17202a12; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 650; }
    p { margin: 0 0 24px; color: #53616c; line-height: 1.55; }
    label { display: grid; gap: 8px; font-size: 14px; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; height: 40px; border: 1px solid #9daab2; border-radius: 4px; padding: 8px 10px; font: inherit; }
    button { margin-top: 20px; min-height: 40px; border: 0; border-radius: 4px; padding: 8px 16px; background: #117a65; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .error { margin: 0 0 16px; color: #a12424; font-size: 14px; }
    .shell { width: min(100% - 48px, 1000px); }
    .shell header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #d7dde1; padding-bottom: 16px; }
    .shell h1 { margin: 0; }
    .shell form button { margin: 0; background: #52616b; }
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

function adminShell(path: string, csrfToken: string): string {
  return htmlPage('管理后台', `<main class="shell"><header><h1>管理后台</h1><form method="post" action="/${path}/logout"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">退出登录</button></form></header><p class="empty">激活授权管理将在这里提供。</p></main>`);
}

function csrfFrom(request: FastifyRequest): string | undefined {
  const body = request.body as CsrfBody | undefined;
  return body?.csrf;
}

function loginFailure(reply: FastifyReply, adminPath: string, statusCode: number, message: string): FastifyReply {
  const csrfToken = randomToken();
  setLoginCsrf(reply, csrfToken);
  return reply.code(statusCode).type('text/html; charset=utf-8').send(loginPage(adminPath, csrfToken, message));
}

function isSameOrigin(request: FastifyRequest, config: AppConfig): boolean {
  return request.headers.origin === config.publicOrigin;
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

export async function createApp(config: AppConfig, database = new Database(config.databaseUrl)): Promise<FastifyInstance> {
  await database.initialize();
  const authentication = new AdminAuthentication(config, database);
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
