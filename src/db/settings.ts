import { eq, sql } from 'drizzle-orm';
import { db } from './index.js';
import { botSettings } from './schema.js';

export async function getSetting(key: string): Promise<string | undefined> {
  const [row] = await db.select({ value: botSettings.value }).from(botSettings).where(eq(botSettings.key, key));
  return row?.value;
}

export async function setSetting(key: string, value: string, updatedBy: string): Promise<void> {
  await db
    .insert(botSettings)
    .values({ key, value, updatedBy })
    .onConflictDoUpdate({ target: botSettings.key, set: { value, updatedBy, updatedAt: sql`now()` } });
}
