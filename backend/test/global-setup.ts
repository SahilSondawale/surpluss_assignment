import pg from 'pg';
import { DataSource } from 'typeorm';
import { migrations } from '../src/database/migrations/index.js';
import { TEST_DATABASE_URL } from './helpers.js';

/**
 * Runs once before all integration tests:
 * creates the test database if needed, then applies the migrations.
 */
export default async function setup(): Promise<void> {
  const testUrl = new URL(TEST_DATABASE_URL);
  const databaseName = testUrl.pathname.slice(1);

  // Connect to the default "postgres" database to create the test database.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  }
  await admin.end();

  const dataSource = new DataSource({ type: 'postgres', url: TEST_DATABASE_URL, migrations });
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
