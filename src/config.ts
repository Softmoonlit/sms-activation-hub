import { createHash, randomBytes } from 'node:crypto';

const COMMON_ADMIN_PATHS = new Set([
  'admin',
  'admin1',
  'administrator',
  'backend',
  'cpanel',
  'controlpanel',
  'dashboard',
  'login',
  'manage',
  'phpmyadmin',
  'portal',
  'siteadmin',
  'sysadmin',
  'webadmin',
  'wpadmin',
]);

export interface AppConfig {
  adminPassword: string;
  adminPath: string;
  databaseUrl: string;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
  port: number;
  publicOrigin: string;
  sessionSecret: string;
  trustedProxy: false | string[];
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new Error(`缺少必需环境变量 ${name}`);
  }
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return Number(value);
}

export function readConfig(environment = process.env): AppConfig {
  const adminPath = required(environment, 'ADMIN_PATH');
  if (!/^[A-Za-z0-9]{6,12}$/.test(adminPath)) {
    throw new Error('ADMIN_PATH 必须是 6 至 12 位字母或数字');
  }
  if (COMMON_ADMIN_PATHS.has(adminPath.toLowerCase())) {
    throw new Error('ADMIN_PATH 不能使用常见后台名称');
  }

  const sessionSecret = required(environment, 'SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET 至少需要 32 个字符');
  }

  const trustedProxy = environment.TRUSTED_PROXY?.split(',').map((address) => address.trim()).filter(Boolean) ?? [];
  if (environment.NODE_ENV === 'production' && trustedProxy.length === 0) {
    throw new Error('生产环境必须配置 TRUSTED_PROXY');
  }

  return {
    adminPassword: required(environment, 'ADMIN_PASSWORD'),
    adminPath,
    databaseUrl: required(environment, 'DATABASE_URL'),
    loginMaxAttempts: positiveInteger(environment.LOGIN_MAX_ATTEMPTS, 5, 'LOGIN_MAX_ATTEMPTS'),
    loginWindowSeconds: positiveInteger(environment.LOGIN_WINDOW_SECONDS, 900, 'LOGIN_WINDOW_SECONDS'),
    port: positiveInteger(environment.PORT, 3000, 'PORT'),
    publicOrigin: required(environment, 'PUBLIC_ORIGIN'),
    sessionSecret,
    trustedProxy: trustedProxy.length > 0 ? trustedProxy : false,
  };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
