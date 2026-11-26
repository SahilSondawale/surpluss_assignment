import { DataSource } from 'typeorm';
import { migrations } from './migrations/index.js';

// Load .env when running locally. In Docker there is no .env file and the
// variables come from docker-compose instead, so a missing file is fine.
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

// Used by the TypeORM command-line tool (npm run migration:run etc.),
// which runs outside of NestJS.
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  migrations,
});
