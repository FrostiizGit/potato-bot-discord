import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('cookies');

/** Only these cookies are kept, so a browser export with other sites in it never reaches yt-dlp. */
const ALLOWED_DOMAIN = /(^|\.)(youtube|google)\.com$/;

/**
 * A copied `Cookie` request header ("SID=…; HSID=…; …", from DevTools → Network on youtube.com) as
 * cookies.txt lines. The header has no domain/expiry, so they're set for .youtube.com and a year ahead.
 */
function headerToNetscape(header: string): string {
  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const lines: string[] = [];
  for (const part of header.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', String(expires), pair.slice(0, eq), pair.slice(eq + 1)].join('\t'));
  }
  return lines.join('\n');
}

/**
 * YouTube cookies for yt-dlp, from YOUTUBE_COOKIES. YouTube asks datacenter IPs (VPS) to sign in; these cookies do.
 * Accepts, on one line:
 * - the `Cookie` request header copied from DevTools (optionally with its "cookie:" prefix)
 * - a Netscape cookies.txt file, base64-encoded (`base64 -i cookies.txt`)
 */
function loadCookies(): string | undefined {
  const raw = process.env.YOUTUBE_COOKIES?.trim().replace(/^cookie:\s*/i, '');
  if (!raw) return undefined;

  let text: string;
  let format: string;
  if (raw.startsWith('#') || raw.includes('\t')) {
    text = raw;
    format = 'cookies.txt';
  } else if (/=[^=]/.test(raw)) {
    // "name=value": base64 only has "=" as trailing padding, so an "=" followed by anything else is a header.
    text = headerToNetscape(raw);
    format = 'Cookie header';
  } else {
    text = Buffer.from(raw, 'base64').toString('utf8');
    format = 'base64 cookies.txt';
  }

  const kept: string[] = ['# Netscape HTTP Cookie File'];
  let dropped = 0;
  for (const line of text.split(/\r?\n/)) {
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
    log.warn(`YOUTUBE_COOKIES is set but has no youtube.com cookies (read as ${format}): ignoring it`);
    return undefined;
  }
  const ignored = dropped ? ` (${dropped} from other sites ignored)` : '';
  log.info(`Using ${kept.length - 1} YouTube cookies for yt-dlp, from a ${format}${ignored}`);
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
