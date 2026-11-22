import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
export const db = drizzle({ client: pool, schema });

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: 'drizzle' });
}
