import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';

/** Create the test database if needed and apply migrations. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://carbooking:carbooking@localhost:5433/carbooking_test?schema=public');
  const dbName = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  admin.search = '';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  execSync('npx prisma migrate deploy', {
    cwd: resolve(import.meta.dirname, '../../../packages/db'),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
}
