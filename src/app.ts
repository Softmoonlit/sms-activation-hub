import { createHmac, timingSafeEqual } from 'node:crypto';

import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { AdminAuthentication, ADMIN_SESSION_MAX_AGE_SECONDS, LoginRateLimitedError } from './admin-auth.js';
import { ActivationAuthorizations, AuthorizationValidationError, DuplicateActiveAuthorizationError, type AcquisitionReconciliation, type AuthorizationDetail, type AuthorizationPreflight, type AuthorizationSummary, type RecipientAuthorizationView } from './activation-authorizations.js';
import { CandidateLocationValidationError, DefaultCandidateLocations, type CandidateLocationSettings } from './default-candidate-locations.js';
import { countryFlag, countryFlagHtml, formatCurrency, formatDateTime } from './country-flag.js';
import { type AppConfig, randomToken } from './config.js';
import { Database } from './database.js';
import { HeroSmsHttpAdapter, type HeroSms } from './herosms.js';

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
  recipientIdentifier?: string;
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

function activationStatusLabel(status: string): string {
  return activationStatusLabels[status] ? `${activationStatusLabels[status]}（${status}）` : status;
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
    .shell header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #d7dde1; padding-bottom: 16px; gap: 16px; }
    .shell h1 { margin: 0; font-size: 22px; font-weight: 650; display: flex; align-items: center; gap: 0.35em; }
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
    .authorization { border-top: 1px solid #e3e7e9; padding: 16px 0; }
    .authorization:first-child { border-top: 0; }
    .authorization p { margin: 4px 0; }
    .danger { background: #a12424; }
    .token { overflow-wrap: anywhere; padding: 12px; background: #edf3f1; border-radius: 4px; }
    .recipient { width: min(calc(100% - 32px), 520px); }
    .country { font-weight: 600; font-size: 16px; margin: 0 0 12px; color: #17202a; }
    .number { margin: 12px 0; color: #17202a; font-size: clamp(28px, 8vw, 40px); font-weight: 700; letter-spacing: .02em; overflow-wrap: anywhere; }
    .facts { display: grid; gap: 10px; margin: 20px 0; padding: 0; list-style: none; color: #53616c; }
    .recipient button { width: 100%; }
    .steps-guide { background: #f0f7f5; border: 1px solid #c2e0d8; border-radius: 6px; padding: 14px 16px; margin: 16px 0; text-align: left; }
    .guide-title { font-weight: 600; color: #0f6655; margin: 0 0 6px; font-size: 14px; }
    .guide-steps { margin: 0; padding-left: 20px; font-size: 13px; color: #334155; line-height: 1.6; }
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
  return htmlPage(title, `<main class="shell"><header><h1>${headingWithIcon(heading)}</h1><nav><a href="${navigationPath}">${navLabelWithIcon(navigationLabel)}</a></nav><form method="post" action="/${path}/logout"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">退出登录</button></form></header>${content}</main>`);
}

function adminShell(path: string, csrfToken: string, authorizations: AuthorizationSummary[] | { items: AuthorizationSummary[] }, error?: string, reconciliations: AcquisitionReconciliation[] = []): string {
  const authorizationItems = Array.isArray(authorizations) ? authorizations : authorizations.items;
  const errorMarkup = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const recent = authorizationItems.length === 0 ? '<p class="empty">尚未创建激活授权。</p>' : authorizationItems.map((authorization) => {
    const identifier = authorization.recipientIdentifier ?? `链接末 8 位：${authorization.tokenSuffix ?? '未知'}`;
    const expiry = authorization.expiresAt ? `<p>到期时间：${escapeHtml(authorization.expiresAt.toISOString())}</p>` : '<p>领取前永久有效</p>';
    return `<article class="authorization"><p><strong>${escapeHtml(identifier)}</strong> · ${authorization.status}</p>${authorization.currentActivationStatus ? `<p>当前激活状态：${escapeHtml(activationStatusLabel(authorization.currentActivationStatus))}</p>` : '<p>当前激活状态：尚无供应商激活</p>'}${authorization.hasPendingException ? '<p class="error">待处理异常</p>' : ''}${authorization.internalNote ? `<p>${escapeHtml(authorization.internalNote)}</p>` : ''}${expiry}<p><a href="/${path}/authorizations/${authorization.id}">查看详情</a></p>${authorization.canRevoke ? `<p><a href="/${path}/authorizations/${authorization.id}/revoke">撤销授权</a></p>` : ''}</article>`;
  }).join('');
  const reconciliationMarkup = reconciliations.length === 0 ? '' : `<section class="card"><h2>号码获取对账</h2><p class="error">全局号码获取队列已暂停，处理完成后自动恢复。</p>${reconciliations.map((request) => {
    const candidates = request.candidates.map((candidate) => `<li>激活 ID ${escapeHtml(candidate.activationId)}${candidate.countryId !== undefined ? `，地区 ${candidate.countryId}` : ''}${candidate.activationTime ? `，时间 ${escapeHtml(candidate.activationTime.toISOString())}` : ''}<form method="post" action="/${path}/acquisition-requests/${request.id}/candidates/${encodeURIComponent(candidate.activationId)}/link"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">关联此供应商激活</button></form></li>`).join('');
    const recipient = request.recipientIdentifier ?? `链接末 8 位：${request.tokenSuffix ?? '未知'}`;
    return `<article class="authorization"><p><strong>${escapeHtml(recipient)}</strong> · ${request.status}</p><p>${escapeHtml(request.countryName)}，请求时间：${escapeHtml(request.requestedAt.toISOString())}</p>${candidates ? `<ul>${candidates}</ul>` : '<p>当前没有可关联候选。</p>'}<form method="post" action="/${path}/acquisition-requests/${request.id}/reconcile"><input type="hidden" name="csrf" value="${csrfToken}"><button type="submit">重新执行对账</button></form><form method="post" action="/${path}/acquisition-requests/${request.id}/confirm-absent"><input type="hidden" name="csrf" value="${csrfToken}"><button class="danger" type="submit">确认未产生激活</button></form></article>`;
  }).join('')}</section>`;
  const content = `<section class="dashboard">${errorMarkup}${reconciliationMarkup}<section class="card"><h2>创建激活授权</h2><p>填写接收者标识，下一步将执行 HeroSMS 预检并显示确认汇总。</p><form method="post" action="/${path}/authorizations/preview"><input type="hidden" name="csrf" value="${csrfToken}"><label>接收者标识<input name="recipientIdentifier" required maxlength="200"></label><button type="submit">预检并确认</button></form></section><section class="card"><h2>最近激活授权</h2>${recent}</section></section>`;
  return adminPage('管理后台', '管理后台', path, csrfToken, `/${path}/settings`, '设置', content);
}

const COUNTDOWN_SCRIPT = `<script>(()=>{const elements=document.querySelectorAll('[data-countdown]');if(!elements.length)return;const update=()=>{let reload=false;elements.forEach((el)=>{const target=Date.parse(el.dataset.countdown);const seconds=Math.max(0,Math.floor((target-Date.now())/1000));const fmt=el.dataset.format;if(fmt==='hours-minutes'){if(seconds<=0){el.textContent='已到期';}else{const h=Math.floor(seconds/3600);const m=Math.floor(seconds%3600/60);el.textContent=(h>0?h+'小时 ':'')+m+'分钟';}}else if(fmt==='minutes-seconds'){if(seconds<=0){el.textContent='已到期';}else{const h=Math.floor(seconds/3600);const m=Math.floor(seconds%3600/60);const s=seconds%60;el.textContent=(h>0?h+'小时 ':'')+m+'分 '+(s<10?'0':'')+s+'秒';}}else if(fmt==='cancel-countdown'){if(seconds<=0){el.textContent='已可'+String.fromCharCode(25442,21495);if(!el.dataset.reloaded){el.dataset.reloaded='true';reload=true;}}else{const h=Math.floor(seconds/3600);const m=Math.floor(seconds%3600/60);const s=seconds%60;el.textContent=(h>0?h+'小时 ':'')+m+'分 '+(s<10?'0':'')+s+'秒';}}});if(reload){setTimeout(()=>location.reload(),500);}};update();setInterval(update,1000);})();</script>`;

function authorizationDetailPage(path: string, csrfToken: string, detail: AuthorizationDetail): string {
  const candidates = detail.candidates.map((candidate) => {
    const snapshot = candidate.quotedPrice === undefined && candidate.quotedStock === undefined
      ? '领取时配置，未保存报价库存快照'
      : `预检价格 ${candidate.quotedPrice ?? '未知'}，库存 ${candidate.quotedStock ?? '未知'}`;
    return `<li>${escapeHtml(candidate.countryName)}：${snapshot}，${candidate.used ? '已获取' : '未获取'}</li>`;
  }).join('');
  const activations = detail.activations.length === 0 ? '<p>尚无供应商激活。</p>' : `<ul class="summary">${detail.activations.map((activation) => `<li><strong>${escapeHtml(activation.countryName)}：</strong>${escapeHtml(activationStatusLabel(activation.status))}，激活 ID ${escapeHtml(activation.providerActivationId)}，获取时间 ${escapeHtml(formatDateTime(activation.acquiredAt))}，费用 ${activation.activationCost.toFixed(2)} ${escapeHtml(formatCurrency(activation.currency))}${activation.refundConfirmed !== undefined ? `，已确认退款 ${activation.refundConfirmed.toFixed(2)} ${escapeHtml(formatCurrency(activation.currency))}` : ''}${activation.refundPending ? '，退款确认待处理' : ''}</li>`).join('')}</ul>`;
  const costs = detail.costs.length === 0 ? '<p>尚无费用。</p>' : `<ul class="summary">${detail.costs.map((cost) => `<li>累计激活费用：${cost.activationCost.toFixed(2)} ${escapeHtml(formatCurrency(cost.currency))}；已确认退款：${cost.confirmedRefund.toFixed(2)} ${escapeHtml(formatCurrency(cost.currency))}；净成本：${cost.netCost.toFixed(2)} ${escapeHtml(formatCurrency(cost.currency))}</li>`).join('')}</ul>`;
  const numberExpiryIso = detail.activation ? detail.activation.numberExpiresAt.toISOString() : '';
  const numberRemaining = detail.activation
    ? (detail.activation.numberExpiresAtCountdown
      ? `<span data-countdown="${numberExpiryIso}" data-format="minutes-seconds">${escapeHtml(numberExpiryIso)}</span>`
      : escapeHtml(formatDateTime(detail.activation.numberExpiresAt)))
    : '';
  const currentActivation = detail.activation ? `<section class="card"><h2>当前供应商激活</h2><ul class="summary"><li><strong>地区：</strong>${escapeHtml(detail.activation.countryName)}</li><li><strong>激活状态：</strong>${escapeHtml(activationStatusLabel(detail.activation.status))}</li><li><strong>号码有效至：</strong>${numberRemaining}</li>${detail.activation.phoneNumber ? `<li><strong>完整号码：</strong>${escapeHtml(detail.activation.phoneNumber)}</li>` : ''}${detail.activation.verificationCode ? `<li><strong>验证码：</strong>${escapeHtml(detail.activation.verificationCode)}</li>` : ''}</ul>${detail.activation.unrecognizedSmsText ? `<h3>无法识别验证码的短信正文</h3><p class="token">${escapeHtml(detail.activation.unrecognizedSmsText)}</p>` : ''}</section>` : '';
  const revoke = detail.canRevoke ? `<p><a href="/${path}/authorizations/${detail.id}/revoke">撤销授权</a></p>` : '';
  const authExpiryIso = detail.expiresAt?.toISOString();
  const authRemaining = detail.revokedAt
    ? '已撤销'
    : authExpiryIso
      ? `<span data-countdown="${authExpiryIso}" data-format="hours-minutes">${escapeHtml(authExpiryIso)}</span>`
      : '领取前永久有效';
  const identifier = detail.recipientIdentifier ?? `链接末 8 位：${detail.tokenSuffix ?? '未知'}`;
  const content = `<section class="dashboard"><section class="card"><h2>${escapeHtml(identifier)}</h2><p>授权状态：${detail.status}</p><p>获取额度：${detail.acquisitionCount}/3</p><p>授权到期时间：${authRemaining}</p>${revoke}</section><section class="card"><h2>候选地区</h2><ul class="summary">${candidates}</ul></section><section class="card"><h2>供应商激活</h2>${activations}</section><section class="card"><h2>成本</h2>${costs}</section>${currentActivation}</section>${COUNTDOWN_SCRIPT}`;
  return adminPage('激活授权详情', '激活授权详情', path, csrfToken, `/${path}`, '返回首页', content);
}

function authorizationRevocationConfirmationPage(path: string, csrfToken: string, detail: AuthorizationDetail): string {
  const activation = detail.activation
    ? `<li><strong>当前地区：</strong>${escapeHtml(detail.activation.countryName)}</li><li><strong>当前激活状态：</strong>${escapeHtml(detail.activation.status)}</li>`
    : detail.acquisition
      ? `<li><strong>当前地区：</strong>${escapeHtml(detail.acquisition.countryName)}</li><li><strong>当前激活状态：</strong>${detail.acquisition.status}</li>`
      : '<li><strong>当前激活状态：</strong>尚未获取号码</li>';
  const identifier = detail.recipientIdentifier ?? `链接末 8 位：${detail.tokenSuffix ?? '未知'}`;
  const content = `<section class="dashboard"><section class="card"><h2>确认撤销授权</h2><ul class="summary"><li><strong>接收者标识：</strong>${escapeHtml(identifier)}</li><li><strong>授权状态：</strong>${detail.status}</li>${activation}<li><strong>已获取次数：</strong>${detail.acquisitionCount}</li><li><strong>撤销后：</strong>${escapeHtml(detail.revocationConsequence ?? '该激活授权已经不可撤销。')}</li></ul><form method="post" action="/${path}/authorizations/${detail.id}/revoke"><input type="hidden" name="csrf" value="${csrfToken}"><button class="danger" type="submit">确认撤销授权</button></form></section></section>`;
  return adminPage('确认撤销授权', '确认撤销授权', path, csrfToken, `/${path}/authorizations/${detail.id}`, '返回详情', content);
}

function preflightFingerprint(preflight: AuthorizationPreflight, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify(preflight)).digest('base64url');
}

function fingerprintMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function authorizationConfirmationPage(path: string, csrfToken: string, preflight: AuthorizationPreflight, fingerprint: string, warning?: string): string {
  const candidates = preflight.candidates.map((candidate) => `<li>${escapeHtml(candidate.countryName)}：价格 ${candidate.price}，库存 ${candidate.stock}</li>`).join('');
  const warningMarkup = warning ? `<p class="error" role="alert">${escapeHtml(warning)}</p>` : '';
  const content = `<section class="dashboard"><section class="card"><h2>确认创建</h2>${warningMarkup}<ul class="summary"><li><strong>接收者标识：</strong>${escapeHtml(preflight.recipientIdentifier)}</li>${preflight.internalNote ? `<li><strong>内部备注：</strong>${escapeHtml(preflight.internalNote)}</li>` : ''}<li><strong>HeroSMS 余额：</strong>${preflight.balance.toFixed(2)}</li>${candidates}</ul><form method="post" action="/${path}/authorizations"><input type="hidden" name="csrf" value="${csrfToken}"><input type="hidden" name="recipientIdentifier" value="${escapeHtml(preflight.recipientIdentifier)}"><input type="hidden" name="internalNote" value="${escapeHtml(preflight.internalNote ?? '')}"><input type="hidden" name="preflightFingerprint" value="${fingerprint}"><button type="submit">确认创建 24 小时授权</button></form></section></section>`;
  return adminPage('确认激活授权', '确认激活授权', path, csrfToken, `/${path}`, '返回首页', content);
}

function authorizationCreatedPage(path: string, csrfToken: string, authorizationUrl: string, expiresAt?: Date): string {
  const escapedUrl = escapeHtml(authorizationUrl);
  const expiry = expiresAt ? `<p>到期时间：${escapeHtml(expiresAt.toISOString())}</p>` : '<p>领取前永久有效</p>';
  const content = `<section class="dashboard"><section class="card"><h2>激活授权已创建</h2><p>完整授权链接仅显示这一次。丢失后请撤销并重新创建。</p><p class="token" id="authorization-url">${escapedUrl}</p>${expiry}<button type="button" onclick="copyValue(this, document.getElementById('authorization-url').textContent)">复制授权链接</button></section></section>`;
  return adminPage('激活授权已创建', '激活授权已创建', path, csrfToken, `/${path}`, '返回首页', content);
}

function formatInternationalNumber(value: string): string {
  const e164 = value.startsWith('+') ? value : `+${value}`;
  if (/^\+44\d{10}$/.test(e164)) return `${e164.slice(0, 3)} ${e164.slice(3, 5)} ${e164.slice(5, 9)} ${e164.slice(9)}`;
  if (/^\+1\d{10}$/.test(e164)) return `${e164.slice(0, 2)} ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}`;
  return e164.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
}

function recipientPage(token: string, view: RecipientAuthorizationView, message?: string): string {
  const action = `/a/${encodeURIComponent(token)}/numbers`;
  const errorMarkup = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : '';
  const deadline = view.expiresAt?.toISOString();
  const remaining = deadline
    ? `<span data-countdown="${deadline}" data-format="hours-minutes">${escapeHtml(deadline)}</span>`
    : '领取前永久有效';
  const countdownScript = COUNTDOWN_SCRIPT;
  const acquisitionForm = (label = '获取号码') => `<form method="post" action="${action}" onsubmit="const button=this.querySelector('button');button.disabled=true;button.textContent='正在获取号码'"><button type="submit">${label}</button></form>`;
  if (view.state === 'available') {
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>授权剩余时间：${remaining}</p>${errorMarkup}${acquisitionForm()}</section></main>${countdownScript}`);
  }
  if (view.state === 'claimed' && view.smsDelivered) {
    const countryMarkup = view.countryName ? `<p class="country">${countryFlag(view.countryName)} ${escapeHtml(view.countryName)}</p>` : '';
    const delivery = view.verificationCode
      ? `${countryMarkup}<div class="success-badge">🎉 已收到验证码</div><p class="number" id="verification-code">${escapeHtml(view.verificationCode)}</p><button type="button" data-copy-value="${escapeHtml(view.verificationCode)}" onclick="copyValue(this, this.dataset.copyValue)">复制验证码</button>`
      : `${countryMarkup}<p>短信已收到，暂时无法显示验证码，请联系发送者</p>`;
    const structuredCodePollingScript = view.verificationCode ? '' : '<script>setTimeout(()=>location.reload(),5000)</script>';
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1>${delivery}<ul class="facts"><li>授权剩余时间：${remaining}</li></ul></section></main>${countdownScript}${structuredCodePollingScript}`);
  }
  if (view.state === 'claimed' && view.replacementInProgress) {
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>正在更换号码</p><ul class="facts"><li>授权剩余时间：${remaining}</li></ul></section></main>${countdownScript}<script>setTimeout(()=>location.reload(),5000)</script>`);
  }
  if (view.state === 'claimed' && view.activationTimeoutInProgress) {
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>正在确认激活超时</p><ul class="facts"><li>授权剩余时间：${remaining}</li></ul></section></main>${countdownScript}<script>setTimeout(()=>location.reload(),5000)</script>`);
  }
  if (view.state === 'claimed' && view.phoneNumber) {
    const e164 = view.phoneNumber.startsWith('+') ? view.phoneNumber : `+${view.phoneNumber}`;
    const smsPollingScript = '<script>setTimeout(()=>location.reload(),5000)</script>';
    const replacementAction = view.replacementAvailable ? `<form method="post" action="/a/${encodeURIComponent(token)}/replacement"><button type="submit">更换号码</button></form>` : '';
    const numberExpiryIso = view.numberExpiresAt!.toISOString();
    const cancelAvailableIso = view.cancelAvailableAt!.toISOString();
    const numberRemaining = `<span data-countdown="${numberExpiryIso}" data-format="minutes-seconds">${escapeHtml(numberExpiryIso)}</span>`;
    const cancelRemaining = `<span data-countdown="${cancelAvailableIso}" data-format="cancel-countdown">${escapeHtml(cancelAvailableIso)}</span>`;
    const guideMarkup = `<div class="steps-guide"><p class="guide-title">💡 使用说明</p><ol class="guide-steps"><li>复制上方号码，填入 OpenAI 验证页面并发送验证码</li><li>发送后请保持本页面开着，系统将自动接收并显示验证码</li></ol></div><div class="status-waiting"><span class="spinner"></span> 正在监听短信验证码...</div>`;
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1>${errorMarkup}<p class="country">${countryFlagHtml(view.countryName)} ${escapeHtml(view.countryName ?? '')}</p><p class="number">${escapeHtml(formatInternationalNumber(e164))}</p><button type="button" data-copy-value="${escapeHtml(e164)}" onclick="copyValue(this, this.dataset.copyValue)">复制号码</button>${guideMarkup}${replacementAction}<ul class="facts"><li>授权剩余时间：${remaining}</li><li>号码有效至：${numberRemaining}</li><li>可换号时间：${cancelRemaining}</li><li>剩余可用号码次数：${view.remainingNumberCount}</li></ul></section></main>${countdownScript}${smsPollingScript}`);
  }
  if (view.state === 'claimed' && view.acquisitionState) {
    const status = view.acquisitionState === 'manual' ? '号码获取结果待发送者处理' : '正在确认号码获取结果';
    return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>授权剩余时间：${remaining}</p><p>${status}</p></section></main>${countdownScript}`);
  }
  const terminalMessage = view.remainingNumberCount === 0
    ? '<p>可用号码次数已用尽</p>'
    : view.nextNumberAvailable
      ? '<p>当前激活已超时。</p>' + acquisitionForm('获取下一个号码')
      : acquisitionForm();
  return htmlPage('OpenAI 短信激活', `<main class="recipient"><section class="panel"><h1>OpenAI</h1><p>授权剩余时间：${remaining}</p>${errorMarkup}${terminalMessage}</section></main>${countdownScript}`);
}

function replacementConfirmationPage(token: string): string {
  return htmlPage('确认更换号码', `<main class="recipient"><section class="panel"><h1>更换号码</h1><p>更换后当前号码将不能继续使用。</p><form method="post" action="/a/${encodeURIComponent(token)}/replacement/confirm"><button name="replacement" value="wait" type="submit" autofocus>继续等待</button><button name="replacement" value="confirm" type="submit">确认更换号码</button></form></section></main>`);
}

function unavailableRecipientPage(): string {
  return htmlPage('链接不可用', '<main class="recipient"><section class="panel"><h1>链接不可用</h1><p>此链接不可用，请联系发送者</p></section></main>');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function settingsPage(path: string, csrfToken: string, settings: CandidateLocationSettings, error?: string, saved?: boolean): string {
  // Serialise locations once as a JSON array embedded in the page script.
  // Each entry: [id, displayName] — displayName includes price/stock so it matches the old option text.
  const locationsJson = JSON.stringify(settings.locations.map((l) => {
    const quote = l.price === undefined || l.stock === undefined ? '暂无报价' : `价格 ${l.price.toString()}，库存 ${l.stock}`;
    return [l.id, `${l.name}，${quote}`];
  }));
  const initialIds = JSON.stringify(settings.configuredCountryIds.map((id) => id ?? null));
  const comboboxes = [0, 1, 2].map((position) => {
    const selectedId = settings.configuredCountryIds[position];
    const selectedLocation = selectedId !== undefined ? settings.locations.find((l) => l.id === selectedId) : undefined;
    const selectedName = selectedLocation
      ? escapeHtml(`${selectedLocation.name}，${selectedLocation.price === undefined || selectedLocation.stock === undefined ? '暂无报价' : `价格 ${selectedLocation.price.toString()}，库存 ${selectedLocation.stock}`}`)
      : '';
    const inputClass = selectedName ? ' cb-selected' : '';
    return `<label>候选地区 ${position + 1}<div class="cb" id="cb${position}"><input class="cb-input${inputClass}" type="text" value="${selectedName}" placeholder="输入地区名称搜索并选择…" autocomplete="off" aria-label="候选地区 ${position + 1}" aria-haspopup="listbox"><button type="button" class="cb-clear" tabindex="-1" title="清除选择">✕</button><input type="hidden" name="candidate${position + 1}" value="${selectedId ?? ''}"><ul class="cb-list" role="listbox"></ul></div></label>`;
  }).join('');
  const comboboxScript = `<script>(()=>{const LOCS=${locationsJson};const INIT=${initialIds};function esc(s){return s.replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]??c);}function hl(text,q){if(!q)return esc(text);const i=text.toLowerCase().indexOf(q.toLowerCase());if(i<0)return esc(text);return esc(text.slice(0,i))+'<span class="cb-hl">'+esc(text.slice(i,i+q.length))+'</span>'+esc(text.slice(i+q.length));}function init(idx){const wrap=document.getElementById('cb'+idx);const inp=wrap.querySelector('.cb-input');const clr=wrap.querySelector('.cb-clear');const hid=wrap.querySelector('input[type=hidden]');const list=wrap.querySelector('.cb-list');let selId=INIT[idx];let selName=selId!=null?(LOCS.find(l=>l[0]===selId)||[null,''])[1]:'';let activeIdx=-1;function render(q){list.innerHTML='';activeIdx=-1;const matched=LOCS.filter(l=>!q||l[1].toLowerCase().includes(q.toLowerCase()));if(!matched.length){list.innerHTML='<li class="cb-empty">无匹配地区</li>';}else{matched.forEach((l,i)=>{const li=document.createElement('li');li.className='cb-opt';li.setAttribute('role','option');li.dataset.id=l[0];li.dataset.name=l[1];li.innerHTML=hl(l[1],q);li.addEventListener('mousedown',e=>{e.preventDefault();pick(l[0],l[1]);});list.appendChild(li);});}list.classList.add('cb-open');}function pick(id,name){selId=id;selName=name;hid.value=id;inp.value=name;inp.classList.add('cb-selected');list.classList.remove('cb-open');}function clear(){selId=null;selName='';hid.value='';inp.value='';inp.classList.remove('cb-selected');list.classList.remove('cb-open');inp.focus();}inp.addEventListener('focus',()=>render(inp.classList.contains('cb-selected')?'':inp.value));inp.addEventListener('input',()=>{if(inp.classList.contains('cb-selected')&&inp.value!==selName){inp.classList.remove('cb-selected');hid.value='';selId=null;}render(inp.value);});inp.addEventListener('blur',()=>{setTimeout(()=>{list.classList.remove('cb-open');if(selId&&inp.value!==selName){inp.value=selName;inp.classList.add('cb-selected');}else if(!selId){inp.value='';inp.classList.remove('cb-selected');}},150);});inp.addEventListener('keydown',e=>{const opts=[...list.querySelectorAll('.cb-opt')];if(e.key==='ArrowDown'){e.preventDefault();activeIdx=Math.min(activeIdx+1,opts.length-1);opts.forEach((o,i)=>o.classList.toggle('cb-active',i===activeIdx));opts[activeIdx]?.scrollIntoView({block:'nearest'});}else if(e.key==='ArrowUp'){e.preventDefault();activeIdx=Math.max(activeIdx-1,0);opts.forEach((o,i)=>o.classList.toggle('cb-active',i===activeIdx));opts[activeIdx]?.scrollIntoView({block:'nearest'});}else if(e.key==='Enter'&&activeIdx>=0&&opts[activeIdx]){e.preventDefault();const o=opts[activeIdx];pick(Number(o.dataset.id),o.dataset.name);}else if(e.key==='Escape'){list.classList.remove('cb-open');inp.blur();}});clr.addEventListener('click',clear);}[0,1,2].forEach(init);document.addEventListener('click',e=>{if(!e.target.closest('.cb'))document.querySelectorAll('.cb-list').forEach(l=>l.classList.remove('cb-open'));});})();<\/script>`;
  const errorMarkup = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const savedBadge = saved
    ? `<span id="save-toast" role="status" aria-live="polite" style="margin-left:.75rem;color:#166534;font-size:.875rem">✓ 已保存</span><script>(()=>{setTimeout(()=>{const t=document.getElementById('save-toast');if(t)t.remove();history.replaceState(null,'',location.pathname);},3000);})();<\/script>`
    : '';
  return adminPage('默认候选地区', '设置', path, csrfToken, `/${path}`, '返回首页', `<section class="settings"><p><strong>HeroSMS 已连接</strong>${savedBadge}</p><p>余额：${settings.balance.toFixed(2)}</p>${errorMarkup}<form method="post" action="/${path}/settings"><input type="hidden" name="csrf" value="${csrfToken}">${comboboxes}<button type="submit">保存默认候选地区</button></form></section>${comboboxScript}`);
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
  const activationAuthorizations = new ActivationAuthorizations(database, heroSms, config.openAiServiceCode, dependencies.now);
  await activationAuthorizations.reconcilePendingRequests();
  await activationAuthorizations.cancelAcquisitionsConfirmedAfterAuthorizationExpiry();
  await activationAuthorizations.reconcileTimedOutActivations();
  await activationAuthorizations.cancelRevokedActivations();
  await activationAuthorizations.reconcileCancellationConfirmations();
  await activationAuthorizations.runPendingReplacementAcquisitions();
  await activationAuthorizations.pollWaitingActivations();
  await activationAuthorizations.finishDeliveredActivations();
  await activationAuthorizations.deleteExpiredSensitiveDeliveryData();
  const app = Fastify({ logger: false, trustProxy: config.trustedProxy });
  await app.register(cookie);
  await app.register(formbody);

  let closing = false;
  let authorizationExpiryTimer: NodeJS.Timeout | undefined;
  let revocationCancellationTimer: NodeJS.Timeout | undefined;
  const retryRevocationCancellationScheduling = (): void => {
    if (closing) return;
    revocationCancellationTimer = setTimeout(() => {
      revocationCancellationTimer = undefined;
      void scheduleNextRevocationCancellation().catch(retryRevocationCancellationScheduling);
    }, 1_000);
    revocationCancellationTimer.unref();
  };
  const scheduleNextRevocationCancellation = async (): Promise<void> => {
    if (closing) return;
    if (revocationCancellationTimer) clearTimeout(revocationCancellationTimer);
    revocationCancellationTimer = undefined;
    const cancelAt = await activationAuthorizations.nextPendingRevocationCancellation();
    if (!cancelAt) return;
    const currentTime = dependencies.now?.() ?? new Date();
    const delay = Math.min(Math.max(0, cancelAt.getTime() - currentTime.getTime()), 2_147_483_647);
    revocationCancellationTimer = setTimeout(() => {
      revocationCancellationTimer = undefined;
      void activationAuthorizations.cancelRevokedActivations()
        .then(scheduleNextRevocationCancellation)
        .catch(retryRevocationCancellationScheduling);
    }, delay);
    revocationCancellationTimer.unref();
  };
  const retryAuthorizationExpiryScheduling = (): void => {
    if (closing) return;
    authorizationExpiryTimer = setTimeout(() => {
      authorizationExpiryTimer = undefined;
      void scheduleNextAuthorizationExpiry().catch(retryAuthorizationExpiryScheduling);
    }, 1_000);
    authorizationExpiryTimer.unref();
  };
  const scheduleNextAuthorizationExpiry = async (): Promise<void> => {
    if (closing) return;
    if (authorizationExpiryTimer) clearTimeout(authorizationExpiryTimer);
    authorizationExpiryTimer = undefined;
    const expiresAt = await activationAuthorizations.nextRecipientAccessExpiry();
    if (!expiresAt) return;
    const currentTime = dependencies.now?.() ?? new Date();
    const delay = Math.min(Math.max(0, expiresAt.getTime() - currentTime.getTime()), 2_147_483_647);
    authorizationExpiryTimer = setTimeout(() => {
      authorizationExpiryTimer = undefined;
      void activationAuthorizations.expireDue()
        .then(scheduleNextAuthorizationExpiry)
        .catch(retryAuthorizationExpiryScheduling);
    }, delay);
    authorizationExpiryTimer.unref();
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
    const receivedAt = typeof body?.receivedAt === 'string' ? new Date(body.receivedAt) : new Date(NaN);
    if (!activationId || !serviceCode || text === undefined || !Number.isSafeInteger(countryId) || countryId < 0 || Number.isNaN(receivedAt.getTime())) {
      return reply.code(400).send();
    }
    await activationAuthorizations.receiveHeroSmsWebhook({
      activationId, serviceCode, text, countryId, receivedAt, ...(code ? { code } : {}),
    });
    setImmediate(() => { void activationAuthorizations.finishDeliveredActivations().catch(() => undefined); });
    return reply.code(200).send();
  });

  const adminRoot = `/${config.adminPath}`;
  app.get(adminRoot, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (session) {
      cookiesForSession(reply, session.id, session.csrfToken);
      return reply.type('text/html; charset=utf-8').send(adminShell(
        config.adminPath,
        session.csrfToken,
        await activationAuthorizations.list(),
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
    const detail = await activationAuthorizations.detail(request.params.id);
    if (!detail) return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    cookiesForSession(reply, session.id, session.csrfToken);
    return reply.type('text/html; charset=utf-8').send(authorizationDetailPage(config.adminPath, session.csrfToken, detail));
  });

  app.get<{ Params: { id: string } }>(`${adminRoot}/authorizations/:id/revoke`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    if (!session) return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    const detail = await activationAuthorizations.detail(request.params.id);
    if (!detail || !detail.canRevoke) return reply.code(409).type('text/html; charset=utf-8').send(adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list(), '该激活授权已经不可撤销。'));
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

  app.post<{ Body: AuthorizationBody }>(`${adminRoot}/authorizations/preview`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    try {
      const preflight = await activationAuthorizations.preflight(request.body.recipientIdentifier ?? '', request.body.internalNote);
      return reply.type('text/html; charset=utf-8').send(authorizationConfirmationPage(config.adminPath, session.csrfToken, preflight, preflightFingerprint(preflight, config.sessionSecret)));
    } catch (error) {
      const message = error instanceof AuthorizationValidationError || error instanceof DuplicateActiveAuthorizationError ? error.message : '暂时无法完成 HeroSMS 预检。';
      return reply.code(error instanceof AuthorizationValidationError || error instanceof DuplicateActiveAuthorizationError ? 422 : 503).type('text/html; charset=utf-8').send(adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list(), message));
    }
  });

  app.post<{ Body: AuthorizationBody }>(`${adminRoot}/authorizations`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    try {
      // 确认与创建之间重新执行预检，避免使用过期的余额、价格或库存。
      const preflight = await activationAuthorizations.preflight(request.body.recipientIdentifier ?? '', request.body.internalNote);
      const currentFingerprint = preflightFingerprint(preflight, config.sessionSecret);
      if (!fingerprintMatches(request.body.preflightFingerprint, currentFingerprint)) {
        return reply.code(409).type('text/html; charset=utf-8').send(authorizationConfirmationPage(config.adminPath, session.csrfToken, preflight, currentFingerprint, '价格、库存或余额已变化，请重新确认。'));
      }
      const created = await activationAuthorizations.create(preflight);
      void scheduleNextAuthorizationExpiry().catch(retryAuthorizationExpiryScheduling);
      const authorizationUrl = new URL(`/a/${created.token}`, config.publicOrigin).toString();
      return reply.code(201).type('text/html; charset=utf-8').send(authorizationCreatedPage(config.adminPath, session.csrfToken, authorizationUrl, created.expiresAt));
    } catch (error) {
      const message = error instanceof AuthorizationValidationError || error instanceof DuplicateActiveAuthorizationError ? error.message : '暂时无法创建激活授权。';
      return reply.code(error instanceof AuthorizationValidationError || error instanceof DuplicateActiveAuthorizationError ? 422 : 503).type('text/html; charset=utf-8').send(adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list(), message));
    }
  });

  app.post<{ Body: CsrfBody; Params: { id: string } }>(`${adminRoot}/authorizations/:id/revoke`, async (request, reply) => {
    const session = await authentication.sessionFor(request.cookies[ADMIN_COOKIE]);
    const csrfToken = csrfFrom(request);
    if (!session || !isSameOrigin(request, config) || !csrfToken || csrfToken !== session.csrfToken || csrfToken !== request.cookies[CSRF_COOKIE]) {
      return reply.code(403).send();
    }
    const revoked = await activationAuthorizations.revoke(request.params.id);
    if (!revoked) return reply.code(409).type('text/html; charset=utf-8').send(adminShell(config.adminPath, session.csrfToken, await activationAuthorizations.list(), '该激活授权已经不可撤销。'));
    void scheduleNextRevocationCancellation().catch(retryRevocationCancellationScheduling);
    return reply.redirect(adminRoot, 303);
  });

  app.get<{ Params: { token: string } }>('/a/:token', async (request, reply) => {
    const result = await activationAuthorizations.recipientState(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (result.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (result.state === 'unavailable') return reply.type('text/html; charset=utf-8').send(unavailableRecipientPage());
    return reply.type('text/html; charset=utf-8').send(recipientPage(request.params.token, result));
  });

  app.post<{ Params: { token: string } }>('/a/:token/numbers', async (request, reply) => {
    const result = await activationAuthorizations.claimAndGetNumber(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (result.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (result.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    reply.setCookie(RECIPIENT_COOKIE, result.sessionToken, {
      httpOnly: true, maxAge: 24 * 60 * 60, path: `/a/${request.params.token}`, sameSite: 'strict', secure: true,
    });
    if (result.state === 'claimed') return reply.redirect(`/a/${request.params.token}`, 303);
    const view = await activationAuthorizations.recipientState(request.params.token, result.sessionToken);
    if (result.state === 'confirming') {
      return reply.code(202).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view));
    }
    const message = result.state === 'no-numbers'
      ? '当前暂无可用号码，请联系发送者'
      : '暂时无法获取号码，请联系发送者';
    return reply.code(result.state === 'no-numbers' ? 409 : 503).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view, message));
  });

  app.post<{ Params: { token: string } }>('/a/:token/replacement', async (request, reply) => {
    const view = await activationAuthorizations.recipientState(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (view.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (view.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    if (!view.replacementAvailable) {
      return reply.code(409).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view, '当前号码暂时不能更换，请继续等待。'));
    }
    return reply.type('text/html; charset=utf-8').send(replacementConfirmationPage(request.params.token));
  });

  app.post<{ Body: ReplacementBody; Params: { token: string } }>('/a/:token/replacement/confirm', async (request, reply) => {
    if (request.body?.replacement === 'wait') return reply.redirect(`/a/${request.params.token}`, 303);
    if (request.body?.replacement !== 'confirm') return reply.code(400).send();
    const result = await activationAuthorizations.requestNumberReplacement(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (result.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (result.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    const view = await activationAuthorizations.recipientState(request.params.token, request.cookies[RECIPIENT_COOKIE]);
    if (view.state === 'not-found') return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
    if (view.state === 'unavailable') return reply.code(409).type('text/html; charset=utf-8').send(unavailableRecipientPage());
    if (result.state === 'replaced') return reply.redirect(`/a/${request.params.token}`, 303);
    if (result.state === 'confirming') return reply.code(202).type('text/html; charset=utf-8').send(recipientPage(request.params.token, view));
    const message = result.state === 'too-early'
      ? '当前号码暂时不能更换，请继续等待。'
      : result.state === 'no-numbers'
        ? '当前暂无可用号码，请联系发送者'
        : '暂时无法更换号码，请联系发送者';
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

  const runBackgroundTasks = async (): Promise<void> => {
    await database.expireDueAuthorizations(dependencies.now?.() ?? new Date());
    await activationAuthorizations.reconcilePendingRequests();
    await activationAuthorizations.cancelAcquisitionsConfirmedAfterAuthorizationExpiry();
    // 超时收尾必须先于取消对账，避免刚到二十分钟的取消确认自动创建后继激活。
    await activationAuthorizations.reconcileTimedOutActivations();
    await activationAuthorizations.cancelRevokedActivations();
    await activationAuthorizations.reconcileCancellationConfirmations();
    await activationAuthorizations.runPendingReplacementAcquisitions();
    await activationAuthorizations.pollWaitingActivations();
    await activationAuthorizations.finishDeliveredActivations();
    await activationAuthorizations.deleteExpiredSensitiveDeliveryData();
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

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).type('text/plain; charset=utf-8').send('Not Found'));
  app.addHook('onClose', async () => {
    closing = true;
    clearInterval(expirationSweep);
    if (authorizationExpiryTimer) clearTimeout(authorizationExpiryTimer);
    if (revocationCancellationTimer) clearTimeout(revocationCancellationTimer);
    await database.close();
  });
  return app;
}
