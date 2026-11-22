# potato-bot-discord

Private Discord bot: audio playback (YouTube, SoundCloud, direct links and anything else yt-dlp supports) and, later, RPG mini games and accounts.

Stack: TypeScript, discord.js, `@discordjs/voice`, yt-dlp + ffmpeg, Postgres with Drizzle.

## Requirements

- Node.js 22+
- `yt-dlp`, `ffmpeg` and `deno` on your PATH (`brew install yt-dlp ffmpeg deno`). yt-dlp uses deno to solve YouTube's challenges. Keep yt-dlp updated: YouTube breaks old versions.
- Docker and the Stalagmite CLI, for the local Postgres

## Setup

1. Create an application at https://discord.com/developers/applications, add a bot, and copy its token.
2. Invite it to your server: OAuth2 → URL Generator, scopes `bot` and `applications.commands`, permissions *Connect*, *Speak*, *Send Messages* and *Embed Links*.
3. Configure and start:

```bash
cp .env.example .env        # fill in the token, client ID and server ID
npm install
stalagmite db create local potato-local --engine postgres --memory 256
stalagmite db url local potato-local   # put this in .env as DATABASE_URL
npm run deploy-commands     # registers slash commands on your server
npm run dev                 # runs the bot and restarts on file changes
```

Database migrations run automatically when the bot starts. `--memory 256` is a cap, not a reservation: an idle Postgres uses about 60 MB. On a server, `stalagmite db create <server> potato-db --engine postgres --memory 256` and `stalagmite db link <server> potato-db <app>` set `DATABASE_URL` for you.

## Logs

Every command is logged with the user and its options, and the player logs joins, tracks starting (with the start delay), finishing, skips, volume changes and leaving. Set `LOG_LEVEL=debug` in `.env` for lookup timings and more detail, or `warn` for less.

## Commands

| Command | What it does |
|---|---|
| `/ping` | Check the bot is alive |
| `/play <query>` | Play a track or playlist URL (YouTube, SoundCloud, direct links, …), or search YouTube for the text |
| `/playlist <url>` | Queue a whole playlist. Also takes a link to a video inside a playlist (`watch?v=…&list=…`) and starts at that video |
| `/skip` | Skip the current track |
| `/queue` | Show the current track with progress, what's next, and the volume |
| `/volume [percent]` | Show the volume, or set it from 0 to 150 (100 = original level) |
| `/stop` | Clear the queue and leave the voice channel |

The bot leaves the voice channel after 5 minutes with nothing playing. Volume lasts until it leaves.

### How playback works

`/play` replies with a compact embed: "Now playing: <linked title>" with the thumbnail beside it, and a small footer with the requester's avatar, duration, requester and queue position. `/play` on a video link that belongs to a playlist plays only that video and suggests `/playlist`. When a queued track starts, the bot posts a "Now playing" embed in the channel where it was last asked to play.

`/play` runs one yt-dlp lookup that picks an audio-only format (Opus when available) and keeps a trimmed copy of the result. When the track plays, yt-dlp reuses it instead of extracting again, ffmpeg decodes to raw PCM, and `@discordjs/voice` applies the volume and encodes Opus.

YouTube makes some stream URLs usable only a few seconds after they're issued, and yt-dlp waits for that ("Sleeping N seconds as required by the site"). So the first track in an empty queue can take a few seconds to start; queued tracks were looked up earlier and usually start in under a second.

Playlists (YouTube playlists, SoundCloud sets) are listed without looking up each track, up to 100 tracks, and only the first is looked up right away. While a track plays, the player looks up the next one in the background, so it's ready when its turn comes. Tracks that turn out unplayable (removed, private, DRM protected) are skipped with a message. SoundCloud set listings have no titles, so those tracks show their link name in `/queue` until they're looked up.

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

## Deploying with Stalagmite

The `Dockerfile` builds the bot with ffmpeg (static build), yt-dlp and deno included. The bot serves `GET /health` on `$PORT` (default 3000): `503` until it's logged in to Discord, then `200`, so a release that can't log in never takes over. Migrations run when the bot starts, so no release command is needed.

First deploy (the domain only serves the health check, but Stalagmite needs one; its DNS must point at the server first):

```bash
stalagmite db create <server> potato-db --engine postgres --memory 256
stalagmite app create <server> potato-bot --repo git@github.com:FrostiizGit/potato-bot-discord.git \
  --domain potato.<your-domain> --port 3000 --health /health
stalagmite db link <server> potato-db potato-bot          # sets DATABASE_URL
stalagmite env set <server> potato-bot DISCORD_TOKEN DISCORD_CLIENT_ID DISCORD_GUILD_ID
stalagmite deploy <server> potato-bot
stalagmite exec <server> potato-bot -- node dist/deploy-commands.js   # register slash commands
```

Rerun the last command whenever commands are added or changed. Other things to know:

- **yt-dlp updates:** each build fetches the checksum file of the latest yt-dlp release and downloads yt-dlp again when it changed. If YouTube playback breaks, redeploy to pick up a fix.
- **During a deploy** the old and new bot run side by side for about 3 seconds, so a command sent right then may get two replies. The music queue lives in memory and is cleared by a deploy.
- **One token, one bot:** with the same token locally and on the server, both answer every command. Stop the local bot, or use a second Discord application for development.
