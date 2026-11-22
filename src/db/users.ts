import type { User as DiscordUser } from 'discord.js';
import { sql } from 'drizzle-orm';
import { db } from './index.js';
import { users, type User } from './schema.js';

/** Creates the account on first use, otherwise refreshes username and last seen time. */
export async function ensureUser(discordUser: DiscordUser): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ discordId: discordUser.id, username: discordUser.username })
    .onConflictDoUpdate({
      target: users.discordId,
      set: { username: discordUser.username, lastSeenAt: sql`now()` },
    })
    .returning();
  return user!;
}
