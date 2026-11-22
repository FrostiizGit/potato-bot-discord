import { execFile, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TrackInfo {
  title: string;
  url: string;
  /** Seconds, undefined for live streams or unknown. */
  duration?: number;
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
  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
      '--print', '%(title)s',
      '--print', '%(webpage_url)s',
      '--print', '%(duration)s',
      '--', // stop option parsing so user input can't be read as a flag
      target,
    ],
    { timeout: 30_000 },
  );
  const [title, url, duration] = stdout.trim().split('\n');
  if (!title || !url) throw new Error(`No result for "${query}"`);
  const seconds = Number(duration);
  return { title, url, duration: Number.isFinite(seconds) ? seconds : undefined };
}

export interface AudioStream {
  /** Ogg Opus, ready for Discord without re-encoding in Node. */
  stream: Readable;
  kill(): void;
}

/** yt-dlp downloads the best audio, ffmpeg turns it into 48 kHz Ogg Opus. */
export function createAudioStream(url: string): AudioStream {
  const ytdlp = spawn(
    'yt-dlp',
    ['-f', 'bestaudio[protocol^=http]/bestaudio/best', '-o', '-', '--no-playlist', '--quiet', '--no-warnings', '--', url],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '96k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);
  // Killing one side mid-stream causes EPIPE on the other; that's expected.
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.on('error', () => {});
  ytdlp.on('error', (err) => console.error('yt-dlp failed to start:', err));
  ffmpeg.on('error', (err) => console.error('ffmpeg failed to start:', err));

  return {
    stream: ffmpeg.stdout,
    kill() {
      ytdlp.kill('SIGKILL');
      ffmpeg.kill('SIGKILL');
    },
  };
}
