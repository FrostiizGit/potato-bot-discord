import { execFile, spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('yt-dlp');

/**
 * Audio-only formats first, Opus preferred (YouTube's 251 = Opus ~130k), over plain HTTPS.
 * HLS (m3u8) audio formats 403 on YouTube. `best` is a last resort for sites without
 * audio-only formats; ffmpeg drops the video with -vn.
 */
const FORMAT = 'bestaudio[acodec=opus][protocol^=http]/bestaudio[protocol^=http]/bestaudio/best';

/** YouTube stream URLs expire after ~6 h; past this age, re-extract instead of reusing the lookup. */
const INFO_MAX_AGE_MS = 3 * 60 * 60_000;

export interface TrackInfo {
  title: string;
  url: string;
  /** Seconds, undefined for live streams or unknown. */
  duration?: number;
  /** Trimmed yt-dlp info (chosen format only, ~2 KB) so playback can skip a second extraction. */
  info: string;
  resolvedAt: number;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Looks up a URL (YouTube, SoundCloud, direct link, ...) or searches YouTube for plain text. */
export async function resolveTrack(query: string): Promise<TrackInfo> {
  const target = isHttpUrl(query) ? query : `ytsearch1:${query}`;
  const started = Date.now();
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--no-playlist',
      '--no-warnings',
      '-f', FORMAT,
      '--dump-json',
      '--', // stop option parsing so user input can't be read as a flag
      target,
    ],
    { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const line = stdout.trim().split('\n')[0];
  if (!line) throw new Error(`No result for "${query}"`);
  const full = JSON.parse(line) as Record<string, unknown> & { formats?: { format_id: string }[] };

  // Keep just what yt-dlp needs to download the chosen format again.
  const slim: Record<string, unknown> = {};
  for (const key of ['id', 'title', 'webpage_url', 'extractor', 'extractor_key', 'duration', 'is_live', 'format_id', 'url', 'ext', 'http_headers']) {
    if (key in full) slim[key] = full[key];
  }
  if (full.formats) slim.formats = full.formats.filter((f) => f.format_id === full.format_id);

  const title = String(full.title ?? query);
  const url = String(full.webpage_url ?? query);
  const duration = typeof full.duration === 'number' ? full.duration : undefined;
  log.debug(`Resolved "${query}" → "${title}" (format ${String(full.format_id)}) in ${Date.now() - started} ms`);
  return { title, url, duration, info: JSON.stringify(slim), resolvedAt: Date.now() };
}

export interface AudioStream {
  /** Raw 48 kHz stereo s16le PCM, so the player can change volume on the fly. */
  stream: Readable;
  kill(): void;
}

/** yt-dlp downloads the audio, ffmpeg decodes it to PCM. */
export function createAudioStream(track: TrackInfo): AudioStream {
  let infoFile: string | undefined;
  let source: string[];
  if (Date.now() - track.resolvedAt < INFO_MAX_AGE_MS) {
    infoFile = join(tmpdir(), `potato-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(infoFile, track.info);
    source = ['--load-info-json', infoFile];
  } else {
    log.debug(`Info for "${track.title}" is stale, re-extracting`);
    source = ['--', track.url];
  }

  const ytdlp = spawn('yt-dlp', ['-f', FORMAT, '-o', '-', '--quiet', '--no-warnings', '--no-playlist', ...source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ffmpeg = spawn(
    'ffmpeg',
    ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);
  // Killing one side mid-stream causes EPIPE on the other; that's expected.
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.on('error', () => {});

  let killed = false;
  const forward = (name: string) => (chunk: Buffer) => {
    if (killed) return; // Broken pipe noise after a skip.
    for (const line of chunk.toString().split('\n')) if (line.trim()) log.warn(`${name}: ${line.trim()}`);
  };
  ytdlp.stderr.on('data', forward('yt-dlp'));
  ffmpeg.stderr.on('data', forward('ffmpeg'));
  ytdlp.on('error', (err) => log.error('yt-dlp failed to start:', err));
  ffmpeg.on('error', (err) => log.error('ffmpeg failed to start:', err));
  ytdlp.on('close', () => {
    if (infoFile) rmSync(infoFile, { force: true });
  });

  return {
    stream: ffmpeg.stdout,
    kill() {
      killed = true;
      ytdlp.kill('SIGKILL');
      ffmpeg.kill('SIGKILL');
    },
  };
}
