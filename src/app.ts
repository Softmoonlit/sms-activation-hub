import { createHmac, timingSafeEqual } from 'node:crypto';

import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { AdminAuthentication, ADMIN_SESSION_MAX_AGE_SECONDS, LoginRateLimitedError } from './admin-auth.js';
import { ActivationAuthorizations, AuthorizationValidationError, type AcquisitionReconciliation, type AuthorizationDetail, type AuthorizationTokenGeneratorInput, type BatchAuthorizationPreflight, type RecipientAuthorizationView } from './activation-authorizations.js';
import { type AuthorizationListPage, type AuthorizationListQuery, type AuthorizationListTopLevelStatus } from './database.js';
import { CandidateLocationValidationError, DefaultCandidateLocations, type CandidateLocationSettings } from './default-candidate-locations.js';
import { countryCallingCode } from './country-calling-code.js';
import { countryFlagHtml, formatCurrency, formatDateTime } from './country-flag.js';
import { type AppConfig, randomToken } from './config.js';
import { Database } from './database.js';
import { HeroSmsHttpAdapter, parseSupplierDate, type HeroSms } from './herosms.js';

const ADMIN_COOKIE = 'admin_session';
const CSRF_COOKIE = 'admin_csrf';
const RECIPIENT_COOKIE = 'recipient_session';
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

interface HeroSmsWebhookBody {
  activationId?: unknown;
  service?: unknown;
  text?: unknown;
  code?: unknown;
  country?: unknown;
  receivedAt?: unknown;
}

interface AuthorizationBody extends CsrfBody {
  quantity?: string;
  internalNote?: string;
  preflightFingerprint?: string;
}

interface ReplacementBody {
  replacement?: string;
}

const activationStatusLabels: Record<string, string> = {
  acquisition_confirming: '获取结果确认中', waiting_sms: '等待短信', cancellation_confirming: '取消确认中',
  cancelled: '已取消', manual_reconciliation: '结果待人工对账', sms_delivered: '短信已送达',
  completion_confirming: '完成确认中', completed: '已完成', timed_out: '已超时',
};

const authorizationEndReasonLabels: Record<string, string> = {
  admin_revoked: '管理员撤销',
  result_view_expired: '结果查看期结束',
  quota_exhausted: '获取额度用尽',
  acquisition_expired: '领取后期限结束',
};

// 授权状态 emoji 映射：管理列表页与详情页共用，已结束状态行把结束原因与结束时间并入同一行。
const authorizationStatusEmojis: Record<string, string> = {
  待领取: '📋', 进行中: '🔄', 结果可查看: '✅', 已结束: '🏁',
};

// 授权状态展示文本（emoji + 状态）：管理列表页与详情页共用同一格式。
function authorizationStatusLabel(status: string): string {
  return `${authorizationStatusEmojis[status] ?? ''} ${status}`;
}

function authorizationStatusMarkup(status: string, endedReason?: string, endedAt?: Date): string {
  if (status !== '已结束') return `<p>授权状态：${escapeHtml(authorizationStatusLabel(status))}</p>`;
  const reason = endedReason ? authorizationEndReasonLabels[endedReason] ?? endedReason : undefined;
  const summary = [reason, endedAt ? formatDateTime(endedAt) : undefined].filter((part): part is string => part !== undefined).join(' · ');
  return `<p>授权状态：${authorizationStatusLabel('已结束')}${summary ? `（${escapeHtml(summary)}）` : ''}</p>`;
}

// 激活状态 emoji 映射：供应商激活卡片内所有状态行共用；已取消使用返回类 emoji，避免正常取消被误读为异常。
const activationStatusEmojis: Record<string, string> = {
  获取结果确认中: '⏳', 等待短信: '📩', 取消确认中: '⏳', 已取消: '↩️', 结果待人工对账: '⚠️',
  短信已送达: '📨', 完成确认中: '⏳', 已完成: '✅', 已超时: '⏰',
};

function activationStatusLabel(status: string): string {
  const label = activationStatusLabels[status] ?? status;
  return `${activationStatusEmojis[label] ?? ''} ${label}`;
}

const RECIPIENT_NO_NUMBERS_MESSAGE = '当前暂无可用号码，请稍后重试';
const RECIPIENT_ACQUISITION_ERROR_MESSAGE = '暂时无法获取号码，请联系发送者';

function htmlPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; background: #f5f7f8; color: #17202a; font-family: system-ui, -apple-system, sans-serif; box-sizing: border-box; padding: 24px 0 60px; }
    body:has(.panel) { display: grid; place-items: center; padding: 0; }
    main { width: min(calc(100% - 32px), 480px); }
    .panel { background: #fff; border: 1px solid #d7dde1; border-radius: 6px; padding: 28px; box-shadow: 0 2px 8px #17202a12; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 650; }
    p { margin: 0 0 24px; color: #53616c; line-height: 1.55; }
    label { display: grid; gap: 8px; font-size: 14px; font-weight: 600; }
    input, select, textarea { box-sizing: border-box; width: 100%; min-height: 40px; border: 1px solid #9daab2; border-radius: 4px; padding: 8px 10px; font: inherit; }
    textarea { min-height: 88px; resize: vertical; }
    select { background: #fff; }
    .cb { position: relative; }
    .cb-input { box-sizing: border-box; width: 100%; min-height: 40px; border: 1px solid #9daab2; border-radius: 4px; padding: 8px 36px 8px 10px; font: inherit; background: #fff; cursor: text; transition: border-color 0.15s, box-shadow 0.15s; }
    .cb-input:focus { outline: none; border-color: #117a65; box-shadow: 0 0 0 3px #117a6520; }
    .cb .cb-clear { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); border: none; background: none; padding: 2px; margin: 0; min-height: 0; border-radius: 0; font-size: 16px; font-weight: 400; line-height: 1; color: #b0bec5; cursor: pointer; display: none; align-items: center; justify-content: center; transition: color 0.15s; }
    .cb .cb-clear:hover { background: none; color: #546e7a; }
    .cb-input.cb-selected ~ .cb-clear { display: flex; }
    .cb-list { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 200; background: #fff; border: 1px solid #9daab2; border-radius: 4px; box-shadow: 0 4px 12px #17202a18; max-height: 220px; overflow-y: auto; display: none; list-style: none; margin: 0; padding: 0; }
    .cb-list.cb-open { display: block; }
    .cb-opt { padding: 9px 12px; font-size: 14px; cursor: pointer; border-bottom: 1px solid #f0f2f3; }
    .cb-opt:last-child { border-bottom: none; }
    .cb-opt:hover, .cb-opt.cb-active { background: #edf3f1; }
    .cb-hl { color: #0f6655; font-weight: 700; }
    .cb-empty { padding: 12px; color: #9daab2; font-size: 13px; text-align: center; }
    button { margin-top: 20px; min-height: 40px; border: 0; border-radius: 4px; padding: 8px 16px; background: #117a65; color: #fff; font: inherit; font-weight: 600; cursor: pointer; transition: background 0.2s ease; }
    button.copied { background: #27ae60 !important; }
    .error { margin: 0 0 16px; color: #a12424; font-size: 14px; }
    .shell { width: min(calc(100% - 48px), 1000px); }
    .shell header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; border-bottom: 1px solid #d7dde1; padding-bottom: 16px; gap: 16px; }
    .shell header nav { justify-self: start; }
    .shell header h1 { justify-self: center; margin: 0; font-size: 22px; font-weight: 650; display: flex; align-items: center; gap: 0.35em; text-align: center; }
    .shell header form { justify-self: end; }
    .icon { width: 1em; height: 1em; flex-shrink: 0; stroke: currentColor; }
    nav a { color: #0f6655; box-sizing: border-box; font-size: 1rem; font-family: inherit; font-weight: 600; text-decoration: none; height: 40px; padding: 0 16px; border-radius: 4px; background: #edf3f1; transition: background 0.2s ease; display: inline-flex; align-items: center; gap: 0.35em; }
    nav a:hover { background: #dcebe6; }
    .shell form button { margin: 0; background: #52616b; }
    .settings { max-width: 560px; padding: 32px 0; }
    .settings form { display: grid; gap: 16px; }
    .settings form button { justify-self: start; background: #117a65; }
    .empty { padding: 32px 0; color: #53616c; }
    .dashboard { display: grid; gap: 28px; padding: 28px 0; }
    .card { background: #fff; border: 1px solid #d7dde1; border-radius: 6px; padding: 22px; }
    .card form { display: grid; gap: 16px; }
    .card form button { justify-self: start; }
    .summary { display: grid; gap: 10px; padding: 0; list-style: none; }
    .activation-current { background: #edf3f1; border: 1px solid #d7e3de; border-radius: 6px; padding: 10px 12px; }
    .authorization { border-top: 1px solid #e3e7e9; padding: 16px 0; }
    .authorization:first-child { border-top: 0; }
    .authorization p { margin: 4px 0; }
    .inventory-filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; gap: 12px; margin: 16px 0; }
    .inventory-filters label { gap: 6px; }
    .inventory-filters button { min-height: 40px; margin: 0; }
    .card form.batch-create-form { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: end; gap: 12px; }
    .card form.batch-create-form button { margin: 0; min-height: 40px; }
    .card form.batch-create-form label { gap: 6px; }
    .authorization-list { display: grid; gap: 0; }
    .authorization-list .authorization { box-sizing: border-box; min-height: 56px; display: grid; grid-template-columns: minmax(0, 1fr) auto 40px; align-items: center; gap: 16px; padding: 8px 0; }
    .authorization-suffix { min-width: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
    .authorization-status { white-space: nowrap; color: #53616c; font-size: 14px; }
    .authorization-detail { box-sizing: border-box; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; color: #0f6655; background: #edf3f1; font-size: 24px; line-height: 1; text-decoration: none; }
    .authorization-detail:hover { background: #dcebe6; }
    .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 18px; font-size: 14px; }
    .pagination a { min-width: 72px; height: 36px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; color: #0f6655; background: #edf3f1; text-decoration: none; }
    .pagination a.disabled { color: #9daab2; background: #f0f2f3; pointer-events: none; }
    @media (max-width: 600px) { .shell { width: min(calc(100% - 32px), 1000px); } .inventory-filters { gap: 8px; } .authorization-list .authorization { gap: 8px; grid-template-columns: minmax(0, 1fr) auto 40px; } .authorization-status { font-size: 13px; } .pagination { gap: 8px; } }
    .danger { background: #a12424; }
    .token { overflow-wrap: anywhere; padding: 12px; background: #edf3f1; border-radius: 4px; }
    .recipient { width: min(calc(100% - 32px), 520px); }
    .section-verification-result { border-bottom: 1px solid #edf2f5; padding-bottom: 14px; }
    .section-action { margin-top: 14px; }
    .country { font-weight: 600; font-size: 16px; margin: 0 0 12px; color: #17202a; }
    .country .calling-code { color: #53616c; font-size: 13px; font-weight: 500; }
    .number { margin: 12px 0; color: #17202a; font-size: clamp(28px, 8vw, 40px); font-weight: 700; letter-spacing: .02em; overflow-wrap: anywhere; }
    .number-expiry, .result-view-expiry { color: #53616c; font-size: 14px; margin: 12px 0 0; }
    .quota-info { color: #53616c; font-size: 14px; margin: 0 0 4px; font-weight: 500; }
    .action-prompt { color: #53616c; font-size: 14px; margin: 0 0 8px; line-height: 1.55; overflow-wrap: anywhere; }
    .facts { display: grid; gap: 10px; margin: 20px 0; padding: 0; list-style: none; color: #53616c; }
    .recipient button { width: 100%; }
    button:disabled { background: #b0bec5; cursor: not-allowed; opacity: 0.85; }
    [data-countdown] { display: inline-block; min-width: 5ch; font-variant-numeric: tabular-nums; }
    .steps-guide { background: #f0f7f5; border: 1px solid #c2e0d8; border-radius: 6px; padding: 14px 16px; margin: 16px 0; text-align: left; }
    .guide-title { font-weight: 600; color: #0f6655; margin: 0 0 6px; font-size: 14px; }
    .guide-copy { margin: 0; font-size: 13px; color: #334155; line-height: 1.6; }
    .status-waiting { display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; color: #0f6655; margin: 12px 0 16px; font-weight: 500; }
    .spinner { width: 14px; height: 14px; border: 2px solid #0f665533; border-top-color: #0f6655; border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; box-sizing: border-box; }
    .success-badge { display: inline-block; background: #e6f4ea; color: #137333; font-weight: 600; font-size: 13px; padding: 4px 12px; border-radius: 12px; margin-bottom: 8px; }
    .country-flag-img { width: 22px; height: 15px; object-fit: cover; border-radius: 2px; vertical-align: -2px; margin-right: 6px; box-shadow: 0 1px 2px #00000026; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <script>function copyValue(btn,text){if(!text)return;const orig=btn.dataset.originalText||btn.textContent;btn.dataset.originalText=orig;const doFeedback=()=>{btn.textContent='已复制 ✓';btn.classList.add('copied');setTimeout(()=>{btn.textContent=orig;btn.classList.remove('copied');},2000);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(doFeedback,doFeedback);}else{doFeedback();}}</script>
</head>
<body>${content}</body>
</html>`;
}

function loginPage(path: string, csrfToken: string, error?: string): string {
  const errorMarkup = error ? `<p class="error" role="alert">${error}</p>` : '';
  return htmlPage('管理员登录', `<main><section class="panel"><h1>管理员登录</h1><p>请输入部署时配置的管理密码。</p>${errorMarkup}<form method="post" action="/${path}/login"><input type="hidden" name="csrf" value="${csrfToken}"><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">登录</button></form></section></main>`);
}

const SVG_GEAR = `<svg class="icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const SVG_ARROW_LEFT = `<svg class="icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;

function headingWithIcon(heading: string): string {
  if (heading === '设置') return `${SVG_GEAR}${heading}`;
  return heading;
}

function navLabelWithIcon(label: string): string {
  if (label.includes('返回') || label === '设置') {
    const icon = label === '设置' ? SVG_GEAR : SVG_ARROW_LEFT;
    return `${icon}${label}`;
  }
  return label;
}

function adminPage(title: string, heading: string, path: string, csrfToken: string, navigationPath: string, navigationLabel: string, content: string): string {
  return htmlPage(title, `<main class="shell"><header><nav><a href="${navigationPath}">${navLabelWithIcon(navigationLabel)}</a></nav><h1>${headingWithIcon(heading)}</h1><form method="post" action="/${path}/logout"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">退出登录</button></form></header>${content}</main>`);
}

function parseAuthorizationListQuery(query: { page?: string; status?: string; suffix?: string }): AuthorizationListQuery {
  const status = ['unclaimed', 'in_progress', 'result_available', 'ended'].includes(query.status ?? '')
    ? query.status as AuthorizationListTopLevelStatus
    : undefined;
  const suffix = /^[A-Za-z0-9_-]{8}$/.test(query.suffix ?? '') ? query.suffix : undefined;
  const page = /^\d+$/.test(query.page ?? '') ? Number(query.page) : undefined;
  return {
    ...(page !== undefined && Number.isSafeInteger(page) && page >= 1 ? { page } : {}),
    ...(status ? { status } : {}),
    ...(suffix ? { tokenSuffix: suffix } : {}),
  };
}

function adminShell(path: string, csrfToken: string, listPage: AuthorizationListPage, error?: string, reconciliations: AcquisitionReconciliation[] = []): string {
  const errorMarkup = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const listQuery = (overrides: Partial<AuthorizationListQuery> = {}): string => {
    const query = { page: listPage.page, ...(listPage.status ? { status: listPage.status } : {}), ...(listPage.tokenSuffix ? { tokenSuffix: listPage.tokenSuffix } : {}), ...overrides };
    const params = new URLSearchParams();
    if (query.page && query.page > 1) params.set('page', String(query.page));
    if (query.status) params.set('status', query.status);
    if (query.tokenSuffix) params.set('suffix', query.tokenSuffix);
    const encoded = params.toString();
    return encoded ? `?${encoded}` : '';
  };
  const filters = `<form class="inventory-filters" method="get" action="/${path}"><label>状态<select name="status"><option value="">全部状态</option><option value="unclaimed"${listPage.status === 'unclaimed' ? ' selected' : ''}>待领取</option><option value="in_progress"${listPage.status === 'in_progress' ? ' selected' : ''}>进行中</option><option value="result_available"${listPage.status === 'result_available' ? ' selected' : ''}>结果可查看</option><option value="ended"${listPage.status === 'ended' ? ' selected' : ''}>已结束</option></select></label><label>链接末 8 位<input name="suffix" value="${escapeHtml(listPage.tokenSuffix ?? '')}" inputmode="text" maxlength="8" pattern="[A-Za-z0-9_-]{8}"></label><button type="submit">筛选</button></form>`;
  const recent = listPage.items.length === 0
    ? `<p class="empty">${listPage.total === 0 && (listPage.status || listPage.tokenSuffix) ? '没有符合条件的激活授权。' : '尚未创建激活授权。'}</p>`
    : `<div class="authorization-list">${listPage.items.map((authorization) => `<article class="authorization" data-authorization-id="${authorization.id}"><span class="authorization-suffix">${escapeHtml(authorization.tokenSuffix ?? '链接末 8 位未知')}</span><span class="authorization-status">${escapeHtml(authorizationStatusLabel(authorization.status))}</span><a class="authorization-detail" aria-label="查看详情" href="/${path}/authorizations/${authorization.id}">→</a></article>`).join('')}</div>`;
  const pagination = listPage.totalPages > 0
    ? `<nav class="pagination" aria-label="授权列表分页"><a class="pagination-previous${listPage.hasPreviousPage ? '' : ' disabled'}"${listPage.hasPreviousPage ? ` href="/${path}${listQuery({ page: listPage.page - 1 })}"` : ' aria-disabled="true"'}>上一页</a><span>第 ${listPage.page} / ${listPage.totalPages} 页</span><a class="pagination-next${listPage.hasNextPage ? '' : ' disabled'}"${listPage.hasNextPage ? ` href="/${path}${listQuery({ page: listPage.page + 1 })}"` : ' aria-disabled="true"'}>下一页</a></nav>`
    : '';
  const reconciliationMarkup = reconciliations.length === 0 ? '' : `<section class="card"><h2>号码获取对账</h2><p class="error">全局号码获取队列已暂停，处理完成后自动恢复。</p>${reconciliations.map((request) => {
    const candidates = request.candidates.map((candidate) => `<li>激活 ID ${escapeHtml(candidate.activationId)}${candidate.countryId !== undefined ? `，地区 ${candidate.countryId}` : ''}${candidate.activationTime ? `，时间 ${escapeHtml(candidate.activationTime.toISOString())}` : ''}<form method="post" action="/${path}/acquisition-requests/${request.id}/candidates/${encodeURIComponent(candidate.activationId)}/link"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">关联此供应商激活</button></form></li>`).join('');
    const recipient = `链接末 8 位：${request.tokenSuffix ?? '未知'}`;
    return `<article class="authorization"><p><strong>${escapeHtml(recipient)}</strong> · ${request.status}</p><p>${escapeHtml(request.countryName)}，请求时间：${escapeHtml(request.requestedAt.toISOString())}</p>${candidates ? `<ul>${candidates}</ul>` : '<p>当前没有可关联候选。</p>'}<form method="post" action="/${path}/acquisition-requests/${request.id}/reconcile"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">重新执行对账</button></form><form method="post" action="/${path}/acquisition-requests/${request.id}/confirm-absent"><input type="hidden" name="csrf" value="${csrfToken}"><button class="danger" type="submit">确认未产生激活</button></form></article>`;
  }).join('')}</section>`;
  const content = `<section class="dashboard">${errorMarkup}${reconciliationMarkup}<section class="card"><h2>批量创建激活授权链接</h2><p>一次可生成 1 至 50 条授权链接。</p><form class="batch-create-form" method="post" action="/${path}/authorizations/batch/preview"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">预览批量创建</button><label>创建数量<input name="quantity" type="number" min="1" max="50" step="1" value="10" required></label></form></section><section class="card inventory-card"><h2>最近激活授权</h2>${filters}${recent}${pagination}</section></section>`;
  return adminPage('管理后台', '管理后台', path, csrfToken, `/${path}/settings`, '设置', content);
}


const COUNTDOWN_SCRIPT = `<script>(()=>{const elements=document.querySelectorAll('[data-countdown]');if(!elements.length)return;const clock=(seconds)=>String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');const update=()=>{let reload=false;elements.forEach((el)=>{const target=Date.parse(el.dataset.countdown);const expired=target<=Date.now();const seconds=Math.max(0,Math.floor((target-Date.now())/1000));const fmt=el.dataset.format;if(fmt==='minutes-seconds'){if(expired){el.textContent='已到期';}else{const h=Math.floor(seconds/3600);const m=Math.floor(seconds%3600/60);const s=seconds%60;el.textContent=(h>0?h+'小时 ':'')+m+'分 '+(s<10?'0':'')+s+'秒';}}else if(fmt==='clock'){el.textContent=expired?(el.dataset.expiredText||'00:00'):clock(seconds);}else if(fmt==='cancel-countdown'){if(expired){el.textContent='已可'+(el.dataset.action==='end'?String.fromCharCode(32467,26463):String.fromCharCode(25442,21495));if(!el.dataset.reloaded){el.dataset.reloaded='true';reload=true;}}else{el.textContent=clock(seconds);}}});if(reload){setTimeout(()=>location.reload(),500);}};update();setInterval(update,1000);})();</script>`;

function authorizationDetailPage(path: string, csrfToken: string, detail: AuthorizationDetail): string {
  const isUnclaimedDetail = detail.status === '待领取' && !detail.claimedAt && detail.candidates.length === 0 && detail.activations.length === 0;

  // 供应商激活卡片：当前激活高亮行、对账中的号码获取进行中行、历史激活行、未消耗候选位置占位行。
  const numberExpiryIso = detail.activation ? detail.activation.numberExpiresAt.toISOString() : '';
  const numberRemaining = detail.activation
    ? (detail.activation.numberExpiresAtCountdown
      ? `<span data-countdown="${numberExpiryIso}" data-format="minutes-seconds">${escapeHtml(numberExpiryIso)}</span>`
      : escapeHtml(formatDateTime(detail.activation.numberExpiresAt)))
    : '';
  const currentActivationRow = detail.activation
    ? `<li class="activation-current"><strong>位置 ${detail.activation.position} · ${escapeHtml(detail.activation.countryName)}：</strong>${activationStatusLabel(detail.activation.status)}，号码有效至：${numberRemaining}${detail.activation.phoneNumber ? `，<strong>完整号码：</strong>${escapeHtml(detail.activation.phoneNumber)}` : ''}${detail.activation.verificationCode ? `，<strong>验证码：</strong>${escapeHtml(detail.activation.verificationCode)}` : ''}，激活 ID ${escapeHtml(detail.activation.providerActivationId)}，费用 ${detail.activation.activationCost.toFixed(2)} ${escapeHtml(formatCurrency(detail.activation.currency))}</li>`
    : '';
  const acquisitionRow = !detail.activation && detail.acquisition
    ? `<li><strong>位置 ${detail.acquisition.position} · ${escapeHtml(detail.acquisition.countryName)}：</strong>${activationStatusLabel(detail.acquisition.status)}</li>`
    : '';
  const historyRows = detail.activations
    .filter((activation) => !detail.activation || activation.providerActivationId !== detail.activation.providerActivationId)
    .map((activation) => `<li><strong>位置 ${activation.position} · ${escapeHtml(activation.countryName)}：</strong>${activationStatusLabel(activation.status)}，获取时间 ${escapeHtml(formatDateTime(activation.acquiredAt))}，激活 ID ${escapeHtml(activation.providerActivationId)}，费用 ${activation.activationCost.toFixed(2)} ${escapeHtml(formatCurrency(activation.currency))}${activation.refundConfirmed !== undefined ? `，已确认退款 ${activation.refundConfirmed.toFixed(2)} ${escapeHtml(formatCurrency(activation.currency))}` : ''}${activation.refundPending ? '，退款确认待处理 ⚠️' : ''}</li>`).join('');
  const unusedPositionRows = detail.candidates
    .filter((candidate) => !candidate.used)
    .map((candidate) => `<li><strong>位置 ${candidate.position} · ${escapeHtml(candidate.countryName)}：</strong>⬜ 未消耗</li>`).join('');
  const activationListItems = [currentActivationRow, acquisitionRow, historyRows, unusedPositionRows].filter((markup) => markup !== '').join('');
  const activations = activationListItems === '' ? '<p>尚无供应商激活。</p>' : `<ul class="summary">${activationListItems}</ul>`;
  const unrecognizedSmsText = detail.activation?.unrecognizedSmsText ?? detail.unrecognizedSmsText;
  const activationSection = !isUnclaimedDetail && (detail.candidates.length > 0 || detail.activations.length > 0)
    ? `<section class="card"><h2>供应商激活</h2>${activations}${unrecognizedSmsText ? `<h3>无法识别验证码的短信正文</h3><p class="token">${escapeHtml(unrecognizedSmsText)}</p>` : ''}</section>`
    : '';

  const costs = detail.costs.length === 0 ? '<p>尚无费用。</p>' : `<ul class="summary">${detail.costs.map((cost) => `<li>累计激活费用：${cost.activationCost.toFixed(2)} ${escapeHtml(formatCurrency(cost.currency))}；已确认退款：${cost.confirmedRefund.toFixed(2)} ${escapeHtml(formatCurrency(cost.currency))}；净成本：${cost.netCost.toFixed(2)} ${escapeHtml(formatCurrency(cost.currency))}</li>`).join('')}</ul>`;
  const costSection = !isUnclaimedDetail && (detail.candidates.length > 0 || detail.costs.length > 0)
    ? `<section class="card"><h2>成本</h2>${costs}</section>`
    : '';

  const revoke = detail.canRevoke ? `<p><a href="/${path}/authorizations/${detail.id}/revoke">撤销授权</a></p>` : '';

  const identifierHeading = detail.tokenSuffix ? `链接末 8 位：${detail.tokenSuffix}` : '链接末 8 位：未知';
  // 头部卡片只保留授权状态、创建时间、领取时间（领取后）与撤销授权入口；
  // 领取期限可由领取时间加一天心算，获取额度由未消耗候选位置表达，均不再单独展示。
  const lifecycle = `<p>创建时间：${escapeHtml(formatDateTime(detail.createdAt))}</p>${detail.claimedAt ? `<p>领取时间：${escapeHtml(formatDateTime(detail.claimedAt))}</p>` : ''}`;

  const content = `<section class="dashboard"><section class="card"><h2>${escapeHtml(identifierHeading)}</h2>${authorizationStatusMarkup(detail.status, detail.endedReason, detail.endedAt)}${lifecycle}${revoke}</section>${activationSection}${costSection}</section>${COUNTDOWN_SCRIPT}`;
  return adminPage('激活授权详情', '激活授权详情', path, csrfToken, `/${path}`, '返回首页', content);
}

function authorizationRevocationConfirmationPage(path: string, csrfToken: string, detail: AuthorizationDetail): string {
  const activation = detail.activation
    ? `<li><strong>当前地区：</strong>${escapeHtml(detail.activation.countryName)}</li><li><strong>当前激活状态：</strong>${escapeHtml(detail.activation.status)}</li>`
    : detail.acquisition
      ? `<li><strong>当前地区：</strong>${escapeHtml(detail.acquisition.countryName)}</li><li><strong>当前激活状态：</strong>${detail.acquisition.status}</li>`
      : '<li><strong>当前激活状态：</strong>尚未获取号码</li>';
  const identityLabel = '链接末 8 位';
  const identityValue = detail.tokenSuffix ? `链接末 8 位：${detail.tokenSuffix}` : '链接末 8 位：未知';
  const acquisitionCount = (detail.claimedAt || detail.candidates.length > 0) ? `<li><strong>已获取次数：</strong>${detail.acquisitionCount}</li>` : '';
  const content = `<section class="dashboard"><section class="card"><h2>确认撤销授权</h2><p class="error">撤销后此链接将立即失效，相关数据将被清理，此操作无法恢复。</p><ul class="summary"><li><strong>${identityLabel}：</strong>${escapeHtml(identityValue)}</li><li><strong>授权状态：</strong>${detail.status}</li>${activation}${acquisitionCount}<li><strong>撤销后：</strong>${escapeHtml(detail.revocationConsequence ?? '该激活授权已经不可撤销。')}</li></ul><form method="post" action="/${path}/authorizations/${detail.id}/revoke"><input type="hidden" name="csrf" value="${csrfToken}"><button class="danger" type="submit">确认撤销授权</button></form></section></section>`;
  return adminPage('确认撤销授权', '确认撤销授权', path, csrfToken, `/${path}/authorizations/${detail.id}`, '返回详情', content);
}

function preflightFingerprint(value: unknown, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify(value)).digest('base64url');
}

function fingerprintMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function batchAuthorizationConfirmationPage(path: string, csrfToken: string, preflight: BatchAuthorizationPreflight, fingerprint: string, warning?: string): string {
  const warningMarkup = warning ? `<p class="error" role="alert">${escapeHtml(warning)}</p>` : '';
  const content = `<section class="dashboard"><section class="card"><h2>确认创建</h2>${warningMarkup}<p>将创建 ${preflight.quantity} 条永久待领取授权链接。</p><form method="post" action="/${path}/authorizations/batch"><input type="hidden" name="csrf" value="${csrfToken}"><input type="hidden" name="quantity" value="${preflight.quantity}"><input type="hidden" name="preflightFingerprint" value="${fingerprint}"><button type="submit">确认创建</button></form></section></section>`;
  return adminPage('确认批量创建授权链接', '确认批量创建授权链接', path, csrfToken, `/${path}`, '返回首页', content);
}

function batchAuthorizationCreatedPage(path: string, csrfToken: string, authorizationUrls: string[]): string {
  const urls = escapeHtml(authorizationUrls.join('\n'));
  const content = `<section class="dashboard"><section class="card"><h2>批量授权链接已创建</h2><p>完整授权链接仅显示这一次；数据库不会保存可恢复的完整授权链接。</p><pre class="token" id="authorization-urls">${urls}</pre><button type="button" onclick="copyValue(this, document.getElementById('authorization-urls').textContent)">复制全部</button></section></section>`;
  return adminPage('批量授权链接已创建', '批量授权链接已创建', path, csrfToken, `/${path}`, '返回首页', content);
}

function formatInternationalNumber(value: string): string {
  const e164 = value.startsWith('+') ? value : `+${value}`;
  const digits = e164.slice(1);
  if (/^44\d{10}$/.test(digits)) return `+44 ${formatNationalNumber(digits.slice(2), '44')}`;
  if (/^1\d{10}$/.test(digits)) return `+1 ${formatNationalNumber(digits.slice(1), '1')}`;
  return e164.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

interface NationalNumberSplit {
  callingCode: string;
  nationalNumber: string;
}

// 仅当国际号码去除 `+` 后以该地区呼叫代码开头时才拆分；地区未知、代码缺失或号码不匹配时返回 undefined。
function splitNationalNumber(e164: string, callingCode?: string): NationalNumberSplit | undefined {
  if (!callingCode) return undefined;
  const digits = e164.startsWith('+') ? e164.slice(1) : e164;
  if (!digits.startsWith(callingCode)) return undefined;
  const nationalNumber = digits.slice(callingCode.length);
  if (!nationalNumber) return undefined;
  return { callingCode, nationalNumber };
}

// 国内号码分组沿用整号格式化规则的对应分支（+1 用 3-3-4、+44 用 2-4-4、其余每 3 位分组）。
function formatNationalNumber(nationalNumber: string, callingCode: string): string {
  if (callingCode === '1' && /^\d{10}$/.test(nationalNumber)) {
    return `${nationalNumber.slice(0, 3)} ${nationalNumber.slice(3, 6)} ${nationalNumber.slice(6)}`;
  }
  if (callingCode === '44' && /^\d{10}$/.test(nationalNumber)) {
    return `${nationalNumber.slice(0, 2)} ${nationalNumber.slice(2, 6)} ${nationalNumber.slice(6)}`;
  }
  return nationalNumber.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

function recipientPage(token: string, view: RecipientAuthorizationView, message?: string): string {
  const action = `/a/${encodeURIComponent(token)}/numbers`;
  const errorMarkup = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : '';
  const firstFlowHint = !view.hasAcquiredNumber ? '<p>获取号码后，请在 24 小时内使用</p>' : '';
  const countdownScript = COUNTDOWN_SCRIPT;
  const acquisitionForm = (label = '获取号码') => `<form method="post" action="${action}" onsubmit="const button=this.querySelector('button');button.disabled=true;button.textContent='正在获取号码'"><button type="submit">${label}</button></form>`;
  if (view.state === 'available') {
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1>${firstFlowHint}${errorMarkup}${acquisitionForm()}</section></main>`);
  }
  if (view.state === 'claimed' && view.quotaExhaustedPromptUntil) {
    const promptUntil = view.quotaExhaustedPromptUntil.toISOString();
    const refreshDelay = Math.max(1_000, Math.ceil(view.quotaExhaustedPromptUntil.getTime() - Date.now()));
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>可用号码次数已用尽，请联系发送者</p><ul class="facts"><li>提示结束时间：<span data-countdown="${escapeHtml(promptUntil)}" data-format="minutes-seconds">${escapeHtml(promptUntil)}</span></li></ul></section></main>${countdownScript}<script>setTimeout(()=>location.reload(),${refreshDelay});</script>`);
  }
  if (view.state === 'claimed' && view.currentNumberActionInProgress) {
    const action = view.currentNumberActionInProgress === 'end' ? '正在结束使用' : '正在更换号码';
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>${action}</p></section></main><script>setTimeout(()=>location.reload(),5000)</script>`);
  }
  if (view.state === 'claimed' && view.activationTimeoutInProgress) {
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>正在确认号码状态</p></section></main><script>setTimeout(()=>location.reload(),5000)</script>`);
  }
  if (view.state === 'claimed' && (view.phoneNumber || view.smsDelivered)) {
    const e164 = view.phoneNumber ? (view.phoneNumber.startsWith('+') ? view.phoneNumber : `+${view.phoneNumber}`) : undefined;
    const split = e164 ? splitNationalNumber(e164, countryCallingCode(view.countryName)) : undefined;
    const countryMarkup = view.countryName
      ? `<p class="country">${countryFlagHtml(view.countryName)} ${escapeHtml(view.countryName)}${split ? ` <span class="calling-code">(+${escapeHtml(split.callingCode)})</span>` : ''}</p>`
      : '';
    const numberMarkup = e164
      ? split
        ? `<p class="number">${escapeHtml(formatNationalNumber(split.nationalNumber, split.callingCode))}</p><button type="button" data-copy-value="${escapeHtml(split.nationalNumber)}" onclick="copyValue(this, this.dataset.copyValue)">复制号码</button>`
        : `<p class="number">${escapeHtml(formatInternationalNumber(e164))}</p><button type="button" data-copy-value="${escapeHtml(e164)}" onclick="copyValue(this, this.dataset.copyValue)">复制号码</button>`
      : '';
    const numberExpiryIso = view.numberExpiresAt?.toISOString();
    const numberExpiryMarkup = numberExpiryIso
      ? `<p class="number-expiry">号码有效至：还剩 <span data-countdown="${escapeHtml(numberExpiryIso)}" data-format="clock" data-expired-text="00:00（号码已过期）">${escapeHtml(numberExpiryIso)}</span></p>`
      : '';

    const currentNumberSection = `<section class="section-current-number" aria-label="当前号码">${countryMarkup}${numberMarkup}${numberExpiryMarkup}</section>`;

    const guideMarkup = `<div class="steps-guide"><p class="guide-title">💡 使用说明</p><p class="guide-copy">复制上方号码，填到验证界面并确认；系统将自动接收并显示验证码。</p></div>`;

    let verificationMarkup = '';
    if (view.smsDelivered) {
      const resultViewUntil = view.resultViewUntil?.toISOString();
      const resultViewRemainingMarkup = resultViewUntil
        ? `<p class="result-view-expiry">验证码可查看至：<span data-countdown="${escapeHtml(resultViewUntil)}" data-format="clock" data-expired-text="00:00（查看期已结束）">${escapeHtml(resultViewUntil)}</span></p>`
        : '';
      const delivery = view.verificationCode
        ? `<p class="number" id="verification-code">${escapeHtml(view.verificationCode)}</p><button type="button" data-copy-value="${escapeHtml(view.verificationCode)}" onclick="copyValue(this, this.dataset.copyValue)">复制验证码</button>`
        : '<p>短信已收到，暂时无法显示验证码，请联系发送者</p>';
      verificationMarkup = `${delivery}${resultViewRemainingMarkup}`;
    } else {
      verificationMarkup = `<div class="status-waiting"><span class="spinner"></span> 正在监听短信验证码...</div>`;
    }
    const verificationSection = `<section class="section-verification-result" aria-label="验证码">${verificationMarkup}</section>`;

    let actionPrompt = '';
    let actionButton = '';

    if (view.smsDelivered) {
      actionButton = '<button type="button" disabled>已收到验证码</button>';
    } else {
      const currentNumberAction = view.currentNumberAction;
      const cancelAvailableIso = view.cancelAvailableAt?.toISOString();
      if (currentNumberAction === 'replace') {
        if (view.currentNumberActionAvailable) {
          actionPrompt = '<p class="action-prompt">长时间未收到验证码，可点击更换号码</p>';
          actionButton = `<form method="post" action="/a/${encodeURIComponent(token)}/replacement"><button type="submit">更换号码</button></form>`;
        } else if (cancelAvailableIso) {
          actionPrompt = `<p class="action-prompt"><span data-countdown="${escapeHtml(cancelAvailableIso)}" data-format="cancel-countdown" data-action="replace">${escapeHtml(cancelAvailableIso)}</span> 后可换号</p>`;
          actionButton = '<button type="button" disabled>更换号码</button>';
        }
      } else if (currentNumberAction === 'end') {
        if (view.currentNumberActionAvailable) {
          actionPrompt = '<p class="action-prompt">仍长时间未收到验证码，可点击结束使用并联系管理员</p>';
          actionButton = `<form method="post" action="/a/${encodeURIComponent(token)}/replacement"><button type="submit">结束使用</button></form>`;
        } else if (cancelAvailableIso) {
          actionPrompt = `<p class="action-prompt">再等 <span data-countdown="${escapeHtml(cancelAvailableIso)}" data-format="cancel-countdown" data-action="end">${escapeHtml(cancelAvailableIso)}</span></p>`;
          actionButton = '<button type="button" disabled>结束使用</button>';
        }
      }
    }

    const actionSection = `<section class="section-action"><p class="quota-info">剩余可用号码次数：${view.remainingNumberCount}</p>${actionPrompt}${actionButton}</section>`;

    const refreshDelay = view.resultViewRemainingMs;
    const refreshScript = view.smsDelivered && refreshDelay !== undefined
      ? `<script>setTimeout(()=>location.reload(),${Math.max(1000, Math.ceil(refreshDelay))});</script>`
      : '';
    const pollingScript = (!view.smsDelivered || !view.verificationCode)
      ? '<script>setTimeout(()=>location.reload(),5000)</script>'
      : '';

    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1>${errorMarkup}${currentNumberSection}${guideMarkup}${verificationSection}${actionSection}</section></main>${countdownScript}${pollingScript}${refreshScript}`);
  }
  if (view.state === 'claimed' && view.acquisitionState) {
    const status = view.acquisitionState === 'manual' ? '号码状态待发送者处理' : '正在确认号码获取结果，请稍候';
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1>${firstFlowHint}<p>${status}</p></section></main>`);
  }
  const terminalMessage = view.remainingNumberCount === 0
    ? '<p>可用号码次数已用尽，请联系发送者</p>'
    : view.nextNumberAvailable
      ? `<p>号码已过期</p><p>剩余可用号码次数：${view.remainingNumberCount}</p>` + acquisitionForm('获取下一个号码')
      : `${firstFlowHint}${acquisitionForm()}`;
  return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1>${errorMarkup}${terminalMessage}</section></main>`);
}

function replacementConfirmationPage(token: string, action: 'replace' | 'end'): string {
  const endingUse = action === 'end';
  const title = endingUse ? '结束使用此号码' : '更换号码';
  const consequence = endingUse ? '结束后当前号码将不能继续使用' : '更换后当前号码将不能继续使用。';
  const confirmation = endingUse ? '确认结束' : '确认更换号码';
  return htmlPage(endingUse ? '确认结束使用' : '确认更换号码', `<main class="recipient"><section class="panel"><h1>${title}</h1><p>${consequence}</p><form method="post" action="/a/${encodeURIComponent(token)}/replacement/confirm"><button name="replacement" value="wait" type="submit" autofocus>继续等待</button><button class="danger" name="replacement" value="confirm" type="submit">${confirmation}</button></form></section></main>`);
}

function unavailableRecipientPage(message = '此链接不可用，请联系发送者'): string {
  return htmlPage('链接不可用', `<main class="recipient"><section class="panel"><h1>链接不可用</h1><p>${escapeHtml(message)}</p></section></main>`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function jsonForScript(value: unknown): string {
  const serialized = JSON.stringify(value);
  return (serialized ?? 'null').replace(/[<>&]/g, (character) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[character] ?? character);
}

function settingsPage(path: string, csrfToken: string, settings: CandidateLocationSettings, error?: string, saved?: boolean): string {
  // 只把当前 HeroSMS 可查询数据嵌入页面；报价和库存不会写入默认配置。
  const locationsJson = jsonForScript(settings.locations.map((location) => {
    const quote = location.price === undefined || location.stock === undefined ? '暂无报价' : `价格 ${location.price.toString()}，库存 ${location.stock}`;
    return [location.id, `${location.name}，${quote}`];
  }));
  const configuredByPosition = new Map(settings.configuredLocations.map((location) => [location.position, location]));
  const configuredPositions = [1, 2, 3].map((position) => configuredByPosition.get(position));
  const initialIds = jsonForScript(configuredPositions.map((location) => location?.countryId ?? null));
  const initialNames = jsonForScript(configuredPositions.map((location) => location?.countryName ?? null));
  const comboboxes = [0, 1, 2].map((position) => {
    const configured = configuredPositions[position];
    const selectedId = configured?.countryId;
    const selectedLocation = selectedId !== undefined ? settings.locations.find((location) => location.id === selectedId) : undefined;
    const selectedName = configured?.countryName
      ? escapeHtml(`${configured.countryName}${selectedLocation ? `，${selectedLocation.price === undefined || selectedLocation.stock === undefined ? '暂无报价' : `价格 ${selectedLocation.price.toString()}，库存 ${selectedLocation.stock}`}` : `，地区 ID ${configured.countryId}`}`)
      : '';
    const inputClass = selectedName ? ' cb-selected' : '';
    return `<label>候选地区 ${position + 1}<div class="cb" id="cb${position}"><input class="cb-input${inputClass}" type="text" value="${selectedName}" placeholder="输入地区名称搜索并选择…" autocomplete="off" aria-label="候选地区 ${position + 1}" aria-haspopup="listbox"><button type="button" class="cb-clear" tabindex="-1" title="清除选择">✕</button><input type="hidden" name="candidate${position + 1}" value="${selectedId ?? ''}"><ul class="cb-list" role="listbox"></ul></div></label>`;
  }).join('');
  const comboboxScript = `<script>(()=>{const LOCS=${locationsJson};const INIT=${initialIds};const INIT_NAMES=${initialNames};function esc(s){return s.replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]??c);}function hl(text,q){if(!q)return esc(text);const i=text.toLowerCase().indexOf(q.toLowerCase());if(i<0)return esc(text);return esc(text.slice(0,i))+'<span class="cb-hl">'+esc(text.slice(i,i+q.length))+'</span>'+esc(text.slice(i+q.length));}function init(idx){const wrap=document.getElementById('cb'+idx);const inp=wrap.querySelector('.cb-input');const clr=wrap.querySelector('.cb-clear');const hid=wrap.querySelector('input[type=hidden]');const list=wrap.querySelector('.cb-list');let selId=INIT[idx];let selName=INIT_NAMES[idx]?inp.value:'';let activeIdx=-1;function render(q){list.innerHTML='';activeIdx=-1;const matched=LOCS.filter(l=>!q||l[1].toLowerCase().includes(q.toLowerCase()));if(!matched.length){list.innerHTML='<li class="cb-empty">无匹配地区</li>';}else{matched.forEach((l,i)=>{const li=document.createElement('li');li.className='cb-opt';li.setAttribute('role','option');li.dataset.id=l[0];li.dataset.name=l[1];li.innerHTML=hl(l[1],q);li.addEventListener('mousedown',e=>{e.preventDefault();pick(l[0],l[1]);});list.appendChild(li);});}list.classList.add('cb-open');}function pick(id,name){selId=id;selName=name;hid.value=id;inp.value=name;inp.classList.add('cb-selected');list.classList.remove('cb-open');}function clear(){selId=null;selName='';hid.value='';inp.value='';inp.classList.remove('cb-selected');list.classList.remove('cb-open');inp.focus();}inp.addEventListener('focus',()=>render(inp.classList.contains('cb-selected')?'':inp.value));inp.addEventListener('input',()=>{if(inp.classList.contains('cb-selected')&&inp.value!==selName){inp.classList.remove('cb-selected');hid.value='';selId=null;}render(inp.value);});inp.addEventListener('blur',()=>{setTimeout(()=>{list.classList.remove('cb-open');if(selId!=null&&inp.value!==selName){inp.value=selName;inp.classList.add('cb-selected');}else if(selId==null){inp.value='';inp.classList.remove('cb-selected');}},150);});inp.addEventListener('keydown',e=>{const opts=[...list.querySelectorAll('.cb-opt')];if(e.key==='ArrowDown'){e.preventDefault();activeIdx=Math.min(activeIdx+1,opts.length-1);opts.forEach((o,i)=>o.classList.toggle('cb-active',i===activeIdx));opts[activeIdx]?.scrollIntoView({block:'nearest'});}else if(e.key==='ArrowUp'){e.preventDefault();activeIdx=Math.max(activeIdx-1,0);opts.forEach((o,i)=>o.classList.toggle('cb-active',i===activeIdx));opts[activeIdx]?.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'&&activeIdx>=0&&opts[activeIdx]){e.preventDefault();const o=opts[activeIdx];pick(Number(o.dataset.id),o.dataset.name);}else if(e.key==='Escape'){list.classList.remove('cb-open');inp.blur();}});clr.addEventListener('click',clear);}[0,1,2].forEach(init);document.addEventListener('click',e=>{if(!e.target.closest('.cb'))document.querySelectorAll('.cb-list').forEach(l=>l.classList.remove('cb-open'));});})();<\/script>`;
  const errorMarkup = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const savedBadge = saved
    ? `<span id="save-toast" role="status" aria-live="polite" style="margin-left:.75rem;color:#166534;font-size:.875rem">✓ 已保存</span><script>(()=>{setTimeout(()=>{const t=document.getElementById('save-toast');if(t)t.remove();history.replaceState(null,'',location.pathname);},3000);})();<\/script>`
    : '';
  const heroStatus = settings.heroSmsAvailable
    ? `<p><strong>HeroSMS 已连接</strong>${savedBadge}</p>`
    : `<p class="error" role="alert">暂时无法读取 HeroSMS 设置；以下仅显示数据库中已保存的候选位置。</p>${savedBadge}`;
  const balanceMarkup = settings.balance === undefined ? '' : `<p>余额：${settings.balance.toFixed(2)}</p>`;
  const configurationWarning = settings.configurationComplete
    ? ''
    : '<p class="error" role="alert">当前默认候选地区配置不完整，请重新选择并保存三个候选地区。</p>';
  return adminPage('默认候选地区', '设置', path, csrfToken, `/${path}`, '返回首页', `<section class="settings">${heroStatus}${balanceMarkup}${configurationWarning}${errorMarkup}<form method="post" action="/${path}/settings"><input type="hidden" name="csrf" value="${csrfToken}">${comboboxes}<button type="submit">保存默认候选地区</button></form></section>${comboboxScript}`);
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
  now?: () => Date;
  tokenGenerator?: AuthorizationTokenGeneratorInput;
}

export async function createApp(config: AppConfig, database = new Database(config.databaseUrl), dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  await database.initialize();
  await database.expireDueAuthorizations(dependencies.now?.() ?? new Date());
  const authentication = new AdminAuthentication(config, database);
  const heroSms = dependencies.heroSms ?? new HeroSmsHttpAdapter({
    apiKey: config.heroSmsApiKey,
    baseUrl: HEROSMS_COMPATIBILITY_URL,
  });
  const defaultCandidateLocations = new DefaultCandidateLocations(database, heroSms, config.openAiServiceCode);
  const activationAuthorizations = new ActivationAuthorizations(database, heroSms, config.openAiServiceCode, dependencies.now, dependencies.tokenGenerator);
  await activationAuthorizations.reconcilePendingRequests();
  await activationAuthorizations.cancelAcquisitionsConfirmedAfterAuthorizationExpiry();
  await activationAuthorizations.reconcileTimedOutActivations();
  await activationAuthorizations.cancelRevokedActivations();
  await activationAuthorizations.retryPendingReplacementCancellations();
  await activationAuthorizations.reconcileCancellationConfirmations();
  await activationAuthorizations.runPendingReplacementAcquisitions();
  await activationAuthorizations.pollWaitingActivations();
  await activationAuthorizations.finishDeliveredActivations();
  await activationAuthorizations.deleteExpiredSensitiveDeliveryData();
  const app = Fastify({ logger: false, trustProxy: config.trustedProxy });
  await app.register(cookie);
  await app.register(formbody);

  let closing = false;
  const pendingFinishTasks = new Set<Promise<void>>();
  const trackPromise = (promise: Promise<unknown>): void => {
    const task = promise.then(() => undefined, () => undefined);
    pendingFinishTasks.add(task);
    void task.then(() => { pendingFinishTasks.delete(task); });
  };
  let authorizationExpiryTimer: NodeJS.Timeout | undefined;
  let revocationCancellationTimer: NodeJS.Timeout | undefined;
  let cancellationConfirmationReconciliationTimer: NodeJS.Timeout | undefined;
  let pendingReplacementCancellationTimer: NodeJS.Timeout | undefined;

  let cancellationConfirmationReconciliationSchedulingPromise: Promise<void> | undefined;
  let cancellationConfirmationReconciliationRescheduleRequested = false;
  let revocationCancellationSchedulingPromise: Promise<void> | undefined;
  let revocationCancellationRescheduleRequested = false;
  let pendingReplacementCancellationSchedulingPromise: Promise<void> | undefined;
  let pendingReplacementCancellationRescheduleRequested = false;
  let authorizationExpirySchedulingPromise: Promise<void> | undefined;
  let authorizationExpiryRescheduleRequested = false;

  const retryCancellationConfirmationReconciliationScheduling = (): void => {
    if (closing) return;
    cancellationConfirmationReconciliationTimer = setTimeout(() => {
      cancellationConfirmationReconciliationTimer = undefined;
      trackPromise(scheduleNextCancellationConfirmationReconciliation().catch(retryCancellationConfirmationReconciliationScheduling));
    }, 1_000);
    cancellationConfirmationReconciliationTimer.unref();
  };
  /** 换号/结束使用、撤销、授权到期及对账延后等任何运行期状态转移进入“取消确认中”
   *  或产生新的取消重试时间后，都重新安排专用调度器：按数据库中最早到期时间触发。 */
  const wakeCancellationConfirmationReconciliationScheduling = (): void => {
    void scheduleNextCancellationConfirmationReconciliation().catch(retryCancellationConfirmationReconciliationScheduling);
  };
  const scheduleNextCancellationConfirmationReconciliation = async (): Promise<void> => {
    if (closing) return;
    if (cancellationConfirmationReconciliationSchedulingPromise) {
      cancellationConfirmationReconciliationRescheduleRequested = true;
      return cancellationConfirmationReconciliationSchedulingPromise;
    }
    cancellationConfirmationReconciliationSchedulingPromise = (async () => {
      do {
        cancellationConfirmationReconciliationRescheduleRequested = false;
        const reconcileAt = await activationAuthorizations.nextCancellationConfirmationReconciliation();
        if (closing) break;
        if (cancellationConfirmationReconciliationTimer) {
          clearTimeout(cancellationConfirmationReconciliationTimer);
          cancellationConfirmationReconciliationTimer = undefined;
        }
        if (!reconcileAt) break;
        const currentTime = dependencies.now?.() ?? new Date();
        const delay = Math.min(Math.max(0, reconcileAt.getTime() - currentTime.getTime()), 2_147_483_647);
        cancellationConfirmationReconciliationTimer = setTimeout(() => {
          if (closing) return;
          cancellationConfirmationReconciliationTimer = undefined;
          trackPromise(
            // 先领取授权到期产生的取消任务（waiting_sms + 到期取消标记），再对账取消确认中记录，
            // 与 60 秒后台扫描保持同一相对顺序；完成后按数据库中最早到期时间安排下一次。
            activationAuthorizations.cancelAcquisitionsConfirmedAfterAuthorizationExpiry()
              .then(() => activationAuthorizations.reconcileCancellationConfirmations())
              .then(async () => {
                await scheduleNextCancellationConfirmationReconciliation();
                // 对账返回 too-early 时会把换号/结束使用或撤销来源的记录回退到 waiting_sms
                // 并持久化新的重试期限：换号与撤销专用调度器须按该期限精确触发，
                // 60 秒后台扫描仅作恢复机制。
                await scheduleNextPendingReplacementCancellation();
                await scheduleNextRevocationCancellation();
              })
              .catch(retryCancellationConfirmationReconciliationScheduling),
          );
        }, delay);
        cancellationConfirmationReconciliationTimer.unref();
      } while (cancellationConfirmationReconciliationRescheduleRequested && !closing);
    })().finally(() => {
      cancellationConfirmationReconciliationSchedulingPromise = undefined;
    });
    return cancellationConfirmationReconciliationSchedulingPromise;
  };
  const retryRevocationCancellationScheduling = (): void => {
    if (closing) return;
    revocationCancellationTimer = setTimeout(() => {
      revocationCancellationTimer = undefined;
      trackPromise(scheduleNextRevocationCancellation().catch(retryRevocationCancellationScheduling));
    }, 1_000);
    revocationCancellationTimer.unref();
  };
  const scheduleNextRevocationCancellation = async (): Promise<void> => {
    if (closing) return;
    if (revocationCancellationSchedulingPromise) {
      revocationCancellationRescheduleRequested = true;
      return revocationCancellationSchedulingPromise;
    }
    revocationCancellationSchedulingPromise = (async () => {
      do {
        revocationCancellationRescheduleRequested = false;
        const cancelAt = await activationAuthorizations.nextPendingRevocationCancellation();
        if (closing) break;
        if (revocationCancellationTimer) {
          clearTimeout(revocationCancellationTimer);
          revocationCancellationTimer = undefined;
        }
        if (!cancelAt) break;
        const currentTime = dependencies.now?.() ?? new Date();
        const delay = Math.min(Math.max(0, cancelAt.getTime() - currentTime.getTime()), 2_147_483_647);
        revocationCancellationTimer = setTimeout(() => {
          if (closing) return;
          revocationCancellationTimer = undefined;
          trackPromise(
            activationAuthorizations.cancelRevokedActivations()
              .then(async () => {
                await scheduleNextPendingReplacementCancellation();
                await scheduleNextRevocationCancellation();
                // 撤销取消可能把记录留在“取消确认中”（供应商请求异常等）：重新安排取消确认对账调度。
                wakeCancellationConfirmationReconciliationScheduling();
              })
              .catch(retryRevocationCancellationScheduling),
          );
        }, delay);
        revocationCancellationTimer.unref();
      } while (revocationCancellationRescheduleRequested && !closing);
    })().finally(() => {
      revocationCancellationSchedulingPromise = undefined;
    });
    return revocationCancellationSchedulingPromise;
  };
  const retryAuthorizationExpiryScheduling = (): void => {
    if (closing) return;
    authorizationExpiryTimer = setTimeout(() => {
      authorizationExpiryTimer = undefined;
      trackPromise(scheduleNextAuthorizationExpiry().catch(retryAuthorizationExpiryScheduling));
    }, 1_000);
    authorizationExpiryTimer.unref();
  };
  const retryPendingReplacementCancellationScheduling = (): void => {
    if (closing) return;
    pendingReplacementCancellationTimer = setTimeout(() => {
      pendingReplacementCancellationTimer = undefined;
      trackPromise(scheduleNextPendingReplacementCancellation().catch(retryPendingReplacementCancellationScheduling));
    }, 1_000);
    pendingReplacementCancellationTimer.unref();
  };
  const scheduleNextPendingReplacementCancellation = async (): Promise<void> => {
    if (closing) return;
    if (pendingReplacementCancellationSchedulingPromise) {
      pendingReplacementCancellationRescheduleRequested = true;
      return pendingReplacementCancellationSchedulingPromise;
    }
    pendingReplacementCancellationSchedulingPromise = (async () => {
      do {
        pendingReplacementCancellationRescheduleRequested = false;
        const cancelAt = await activationAuthorizations.nextPendingReplacementCancellation();
        if (closing) break;
        if (pendingReplacementCancellationTimer) {
          clearTimeout(pendingReplacementCancellationTimer);
          pendingReplacementCancellationTimer = undefined;
        }
        if (!cancelAt) break;
        const currentTime = dependencies.now?.() ?? new Date();
        const delay = Math.min(Math.max(0, cancelAt.getTime() - currentTime.getTime()), 2_147_483_647);
        pendingReplacementCancellationTimer = setTimeout(() => {
          if (closing) return;
          pendingReplacementCancellationTimer = undefined;
          trackPromise(
            activationAuthorizations.retryPendingReplacementCancellations()
              .then(async () => {
                await scheduleNextPendingReplacementCancellation();
                await scheduleNextRevocationCancellation();
                // 换号/结束使用重试可能把记录留在“取消确认中”（供应商请求异常等）：重新安排取消确认对账调度。
                wakeCancellationConfirmationReconciliationScheduling();
              })
              .catch(retryPendingReplacementCancellationScheduling),
          );
        }, delay);
        pendingReplacementCancellationTimer.unref();
      } while (pendingReplacementCancellationRescheduleRequested && !closing);
    })().finally(() => {
      pendingReplacementCancellationSchedulingPromise = undefined;
    });
    return pendingReplacementCancellationSchedulingPromise;
  };
  const scheduleNextAuthorizationExpiry = async (): Promise<void> => {
    if (closing) return;
    if (authorizationExpirySchedulingPromise) {
      authorizationExpiryRescheduleRequested = true;
      return authorizationExpirySchedulingPromise;
    }
    authorizationExpirySchedulingPromise = (async () => {
      do {
        authorizationExpiryRescheduleRequested = false;
        const expiresAt = await activationAuthorizations.nextRecipientAccessExpiry();
        if (closing) break;
        if (authorizationExpiryTimer) {
          clearTimeout(authorizationExpiryTimer);
          authorizationExpiryTimer = undefined;
        }
        if (!expiresAt) break;
        const currentTime = dependencies.now?.() ?? new Date();
        const delay = Math.min(Math.max(0, expiresAt.getTime() - currentTime.getTime()), 2_147_483_647);
        authorizationExpiryTimer = setTimeout(() => {
          if (closing) return;
          authorizationExpiryTimer = undefined;
          trackPromise(
            activationAuthorizations.expireDue()
              .then(async () => {
                await scheduleNextAuthorizationExpiry();
                // 授权到期可能产生新的取消对账时间：重新安排取消确认对账调度。
                wakeCancellationConfirmationReconciliationScheduling();
              })
              .catch(retryAuthorizationExpiryScheduling),
          );
        }, delay);
        authorizationExpiryTimer.unref();
      } while (authorizationExpiryRescheduleRequested && !closing);
    })().finally(() => {
      authorizationExpirySchedulingPromise = undefined;
    });
    return authorizationExpirySchedulingPromise;
  };

  const recipientState = async (token: string, sessionToken?: string): Promise<Awaited<ReturnType<ActivationAuthorizations['recipientState']>>> => {
    const view = await activationAuthorizations.recipientState(token, sessionToken);
    trackPromise(scheduleNextAuthorizationExpiry().catch(retryAuthorizationExpiryScheduling));
    return view;
  };

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    reply.header('Cache-Control', 'no-store');
  });

  app.get('/health', async () => ({ status: 'ok' }));

  const webhookRequests = new Map<string, { minute: number; count: number }>();
  app.post<{ Body: HeroSmsWebhookBody }>(`/${config.heroSmsWebhookPath}`, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!config.heroSmsWebhookAllowedIps.includes(request.ip)) return reply.code(404).send();
    const minute = Math.floor((dependencies.now?.() ?? new Date()).getTime() / 60_000);
    const rate = webhookRequests.get(request.ip);
    const count = rate?.minute === minute ? rate.count + 1 : 1;
    webhookRequests.set(request.ip, { minute, count });
    if (count > config.heroSmsWebhookRequestsPerMinute) return reply.code(429).send();

    const body = request.body;
    const activationId = typeof body?.activationId === 'string' && body.activationId.trim() ? body.activationId.trim() : undefined;
    const serviceCode = typeof body?.service === 'string' && body.service.trim() ? body.service.trim() : undefined;
    const text = typeof body?.text === 'string' && body.text.length <= 10_000 ? body.text : undefined;
    const code = typeof body?.code === 'string' && body.code.trim() && body.code.length <= 256 ? body.code.trim() : undefined;
    const countryId = typeof body?.country === 'number' ? body.country : typeof body?.country === 'string' ? Number(body.country) : NaN;
    const receivedAt = parseSupplierDate(body?.receivedAt);
    if (!activationId || !serviceCode || text === undefined || !Number.isSafeInteger(countryId) || countryId < 0 || !receivedAt) {
      return reply.code(400).send();
    }
    await activationAuthorizations.receiveHeroSmsWebhook({
      activationId, serviceCode, text, countryId, receivedAt, ...(code ? { code } : {}),
    });
    void scheduleNextAuthorizationExpiry().catch(retryAuthorizationExpiryScheduling);
    const finishTask = new Promise<void>((resolve) => {
      setImmediate(() => {
        void activationAuthorizations.finishDeliveredActivations(activationId)
          .catch(() => undefined)
          .finally(resolve);
      });
    });
    pendingFinishTasks.add(finishTask);
    void finishTask.then(() => { pendingFinishTasks.delete(finishTask); });
    return reply.code(200).send();
  });

  const adminRoot = `/${config.adminPath}`;
  app.get<{ Querystring: { page?: string; status?: string; suffix?: string } }>(adminRoot, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (session) {
      cookiesForSession(reply, session.id, session.csrfToken);
      return reply.type('text/html; charset=utf-8').send(adminShell(
        config.adminPath,
        session.csrfToken,
        await activationAuthorizations.list(parseAuthorizationListQuery(request.query)),
        undefined,
        await activationAuthorizations.listAcquisitionReconciliations(),
      ));
    }

    const csrfToken = randomToken();
    setLoginCsrf(reply, csrfToken);
    return reply.type('text/html; charset=utf-8').send(loginPage(config.adminPath, csrfToken));
  });

  app.get<{ Params: { id: string } }>(`${adminRoot}/authorizations/:id`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (!session) return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    await activationAuthorizations.cancelRevokedActivations().catch(() => undefined);
    await activationAuthorizations.reconcileCancellationConfirmations().catch(() => undefined);
    // 对账可能把换号/结束使用或撤销来源的记录 too-early 回退并持久化新的重试期限：
    // 重新武装专用调度器按该期限精确触发，60 秒后台扫描仅作恢复机制。
    await scheduleNextRevocationCancellation().catch(retryRevocationCancellationScheduling);
    await scheduleNextPendingReplacementCancellation().catch(retryPendingReplacementCancellationScheduling);
    const detail = await activationAuthorizations.detail(request.params.id);
    if (!detail) return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    cookiesForSession(reply, session.id, session.csrfToken);
    return reply.type('text/html; charset=utf-8').send(authorizationDetailPage(config.adminPath, session.csrfToken, detail));
  });

  app.get<{ Params: { id: string } }>(`${adminRoot}/authorizations/:id/revoke`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (!session) return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    const detail = await activationAuthorizations.detail(request.params.id);
    if (!detail || !detail.canRevoke) return reply.code(409).type('text/html; charset=utf-8').send(adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list({}), '该激活授权已经不可撤销。'));
    cookiesForSession(reply, session.id, session.csrfToken);
    return reply.type('text/html; charset=utf-8').send(authorizationRevocationConfirmationPage(config.adminPath, session.csrfToken, detail));
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

  const batchPreview = async (request: FastifyRequest<{ Body: AuthorizationBody }>, reply: FastifyReply): Promise<FastifyReply> => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    try {
      const preflight = await activationAuthorizations.batchPreflight(request.body.quantity);
      return reply.type('text/html; charset=utf-8').send(batchAuthorizationConfirmationPage(
        config.adminPath,
        session.csrfToken,
        preflight,
        preflightFingerprint(preflight, config.sessionSecret),
      ));
    } catch (error) {
      const message = error instanceof AuthorizationValidationError ? error.message : '暂时无法准备批量创建。';
      return reply.code(error instanceof AuthorizationValidationError ? 422 : 503).type('text/html; charset=utf-8').send(
        adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list({}), message),
      );
    }
  };

  const batchCreate = async (request: FastifyRequest<{ Body: AuthorizationBody }>, reply: FastifyReply): Promise<FastifyReply> => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    try {
      const preflight = await activationAuthorizations.batchPreflight(request.body.quantity);
      const currentFingerprint = preflightFingerprint(preflight, config.sessionSecret);
      if (!fingerprintMatches(request.body.preflightFingerprint, currentFingerprint)) {
        return reply.code(409).type('text/html; charset=utf-8').send(batchAuthorizationConfirmationPage(
          config.adminPath,
          session.csrfToken,
          preflight,
          currentFingerprint,
          '创建数量已变化，请重新确认。',
        ));
      }
      const created = await activationAuthorizations.createBatch(preflight.quantity);
      const authorizationUrls = created.map((item) => new URL(`/a/${item.token}`, config.publicOrigin).toString());
      return reply.code(201).type('text/html; charset=utf-8').send(batchAuthorizationCreatedPage(config.adminPath, session.csrfToken, authorizationUrls));
    } catch (error) {
      const message = error instanceof AuthorizationValidationError ? error.message : '暂时无法批量创建激活授权链接。';
      return reply.code(error instanceof AuthorizationValidationError ? 422 : 503).type('text/html; charset=utf-8').send(
        adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list({}), message),
      );
    }
  };

  app.post<{ Body: AuthorizationBody }>(`${adminRoot}/authorizations/batch/preview`, batchPreview);
  app.post<{ Body: AuthorizationBody }>(`${adminRoot}/authorizations/batch`, batchCreate);
  app.post<{ Body: AuthorizationBody }>(`${adminRoot}/authorizations/preview`, batchPreview);
  app.post<{ Body: AuthorizationBody }>(`${adminRoot}/authorizations`, batchCreate);

  app.post<{ Body: CsrfBody; Params: { id: string } }>(`${adminRoot}/authorizations/:id/revoke`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    const revoked = await activationAuthorizations.revoke(request.params.id);
    if (!revoked) return reply.code(409).type('text/html; charset=utf-8').send(adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list({}), '该激活授权已经不可撤销。'));
    void scheduleNextRevocationCancellation().catch(retryRevocationCancellationScheduling);
    void scheduleNextCancellationConfirmationReconciliation().catch(retryCancellationConfirmationReconciliationScheduling);
    return reply.redirect(adminRoot, 303);
  });

  app.get<{ Params: { token: string } }>('/a/:token', async (request, reply) => {
    const result = await recipientState(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (result.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (result.state === 'unavailable') return reply.type('text/html; charset=utf-8').send(unavailableRecipientPage());
    if (result.state === 'browser-mismatch') return reply.type('text/html; charset=utf-8').send(unavailableRecipientPage('此链接已被领取，当前浏览器无法访问，请联系发送者'));
    return reply.type('text/html; charset=utf-8').send(recipientPage(request.params.token, result));
  });

  app.post<{ Params: { token: string } }>('/a/:token/numbers', async (request, reply) => {
    const result = await activationAuthorizations.claimAndGetNumber(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    // 号码获取可能产生授权到期取消任务（跨截止确认的号码）：重新安排取消确认对账调度。
    wakeCancellationConfirmationReconciliationScheduling();
    if (result.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (result.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    if (result.state === 'browser-mismatch') {
      return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage('此链接已被领取，当前浏览器无法访问，请联系发送者'));
    }
    if (result.state === 'claim-failed') {
      const view = await recipientState(request.params.token);
      if (view.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
      return reply.code(503).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view, RECIPIENT_ACQUISITION_ERROR_MESSAGE));
    }
    if (result.setSessionCookie) {
      reply.setCookie(RECIPIENT_COOKIE, result.sessionToken, {
        httpOnly: true, maxAge: 25 * 60 * 60, path: `/a/${request.params.token}`, sameSite: 'strict', secure: true,
      });
    }
    if (result.state === 'claimed') return reply.redirect(`/a/${request.params.token}`, 303);
    const view = await recipientState(request.params.token, result.sessionToken);
    if (result.state === 'confirming') {
      return reply.code(202).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view));
    }
    const message = result.state === 'no-numbers'
      ? RECIPIENT_NO_NUMBERS_MESSAGE
      : RECIPIENT_ACQUISITION_ERROR_MESSAGE;
    return reply.code(result.state === 'no-numbers' ? 409 : 503).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view, message));
  });

  app.post<{ Params: { token: string } }>('/a/:token/replacement', async (request, reply) => {
    const view = await recipientState(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (view.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (view.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    if (view.state === 'browser-mismatch') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage('此链接已被领取，当前浏览器无法访问，请联系发送者'));
    if (!view.currentNumberAction || !view.currentNumberActionAvailable) {
      return reply.code(409).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view, '当前号码暂时不能操作，请继续等待。'));
    }
    return reply.type('text/html; charset=utf-8').send(replacementConfirmationPage(request.params.token, view.currentNumberAction));
  });

  app.post<{ Body: ReplacementBody; Params: { token: string } }>('/a/:token/replacement/confirm', async (request, reply) => {
    if (request.body?.replacement === 'wait') return reply.redirect(`/a/${request.params.token}`, 303);
    if (request.body?.replacement !== 'confirm') return reply.code(400).send();
    const result = await activationAuthorizations.requestNumberReplacement(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    // 换号/结束使用请求可能进入“取消确认中”或产生新的取消重试时间：
    // 无条件重新安排两个专用调度器，不依赖页面刷新、短信 webhook 或 60 秒后台扫描。
    void scheduleNextPendingReplacementCancellation().catch(retryPendingReplacementCancellationScheduling);
    wakeCancellationConfirmationReconciliationScheduling();
    if (result.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (result.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    const view = await recipientState(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (view.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (view.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    if (view.state === 'browser-mismatch') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage('此链接已被领取，当前浏览器无法访问，请联系发送者'));
    if (result.state === 'replaced' || result.state === 'ended') return reply.redirect(`/a/${request.params.token}`, 303);
    if (result.state === 'confirming') return reply.code(202).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view));
    const message = result.state === 'too-early'
      ? '当前号码暂时不能操作，请继续等待。'
      : result.state === 'no-numbers'
        ? RECIPIENT_NO_NUMBERS_MESSAGE
        : RECIPIENT_ACQUISITION_ERROR_MESSAGE;
    return reply.code(result.state === 'too-early' || result.state === 'no-numbers' ? 409 : 503)
      .type('text/html; charset=utf-8').send(recipientPage(request.params.token, view, message));
  });

  app.post<{ Body: CsrfBody; Params: { id: string } }>(`${adminRoot}/acquisition-requests/:id/reconcile`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    await activationAuthorizations.reconcileAcquisitionRequest(request.params.id);
    return reply.redirect(adminRoot, 303);
  });

  app.post<{ Body: CsrfBody; Params: { id: string; activationId: string } }>(`${adminRoot}/acquisition-requests/:id/candidates/:activationId/link`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    const linked = await activationAuthorizations.linkAcquisitionCandidate(request.params.id, request.params.activationId);
    return linked ? reply.redirect(adminRoot, 303) : reply.code(409).send();
  });

  app.post<{ Body: CsrfBody; Params: { id: string } }>(`${adminRoot}/acquisition-requests/:id/confirm-absent`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    const confirmed = await activationAuthorizations.confirmAcquisitionAbsent(request.params.id);
    return confirmed ? reply.redirect(adminRoot, 303) : reply.code(409).send();
  });

  app.get<{ Querystring: { saved?: string } }>(`${adminRoot}/settings`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (!session) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    }
    cookiesForSession(reply, session.id, session.csrfToken);
    const saved = request.query.saved === '1';
    try {
      const settings = await defaultCandidateLocations.settings();
      return reply.type('text/html; charset=utf-8').send(settingsPage(config.adminPath, session.csrfToken, settings, undefined, saved));
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
      return reply.redirect(`${adminRoot}/settings?saved=1`, 303);
    } catch (error) {
      if (error instanceof CandidateLocationValidationError) {
        try {
          const settings = await defaultCandidateLocations.settings();
          return reply.code(422).type('text/html; charset=utf-8').send(settingsPage(config.adminPath, session.csrfToken, settings, error.message));
        } catch {
          return reply.code(503).type('text/html; charset=utf-8').send(settingsUnavailablePage(config.adminPath, session.csrfToken));
        }
      }
      try {
        const settings = await defaultCandidateLocations.settings();
        return reply.code(503).type('text/html; charset=utf-8').send(settingsPage(config.adminPath, session.csrfToken, settings));
      } catch {
        return reply.code(503).type('text/html; charset=utf-8').send(settingsUnavailablePage(config.adminPath, session.csrfToken));
      }
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

  const runBackgroundTasks = async (): Promise<void> => {
    await database.expireDueAuthorizations(dependencies.now?.() ?? new Date());
    await activationAuthorizations.reconcilePendingRequests();
    await activationAuthorizations.cancelAcquisitionsConfirmedAfterAuthorizationExpiry();
    // 超时收尾必须先于取消对账，避免刚到二十分钟的取消确认自动创建后继激活。
    await activationAuthorizations.reconcileTimedOutActivations();
    await activationAuthorizations.cancelRevokedActivations();
    await activationAuthorizations.retryPendingReplacementCancellations();
    await activationAuthorizations.reconcileCancellationConfirmations();
    await activationAuthorizations.runPendingReplacementAcquisitions();
    await activationAuthorizations.pollWaitingActivations();
    await activationAuthorizations.finishDeliveredActivations();
    await activationAuthorizations.deleteExpiredSensitiveDeliveryData();
    // 后台扫描只是通用恢复机制：结束后重新武装全部精确调度器，
    // 正常调度正确性由各调度器按数据库中最早到期时间承担。
    await scheduleNextAuthorizationExpiry();
    await scheduleNextRevocationCancellation();
    await scheduleNextCancellationConfirmationReconciliation();
    await scheduleNextPendingReplacementCancellation();
  };
  let backgroundTasksRunning = false;
  const expirationSweep = setInterval(() => {
    if (backgroundTasksRunning) return;
    backgroundTasksRunning = true;
    void runBackgroundTasks()
      .catch(() => undefined)
      .finally(() => { backgroundTasksRunning = false; });
  }, 60_000);
  expirationSweep.unref();
  await scheduleNextAuthorizationExpiry().catch(retryAuthorizationExpiryScheduling);
  await scheduleNextRevocationCancellation().catch(retryRevocationCancellationScheduling);
  await scheduleNextCancellationConfirmationReconciliation().catch(retryCancellationConfirmationReconciliationScheduling);
  await scheduleNextPendingReplacementCancellation().catch(retryPendingReplacementCancellationScheduling);

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).type('text/plain; charset=utf-8').send('Not Found'));
  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(expirationSweep);
    if (authorizationExpiryTimer) clearTimeout(authorizationExpiryTimer);
    if (revocationCancellationTimer) clearTimeout(revocationCancellationTimer);
    if (cancellationConfirmationReconciliationTimer) clearTimeout(cancellationConfirmationReconciliationTimer);
    if (pendingReplacementCancellationTimer) clearTimeout(pendingReplacementCancellationTimer);
    await Promise.all(pendingFinishTasks);
    await database.close();
  });
  return app;
}
