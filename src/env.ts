import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  /** Base64 Netscape cookies.txt for YouTube, needed on servers YouTube asks to sign in. Read in audio/cookies.ts. */
  YOUTUBE_COOKIES: z.string().optional(),
  /** Health check port (Stalagmite's --port). */
  PORT: z.coerce.number().int().positive().default(3000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment, check your .env file:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
