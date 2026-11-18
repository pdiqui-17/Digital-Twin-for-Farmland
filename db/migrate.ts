import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { createLogger } from '@digital-twin/shared';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const logger = createLogger('db-runner');

function createPgClient(): Client {
  if (process.env.DATABASE_URL) {
    return new Client({ connectionString: process.env.DATABASE_URL });
  }

  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    throw new Error(
      'Missing POSTGRES_PASSWORD (or DATABASE_URL). Copy .env.example to .env and configure DB credentials.',
    );
  }

  return new Client({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    database: process.env.POSTGRES_DB ?? 'digital_twin_farm',
    user: process.env.POSTGRES_USER ?? 'twin_user',
    password,
  });
}

/**
 * Tách các câu lệnh SQL cấp cao nhất khi cần chạy ngoài transaction
 * (ví dụ: CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)).
 */
function splitSqlStatements(sql: string): string[] {
  const cleaned = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return cleaned
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

async function runMigrations(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.resolve(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await client.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      logger.info(`Skipping already applied migration: ${file}`);
      continue;
    }

    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const noTransaction = sql.trimStart().startsWith('-- no-transaction');

    logger.info(`Applying migration: ${file}`, { transactional: !noTransaction });

    if (noTransaction) {
      const statements = splitSqlStatements(sql);
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    } else {
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    logger.info(`Migration applied successfully: ${file}`);
  }
}

async function runSeeds(client: Client): Promise<void> {
  const seedDir = path.resolve(__dirname, 'seed');
  const files = fs
    .readdirSync(seedDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const fullPath = path.join(seedDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    logger.info(`Running seed file: ${file}`);

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    logger.info(`Seed completed: ${file}`);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'setup';
  if (!['up', 'seed', 'setup'].includes(mode)) {
    throw new Error(`Invalid mode "${mode}". Expected one of: up | seed | setup`);
  }

  const client = createPgClient();
  await client.connect();
  try {
    if (mode === 'up' || mode === 'setup') {
      await runMigrations(client);
    }
    if (mode === 'seed' || mode === 'setup') {
      await runSeeds(client);
    }
    logger.info(`Database task "${mode}" finished cleanly.`);
  } finally {
    await client.end();
  }
}

function formatError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
    return inner || err.stack || 'AggregateError';
  }
  if (err instanceof Error) {
    return err.message || err.stack || err.name;
  }
  return String(err);
}

main().catch((err) => {
  logger.error('Database task failed', {
    error: formatError(err),
  });
  process.exit(1);
});
