import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';

import { fingerprint, randomToken, type AppConfig } from './config.js';
import { Database } from './database.js';

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AdminSession {
  csrfToken: string;
  id: string;
}

export class LoginRateLimitedError extends Error {
  constructor() {
    super('登录尝试过于频繁');
  }
}

export class AdminAuthentication {
  constructor(
    private readonly config: AppConfig,
    private readonly database: Database,
  ) {}

  async createSession(password: string, sourceAddress: string): Promise<AdminSession | undefined> {
    const sourceFingerprint = this.sourceFingerprint(sourceAddress);
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('admin-single-session'))");
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sourceFingerprint]);
      const permitted = await this.canAttemptLogin(client, sourceFingerprint);
      if (!permitted) {
        throw new LoginRateLimitedError();
      }

      if (!this.passwordMatches(password)) {
        await client.query(
          'INSERT INTO admin_login_attempts (source_fingerprint) VALUES ($1)',
          [sourceFingerprint],
        );
        return undefined;
      }

      const session = { csrfToken: randomToken(), id: randomToken() };
      await client.query('UPDATE admin_sessions SET invalidated_at = now() WHERE invalidated_at IS NULL');
      await client.query(
        `INSERT INTO admin_sessions (id, csrf_token, password_fingerprint, expires_at)
         VALUES ($1, $2, $3, now() + interval '30 days')`,
        [session.id, session.csrfToken, fingerprint(this.config.adminPassword)],
      );
      return session;
    });
  }

  async sessionFor(id: string | undefined): Promise<AdminSession | undefined> {
    if (!id) {
      return undefined;
    }
    const result = await this.database.pool.query<{ id: string; csrf_token: string }>(
      `SELECT id, csrf_token
       FROM admin_sessions
       WHERE id = $1
         AND invalidated_at IS NULL
         AND expires_at > now()
         AND password_fingerprint = $2`,
      [id, fingerprint(this.config.adminPassword)],
    );
    const row = result.rows[0];
    return row ? { id: row.id, csrfToken: row.csrf_token } : undefined;
  }

  async revokeSession(id: string): Promise<void> {
    await this.database.pool.query(
      'UPDATE admin_sessions SET invalidated_at = now() WHERE id = $1 AND invalidated_at IS NULL',
      [id],
    );
  }

  private async canAttemptLogin(client: PoolClient, sourceFingerprint: string): Promise<boolean> {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)
       FROM admin_login_attempts
       WHERE source_fingerprint = $1
         AND attempted_at > now() - ($2::text || ' seconds')::interval`,
      [sourceFingerprint, this.config.loginWindowSeconds],
    );
    return Number(result.rows[0]?.count ?? 0) < this.config.loginMaxAttempts;
  }

  private passwordMatches(candidate: string): boolean {
    const expected = this.passwordDigest(this.config.adminPassword);
    const actual = this.passwordDigest(candidate);
    return timingSafeEqual(expected, actual);
  }

  private passwordDigest(value: string): Buffer {
    return createHmac('sha256', this.config.sessionSecret).update(value).digest();
  }

  private sourceFingerprint(sourceAddress: string): string {
    return fingerprint(`${this.config.sessionSecret}:${sourceAddress}:administrator`);
  }
}

export const ADMIN_SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_SECONDS;
