# potato-bot-discord

Private Discord bot: audio playback (YouTube, SoundCloud, direct links and anything else yt-dlp supports) and, later, RPG mini games and accounts.

Stack: TypeScript, discord.js, `@discordjs/voice`, yt-dlp + ffmpeg, Postgres with Drizzle.

## Requirements

- Node.js 22+
- `yt-dlp`, `ffmpeg` and `deno` on your PATH (`brew install yt-dlp ffmpeg deno`). yt-dlp uses deno to solve YouTube's challenges. Keep yt-dlp updated: YouTube breaks old versions.
- Docker, for Postgres

## Setup

1. Create an application at https://discord.com/developers/applications, add a bot, and copy its token.
2. Invite it to your server: OAuth2 → URL Generator, scopes `bot` and `applications.commands`, permissions *Connect*, *Speak* and *Send Messages*.
3. Configure and start:

```bash
cp .env.example .env        # fill in the token, client ID and server ID
npm install
docker compose up -d        # Postgres on localhost:5442
npm run deploy-commands     # registers slash commands on your server
npm run dev                 # runs the bot and restarts on file changes
```

Database migrations run automatically when the bot starts.

## Logs

Every command is logged with the user and its options, and the player logs joins, tracks starting (with the start delay), finishing, skips, volume changes and leaving. Set `LOG_LEVEL=debug` in `.env` for lookup timings and more detail, or `warn` for less.

## Commands

| Command | What it does |
|---|---|
| `/ping` | Check the bot is alive |
| `/play <query>` | Play a URL, or search YouTube for the text |
| `/skip` | Skip the current track |
| `/queue` | Show the current track with progress, what's next, and the volume |
| `/volume [percent]` | Show the volume, or set it from 0 to 150 (100 = original level) |
| `/stop` | Clear the queue and leave the voice channel |

The bot leaves the voice channel after 5 minutes with nothing playing. Volume lasts until it leaves.

### How playback works

`/play` runs one yt-dlp lookup that picks an audio-only format (Opus when available) and keeps a trimmed copy of the result. When the track plays, yt-dlp reuses it instead of extracting again, ffmpeg decodes to raw PCM, and `@discordjs/voice` applies the volume and encodes Opus.

YouTube makes some stream URLs usable only a few seconds after they're issued, and yt-dlp waits for that ("Sleeping N seconds as required by the site"). So the first track in an empty queue can take a few seconds to start; queued tracks were looked up earlier and usually start in under a second.

## Scripts

| Script | |
|---|---|
| `npm run dev` | Run with auto-reload |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | Type-check without building |
| `npm run deploy-commands` | Register slash commands (rerun after adding or changing one) |
| `npm run db:generate` | Create a migration after changing `src/db/schema.ts` |
| `npm run db:studio` | Browse the database in Drizzle Studio |

## Layout

```
src/
  index.ts            client setup, interaction handling, shutdown
  env.ts              validated environment variables
  deploy-commands.ts  slash command registration
  commands/           one file per command (or group), listed in commands/index.ts
  audio/              yt-dlp wrapper and per-server player with a queue
  db/                 Drizzle schema, connection, account helpers
  games/              RPG and mini-game logic (keep it free of Discord code)
drizzle/              generated SQL migrations
```

## Adding a command

1. Create `src/commands/<name>.ts` exporting a `Command` (see `ping.ts`).
2. Add it to the list in `src/commands/index.ts`.
3. Run `npm run deploy-commands`.

## Accounts

Every user who runs a command gets a row in the `users` table (Discord ID, username, created and last seen times), via `ensureUser` in `src/db/users.ts`. Add RPG data in new tables that reference `users.id`.
