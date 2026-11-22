import { ping } from './ping.js';
import { play, queue, skip, stop } from './music.js';
import type { Command } from './types.js';

const list: Command[] = [ping, play, skip, stop, queue];

export const commands = new Map(list.map((c) => [c.data.name, c]));
