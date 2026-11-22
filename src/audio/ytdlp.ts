import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('yt-dlp');

/**
 * Audio-only formats first, Opus preferred (YouTube's 251 = Opus ~130k), over plain HTTPS.
 * HLS (m3u8) audio formats 403 on YouTube; SoundCloud only has HLS, which falls through to `bestaudio`.
 * `best` is a last resort for sites without audio-only formats; ffmpeg drops the video with -vn.
 */
const FORMAT = 'bestaudio[acodec=opus][protocol^=http]/bestaudio[protocol^=http]/bestaudio/best';

/** YouTube stream URLs expire after ~6 h; past this age, look the track up again before playing. */
const INFO_MAX_AGE_MS = 3 * 60 * 60_000;

/** Playlists (SoundCloud sets, YouTube playlists) are cut to this many tracks. */
export const MAX_PLAYLIST_TRACKS = 100;

export interface TrackInfo {
  title: string;
  url: string;
  /** Seconds, undefined for live streams or unknown. */
  duration?: number;
  thumbnail?: string;
  /** Trimmed yt-dlp info (chosen format only, ~3 KB) so playback skips a second extraction. Missing until looked up. */
  info?: string;
  resolvedAt?: number;
}

export interface ResolveResult {
  tracks: TrackInfo[];
  playlist?: {
    title: string;
    url: string;
    total: number;
    /** 1-based position the queue starts from, when the link pointed at a video inside the playlist. */
    startAt?: number;
  };
}

/** True for links to a video inside a playlist ("watch?v=X&list=Y"), which /play plays alone. */
export function isVideoInPlaylist(query: string): boolean {
  if (!isHttpUrl(query)) return false;
  const params = new URL(query).searchParams;
  return params.has('list') && params.has('v');
}

type YtdlpJson = Record<string, unknown> & {
  _type?: string;
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  duration?: number;
  thumbnail?: string;
  thumbnails?: { url: string }[];
  ie_key?: string;
  extractor_key?: string;
  format_id?: string;
  formats?: { format_id: string }[];
  entries?: (YtdlpJson | null)[];
  playlist_count?: number;
};

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** True when the track can start without another lookup. */
export function isReady(track: TrackInfo): boolean {
  return !!track.info && Date.now() - (track.resolvedAt ?? 0) < INFO_MAX_AGE_MS;
}

/** YouTube's `thumbnail` is often .webp at odd sizes; hqdefault.jpg always exists and looks right in embeds. */
function pickThumbnail(data: YtdlpJson): string | undefined {
  const site = data.extractor_key ?? data.ie_key;
  if (site === 'Youtube' && data.id) return `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`;
  return data.thumbnail ?? data.thumbnails?.at(-1)?.url;
}

/** SoundCloud set listings have no titles: "soundcloud.com/forss/city-ports" → "city ports" until looked up. */
function titleFromUrl(url: string): string {
  const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? url;
  return decodeURIComponent(slug).replace(/[-_]+/g, ' ');
}

async function ytdlpJson(args: string[]): Promise<YtdlpJson> {
  const { stdout } = await execFileAsync('yt-dlp', ['--no-warnings', '-f', FORMAT, ...args], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = stdout.trim().split('\n')[0];
  if (!line) throw new Error('yt-dlp returned nothing');
  return JSON.parse(line) as YtdlpJson;
}

/** Full lookup result → track with the trimmed info needed to play it. */
function toTrack(full: YtdlpJson, fallbackTitle: string): TrackInfo {
  const slim: Record<string, unknown> = {};
  for (const key of ['id', 'title', 'webpage_url', 'extractor', 'extractor_key', 'duration', 'is_live', 'format_id', 'url', 'ext', 'http_headers']) {
    if (key in full) slim[key] = full[key];
  }
  if (full.formats) slim.formats = full.formats.filter((f) => f.format_id === full.format_id);
  return {
    title: full.title ?? fallbackTitle,
    url: full.webpage_url ?? fallbackTitle,
    duration: typeof full.duration === 'number' ? full.duration : undefined,
    thumbnail: pickThumbnail(full),
    info: JSON.stringify(slim),
    resolvedAt: Date.now(),
  };
}

/** Full lookup of a single track URL. */
export async function lookupTrack(url: string): Promise<TrackInfo> {
  const started = Date.now();
  const full = await ytdlpJson(['--no-playlist', '--dump-json', '--', url]);
  const track = toTrack(full, url);
  log.debug(`Looked up "${track.title}" (format ${String(full.format_id)}) in ${Date.now() - started} ms`);
  return track;
}

/**
 * Turns what the user typed into tracks:
 * - plain text → YouTube search, first result
 * - track URL (YouTube, SoundCloud, direct link, ...) → that track
 * - playlist URL (SoundCloud set, YouTube playlist) → up to MAX_PLAYLIST_TRACKS tracks; only the first is
 *   looked up now, the player looks up the rest one at a time as they come next.
 * - video inside a playlist ("watch?v=X&list=Y") → just the video, or with `wholePlaylist` the playlist
 *   starting from that video, like YouTube does.
 */
export async function resolveQuery(query: string, { wholePlaylist = false } = {}): Promise<ResolveResult> {
  const started = Date.now();
  if (!isHttpUrl(query)) {
    const full = await ytdlpJson(['--dump-json', '--', `ytsearch1:${query}`]);
    const track = toTrack(full, query);
    log.debug(`Search "${query}" → "${track.title}" in ${Date.now() - started} ms`);
    return { tracks: [track] };
  }

  // The video the link points at inside a playlist, and roughly where (&index=3), so the listing reaches it.
  const params = new URL(query).searchParams;
  const startVideo = wholePlaylist ? params.get('v') : null;
  const startIndex = Math.max(1, Number(params.get('index')) || 1);

  // One call: full info for a single track, or a quick listing (no per-track lookups) for a playlist.
  // --no-playlist makes "watch?v=X&list=Y" links play just the video; --yes-playlist lists the playlist.
  const data = await ytdlpJson([
    '--dump-single-json',
    '--flat-playlist',
    wholePlaylist ? '--yes-playlist' : '--no-playlist',
    '--playlist-end', String(startVideo ? startIndex + MAX_PLAYLIST_TRACKS - 1 : MAX_PLAYLIST_TRACKS),
    '--', // stop option parsing so user input can't be read as a flag
    query,
  ]);
  if (data._type !== 'playlist') {
    const track = toTrack(data, query);
    log.debug(`Looked up "${track.title}" (format ${String(data.format_id)}) in ${Date.now() - started} ms`);
    return { tracks: [track] };
  }

  let entries = (data.entries ?? []).filter((e): e is YtdlpJson => !!e?.url);
  let startAt: number | undefined;
  if (startVideo) {
    const at = entries.findIndex((e) => e.id === startVideo);
    if (at > 0) {
      entries = entries.slice(at);
      startAt = at + 1;
    }
  }
  entries = entries.slice(0, MAX_PLAYLIST_TRACKS);
  if (entries.length === 0) throw new Error('Playlist is empty or private');
  const tracks: TrackInfo[] = entries.map((e) => ({
    title: e.title ?? titleFromUrl(e.url!),
    url: e.url!,
    duration: typeof e.duration === 'number' ? e.duration : undefined,
    thumbnail: pickThumbnail(e),
  }));
  log.debug(`Listed playlist "${data.title}" (${tracks.length} tracks) in ${Date.now() - started} ms`);

  // Look up the first playable track now so playback can start right away.
  for (let i = 0; i < tracks.length; i++) {
    try {
      tracks[i] = await lookupTrack(tracks[i]!.url);
      tracks.splice(0, i); // Drop leading tracks that can't play (removed, DRM, ...).
      break;
    } catch (err) {
      log.warn(`Skipping unplayable playlist track ${tracks[i]!.url}: ${errorMessage(err)}`);
      if (i === tracks.length - 1) throw new Error('No playable track in this playlist');
    }
  }

  return {
    tracks,
    playlist: {
      title: data.title ?? 'Playlist',
      url: data.webpage_url ?? query,
      total: data.playlist_count ?? tracks.length,
      startAt,
    },
  };
}

/** Readable reason from a failed yt-dlp run ("This video is DRM protected", ...). */
export function errorMessage(err: unknown): string {
  const stderr = (err as { stderr?: string })?.stderr;
  const text = stderr?.trim() || (err instanceof Error ? err.message : String(err));
  const line = text.split('\n').find((l) => l.includes('ERROR')) ?? text;
  return line
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[\w:]+\]\s*[^\s:]+:\s*/, '') // "[soundcloud:set] some/id: "
    .replace(/\s*\(caused by .*\)\s*$/, '')
    .trim();
}

export interface AudioStream {
  /** Raw 48 kHz stereo s16le PCM, so the player can change volume on the fly. */
  stream: Readable;
  kill(): void;
}

/** yt-dlp downloads the audio from a looked-up track, ffmpeg decodes it to PCM. */
export function createAudioStream(track: TrackInfo): AudioStream {
  if (!track.info) throw new Error(`"${track.title}" was not looked up`);
  // Own folder per stream: holds the info file, and HLS downloads (SoundCloud) write fragment files
  // to the working directory even with -o -. A killed yt-dlp leaves them behind, so the folder is removed after.
  const workDir = mkdtempSync(join(tmpdir(), 'potato-'));
  const infoFile = join(workDir, 'info.json');
  writeFileSync(infoFile, track.info);

  const ytdlp = spawn('yt-dlp', ['-f', FORMAT, '-o', '-', '--quiet', '--no-warnings', '--load-info-json', infoFile], {
    cwd: workDir,
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
  ytdlp.on('close', () => rmSync(workDir, { recursive: true, force: true }));

  return {
    stream: ffmpeg.stdout,
    kill() {
      killed = true;
      ytdlp.kill('SIGKILL');
      ffmpeg.kill('SIGKILL');
      rmSync(workDir, { recursive: true, force: true }); // Also on shutdown, when 'close' may never run.
    },
  };
}
