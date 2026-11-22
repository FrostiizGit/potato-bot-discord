import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('cookies');

/** Only these cookies are kept, so a browser export with other sites in it never reaches yt-dlp. */
const ALLOWED_DOMAIN = /(^|\.)(youtube|google)\.com$/;

/**
 * YouTube cookies for yt-dlp, from YOUTUBE_COOKIES: a Netscape cookies.txt file, base64-encoded so it fits
 * in one env var (`base64 -i cookies.txt`). YouTube asks datacenter IPs (VPS) to sign in; these cookies do.
 */
function loadCookies(): string | undefined {
  const raw = process.env.YOUTUBE_COOKIES?.trim();
  if (!raw) return undefined;

  const text = raw.startsWith('#') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const lines = text.split(/\r?\n/);
  const kept: string[] = ['# Netscape HTTP Cookie File'];
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // "#HttpOnly_.youtube.com" lines are cookies; other "#" lines are comments.
    const isCookie = !line.startsWith('#') || line.startsWith('#HttpOnly_');
    if (!isCookie) continue;
    const fields = line.split('\t');
    const domain = fields[0]?.replace(/^#HttpOnly_/, '').replace(/^\./, '') ?? '';
    if (fields.length >= 7 && ALLOWED_DOMAIN.test(domain)) kept.push(line);
    else dropped++;
  }

  if (kept.length === 1) {
    log.warn('YOUTUBE_COOKIES is set but has no youtube.com cookies (expected a base64 Netscape cookies.txt): ignoring it');
    return undefined;
  }
  log.info(`Using ${kept.length - 1} YouTube cookies for yt-dlp${dropped ? ` (${dropped} from other sites ignored)` : ''}`);
  return `${kept.join('\n')}\n`;
}

const cookies = loadCookies();

export const hasYoutubeCookies = cookies !== undefined;

/**
 * yt-dlp arguments for the cookies, written into `dir` (a folder only this yt-dlp run uses: yt-dlp saves the
 * cookie jar back when it exits, so runs must not share a file). Empty when no cookies are configured.
 */
export function cookieArgs(dir: string): string[] {
  if (!cookies) return [];
  const file = join(dir, 'cookies.txt');
  writeFileSync(file, cookies, { mode: 0o600 });
  return ['--cookies', file];
}
