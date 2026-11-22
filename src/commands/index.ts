import { ping } from './ping.js';
import { play, playlist, queue, skip, stop, volume } from './music.js';
import type { Command } from './types.js';
import { youtubeCookies } from './youtubeCookies.js';

const list: Command[] = [ping, play, playlist, skip, stop, queue, volume, youtubeCookies];

export const commands = new Map(list.map((c) => [c.data.name, c]));
