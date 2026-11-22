import { ping } from './ping.js';
import { play, queue, skip, stop, volume } from './music.js';
import type { Command } from './types.js';

const list: Command[] = [ping, play, skip, stop, queue, volume];

export const commands = new Map(list.map((c) => [c.data.name, c]));
