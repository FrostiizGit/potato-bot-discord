import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { createLogger, type Logger } from '../logger.js';
import { createAudioStream, type AudioStream, type TrackInfo } from './ytdlp.js';

export interface Track extends TrackInfo {
  requestedBy: { id: string; username: string };
}

/** Leave the voice channel after this long with nothing playing. */
const IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_VOLUME = 100;
export const MAX_VOLUME = 150;

const players = new Map<string, GuildPlayer>();

export class GuildPlayer {
  readonly queue: Track[] = [];
  current: Track | undefined;
  /** Percent, 0–MAX_VOLUME. Kept for the whole session in this server. */
  volume = DEFAULT_VOLUME;

  private readonly audio: AudioPlayer;
  private readonly log: Logger;
  private resource: AudioResource | undefined;
  private stream: AudioStream | undefined;
  private requestedAt = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private destroyed = false;

  private constructor(
    readonly guildId: string,
    private readonly connection: VoiceConnection,
    channelName: string,
  ) {
    this.log = createLogger(`player:${channelName}`);
    this.audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(this.audio);

    this.audio.on(AudioPlayerStatus.Playing, (old) => {
      if (old.status === AudioPlayerStatus.Buffering && this.current) {
        this.log.info(`Started "${this.current.title}" after ${Date.now() - this.requestedAt} ms`);
      }
    });
    this.audio.on(AudioPlayerStatus.Idle, () => {
      if (this.current) this.log.info(`Finished "${this.current.title}"`);
      this.playNext();
    });
    this.audio.on('error', (err) => {
      this.log.error(`Playback error on "${this.current?.title}": ${err.message}`);
      // Idle fires right after, which moves on to the next track.
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved to another channel: Discord reconnects by itself.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        this.log.info('Moved to another voice channel');
      } catch {
        this.log.warn('Disconnected from voice (kicked or channel deleted)');
        this.destroy();
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => this.destroy());
  }

  static get(guildId: string): GuildPlayer | undefined {
    return players.get(guildId);
  }

  /** Returns the server's player, joining the channel if needed. */
  static async join(channel: VoiceBasedChannel): Promise<GuildPlayer> {
    const existing = players.get(channel.guild.id);
    if (existing) return existing;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy();
      throw err;
    }
    const player = new GuildPlayer(channel.guild.id, connection, channel.name);
    players.set(channel.guild.id, player);
    player.log.info(`Joined voice channel #${channel.name}`);
    return player;
  }

  get channelId(): string | null {
    return this.connection.joinConfig.channelId;
  }

  /** Seconds into the current track. */
  get elapsed(): number {
    return (this.resource?.playbackDuration ?? 0) / 1000;
  }

  /** Adds a track; starts playing if nothing is. Returns its position in the queue (0 = now playing). */
  enqueue(track: Track): number {
    this.queue.push(track);
    if (!this.current) {
      this.playNext();
      return 0;
    }
    this.log.info(`Queued "${track.title}" at position ${this.queue.length} (by ${track.requestedBy.username})`);
    return this.queue.length;
  }

  skip(by: string): void {
    this.log.info(`Skipped "${this.current?.title}" (by ${by})`);
    this.current = undefined; // So Idle doesn't also log it as finished.
    this.audio.stop(true); // Triggers Idle -> playNext
  }

  setVolume(percent: number, by: string): void {
    this.volume = percent;
    this.resource?.volume?.setVolume(percent / 100);
    this.log.info(`Volume set to ${percent}% (by ${by})`);
  }

  destroy(reason?: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    players.delete(this.guildId);
    clearTimeout(this.idleTimer);
    this.queue.length = 0;
    this.current = undefined;
    this.stream?.kill();
    this.audio.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    this.log.info(`Left voice channel${reason ? ` (${reason})` : ''}`);
  }

  private playNext(): void {
    if (this.destroyed) return;
    this.stream?.kill();
    this.stream = undefined;
    this.resource = undefined;
    clearTimeout(this.idleTimer);

    this.current = this.queue.shift();
    if (!this.current) {
      this.log.debug(`Queue empty, leaving in ${IDLE_TIMEOUT_MS / 60_000} min if nothing is added`);
      this.idleTimer = setTimeout(() => this.destroy('idle'), IDLE_TIMEOUT_MS);
      return;
    }

    this.log.info(`Now playing "${this.current.title}" (requested by ${this.current.requestedBy.username})`);
    this.requestedAt = Date.now();
    this.stream = createAudioStream(this.current);
    this.resource = createAudioResource(this.stream.stream, { inputType: StreamType.Raw, inlineVolume: true });
    this.resource.volume?.setVolume(this.volume / 100);
    this.audio.play(this.resource);
  }
}

export function destroyAllPlayers(): void {
  for (const player of players.values()) player.destroy('shutdown');
}
