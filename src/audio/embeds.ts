import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { Track } from './player.js';

const COLOR_PLAYING = 0x5865f2;
const COLOR_QUEUED = 0x57f287;

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return 'live';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Discord shows brackets inside link text as-is when they come in simple pairs ("[Non-Stop-Pop FM]"),
 * and shows backslashes if they're escaped. Unpaired or nested brackets would break the link, so only
 * those get swapped for parentheses.
 */
function safeBrackets(text: string): string {
  let depth = 0;
  for (const ch of text) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (depth < 0 || depth > 1) return text.replace(/\[/g, '(').replace(/\]/g, ')');
  }
  return depth === 0 ? text : text.replace(/\[/g, '(').replace(/\]/g, ')');
}

/** Title as a Markdown link; `*`, `_` and friends are escaped so they show as typed. */
export function link(title: string, url: string): string {
  const text = title.length > 200 ? `${title.slice(0, 199)}…` : title;
  return `[${safeBrackets(escapeMarkdown(text))}](${url})`;
}

function sourceName(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^(www|m|music)\./, '');
  } catch {
    return 'link';
  }
  if (host.includes('youtube') || host === 'youtu.be') return 'YouTube';
  if (host.includes('soundcloud')) return 'SoundCloud';
  return host;
}

/** Bottom line: the requester's avatar sits right before their name. Discord only allows the icon at the start. */
function requesterFooter(track: Track) {
  const text = `Requested by ${track.requestedBy.username}`;
  return track.requestedBy.avatarUrl ? { text, iconURL: track.requestedBy.avatarUrl } : { text };
}

/**
 * One track, thumbnail on the right:
 *   Now playing                          <- small top line
 *   GTA V Radio [...] Gimme More         <- big linked title
 *   4:35 · YouTube · Position 2 in queue
 *   (avatar) Requested by alice          <- small footer
 */
export function trackEmbed(track: Track, position: number): EmbedBuilder {
  const playing = position === 0;
  const details = [`**${formatDuration(track.duration)}**`, sourceName(track.url)];
  if (!playing) details.push(`Position ${position} in queue`);
  const embed = new EmbedBuilder()
    .setColor(playing ? COLOR_PLAYING : COLOR_QUEUED)
    .setAuthor({ name: playing ? 'Now playing' : 'Added to queue' })
    .setTitle(track.title.slice(0, 256)) // Titles are plain text: brackets and * show as-is.
    .setURL(track.url)
    .setDescription(details.join(' · '))
    .setFooter(requesterFooter(track));
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

export interface PlaylistSummary {
  title: string;
  url: string;
  /** Tracks in the whole playlist, when yt-dlp knows. */
  total: number;
  /** 1-based position the queue starts from, when the link pointed at a video inside the playlist. */
  startAt?: number;
}

/**
 * Same layout for a playlist. `position` is where its first track landed (0 = playing now):
 *   Added playlist
 *   Non-Stop-Pop FM - GTA V Radio        <- big linked title
 *   34 tracks, from #3 of 36 · 2:25:28 · YouTube
 *   Now playing: [Gimme More](url) · 4:35
 *   (avatar) Requested by alice
 */
export function playlistEmbed(playlist: PlaylistSummary, tracks: Track[], position: number): EmbedBuilder {
  const first = tracks[0]!;
  let count = `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
  if (playlist.startAt && playlist.startAt > 1) count += `, from #${playlist.startAt} of ${playlist.total}`;
  else if (playlist.total > tracks.length) count += ` of ${playlist.total}`;
  const details = [`**${count}**`];
  // SoundCloud set listings have no durations until each track is looked up, so only show a total when all are known.
  if (tracks.every((t) => t.duration !== undefined)) {
    details.push(formatDuration(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0)));
  }
  details.push(sourceName(playlist.url));
  const start = position === 0 ? 'Now playing' : `Starts at position ${position}`;
  const embed = new EmbedBuilder()
    .setColor(position === 0 ? COLOR_PLAYING : COLOR_QUEUED)
    .setAuthor({ name: 'Added playlist' })
    .setTitle(playlist.title.slice(0, 256))
    .setURL(playlist.url)
    .setDescription(
      [details.join(' · '), `${start}: ${link(first.title, first.url)} · ${formatDuration(first.duration)}`].join('\n'),
    )
    .setFooter(requesterFooter(first));
  if (first.thumbnail) embed.setThumbnail(first.thumbnail);
  return embed;
}
