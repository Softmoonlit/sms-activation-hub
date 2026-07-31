import { Pool, type PoolClient } from 'pg';

export class Database {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        password_fingerprint TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        invalidated_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS admin_sessions_active_idx
        ON admin_sessions (expires_at)
        WHERE invalidated_at IS NULL;

      CREATE TABLE IF NOT EXISTS admin_login_attempts (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        source_fingerprint TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS admin_login_attempts_source_idx
        ON admin_login_attempts (source_fingerprint, attempted_at DESC);
    `);

    // 每次进程初始化都使旧 Cookie 失效，避免部署重启后保留管理权限。
    await this.pool.query('UPDATE admin_sessions SET invalidated_at = now() WHERE invalidated_at IS NULL');
  }

  async transaction<Result>(action: (client: PoolClient) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
