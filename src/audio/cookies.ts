import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * YouTube cookies for yt-dlp. YouTube asks datacenter IPs (VPS) to sign in ("Sign in to confirm you're not a
 * bot") and OAuth login no longer works with yt-dlp, so a signed-in session's cookies are the way through.
 * Uploaded with /youtube-cookies, stored in bot_settings, loaded at startup.
 */

/** bot_settings key. */
export const COOKIES_SETTING = 'youtube_cookies';

/** Only these cookies are kept, so a browser export with other sites in it never reaches yt-dlp or the database. */
const ALLOWED_DOMAIN = /(^|\.)(youtube|google)\.com$/;

export interface ParsedCookies {
  /** Netscape cookies.txt with only YouTube/Google cookies. */
  text: string;
  count: number;
  /** Cookies from other sites that were left out. */
  dropped: number;
}

/** Filters a Netscape cookies.txt down to YouTube/Google cookies. Throws if none are left. */
export function parseCookies(input: string): ParsedCookies {
  const kept: string[] = ['# Netscape HTTP Cookie File'];
  let dropped = 0;
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // "#HttpOnly_.youtube.com" lines are cookies; other "#" lines are comments.
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
    const fields = line.split('\t');
    const domain = fields[0]?.replace(/^#HttpOnly_/, '').replace(/^\./, '') ?? '';
    if (fields.length >= 7 && ALLOWED_DOMAIN.test(domain)) kept.push(line);
    else dropped++;
  }
  if (kept.length === 1) {
    throw new Error('No youtube.com cookies found. Export them as a Netscape cookies.txt file.');
  }
  return { text: `${kept.join('\n')}\n`, count: kept.length - 1, dropped };
}

let current: string | undefined;

/** Sets the cookies every following yt-dlp run uses (already parsed with parseCookies). Returns the previous ones. */
export function setYoutubeCookies(text: string | undefined): string | undefined {
  const previous = current;
  current = text;
  return previous;
}

export function hasYoutubeCookies(): boolean {
  return current !== undefined;
}

/**
 * yt-dlp arguments for the cookies, written into `dir` (a folder only this yt-dlp run uses: yt-dlp saves the
 * cookie jar back when it exits, so runs must not share a file). Empty when no cookies are set.
 */
export function cookieArgs(dir: string): string[] {
  if (!current) return [];
  const file = join(dir, 'cookies.txt');
  writeFileSync(file, current, { mode: 0o600 });
  return ['--cookies', file];
}
