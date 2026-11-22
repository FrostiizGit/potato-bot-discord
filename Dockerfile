# syntax=docker/dockerfile:1

# --- Build: compile TypeScript and the native Opus encoder ---
FROM node:24-slim AS build
WORKDIR /app
# Build tools for @discordjs/opus when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM denoland/deno:bin AS deno
# Static ffmpeg (~80 MB): Debian's package pulls ~400 MB of video/graphics libraries the bot never uses.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

# --- Runtime ---
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg

# deno: yt-dlp runs YouTube's JS challenges with it.
COPY --from=deno /deno /usr/local/bin/deno

# yt-dlp standalone build (Python included). YouTube breaks old versions, so stay on the latest:
# this checksum file is fetched on every build and only changes on a new release, which re-runs the download.
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS /tmp/yt-dlp-SHA2-256SUMS
RUN case "$(uname -m)" in \
      x86_64) f=yt-dlp_linux ;; \
      aarch64) f=yt-dlp_linux_aarch64 ;; \
      *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$f" \
 && echo "$(grep " $f\$" /tmp/yt-dlp-SHA2-256SUMS | cut -d' ' -f1)  /usr/local/bin/yt-dlp" | sha256sum -c - \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm /tmp/yt-dlp-SHA2-256SUMS \
 && yt-dlp --version

WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
