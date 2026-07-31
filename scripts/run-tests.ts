import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import 'dotenv/config';
import { Client } from 'pg';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveTestDatabaseAdminUrl(environment: NodeJS.ProcessEnv): string {
  const explicitUrl = environment.TEST_DATABASE_ADMIN_URL;
  if (explicitUrl) return validatePostgresUrl(explicitUrl, 'TEST_DATABASE_ADMIN_URL');

  const applicationUrl = environment.DATABASE_URL;
  if (!applicationUrl) {
    throw new Error('运行完整测试需要设置 TEST_DATABASE_ADMIN_URL；本地回环地址也可复用 DATABASE_URL');
  }

  const parsed = new URL(validatePostgresUrl(applicationUrl, 'DATABASE_URL'));
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('拒绝使用非本地 DATABASE_URL 创建测试数据库；请显式设置 TEST_DATABASE_ADMIN_URL');
  }
  return parsed.toString();
}

function validatePostgresUrl(value: string, variableName: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${variableName} 必须是 PostgreSQL 连接字符串`);
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error(`${variableName} 必须包含数据库名称`);
  }
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function runNodeTests(testDatabaseUrl: string): Promise<number> {
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--test', '--test-concurrency=1', 'test/**/*.test.ts',
  ], {
    env: { ...process.env, TEST_DATABASE_URL: testDatabaseUrl },
    stdio: 'inherit',
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`测试进程被信号 ${signal} 终止`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function main(): Promise<number> {
  const adminUrl = resolveTestDatabaseAdminUrl(process.env);
  const maintenanceUrl = databaseUrl(adminUrl, 'postgres');
  const testDatabaseName = `sms_website_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const testDatabaseUrl = databaseUrl(adminUrl, testDatabaseName);
  const client = new Client({ connectionString: maintenanceUrl });

  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
    console.log(`已创建隔离测试数据库：${testDatabaseName}`);
    return await runNodeTests(testDatabaseUrl);
  } finally {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)} WITH (FORCE)`);
    await client.end();
    console.log(`已删除隔离测试数据库：${testDatabaseName}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
