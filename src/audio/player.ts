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
import type { SendableChannels, VoiceBasedChannel } from 'discord.js';
import { createLogger, type Logger } from '../logger.js';
import { trackEmbed } from './embeds.js';
import { createAudioStream, errorMessage, isReady, lookupTrack, type AudioStream, type TrackInfo } from './ytdlp.js';

export interface Track extends TrackInfo {
  requestedBy: { id: string; username: string; avatarUrl?: string };
}

/** Leave the voice channel after this long with nothing playing. */
const IDLE_TIMEOUT_MS = 5 * 60_000;
/**
 * Give up on a track that hasn't produced audio after this long (e.g. a download stuck in yt-dlp's
 * retries) and move on, instead of sitting silent until someone runs /skip. Covers YouTube's start delay.
 */
export const START_TIMEOUT_MS = 30_000;
export const DEFAULT_VOLUME = 100;
export const MAX_VOLUME = 150;

const players = new Map<string, GuildPlayer>();

export class GuildPlayer {
  readonly queue: Track[] = [];
  current: Track | undefined;
  /** Percent, 0–MAX_VOLUME. Kept for the whole session in this server. */
  volume = DEFAULT_VOLUME;
  /** Where "Now playing" messages go for tracks that start from the queue. Set by /play. */
  textChannel: SendableChannels | undefined;

  private readonly audio: AudioPlayer;
  private readonly log: Logger;
  private resource: AudioResource | undefined;
  private stream: AudioStream | undefined;
  private requestedAt = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private destroyed = false;
  /** Bumped on every playNext, so a slow lookup that finishes after a skip doesn't start the old track. */
  private playToken = 0;
  private readonly lookups = new WeakMap<Track, Promise<void>>();

  private constructor(
    readonly guildId: string,
    private readonly connection: VoiceConnection,
    channelName: string,
  ) {
    this.log = createLogger(`player:${channelName}`);
    this.audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(this.audio);

    this.audio.on(AudioPlayerStatus.Playing, (old) => {
      clearTimeout(this.startTimer);
      if (old.status === AudioPlayerStatus.Buffering && this.current) {
        this.log.info(`Started "${this.current.title}" after ${Date.now() - this.requestedAt} ms`);
      }
    });
    this.audio.on(AudioPlayerStatus.Idle, () => {
      if (this.current) this.log.info(`Finished "${this.current.title}"`);
      void this.playNext();
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

  /**
   * Adds tracks; starts playing if nothing is. Returns the first track's position (0 = now playing).
   * The caller's reply announces it, so a track that starts right away gets no extra "Now playing" message.
   */
  enqueue(tracks: Track[]): number {
    const position = this.current ? this.queue.length + 1 : 0;
    this.queue.push(...tracks);
    const who = tracks[0]?.requestedBy.username;
    if (tracks.length === 1) {
      if (position > 0) this.log.info(`Queued "${tracks[0]!.title}" at position ${position} (by ${who})`);
    } else {
      this.log.info(`Queued ${tracks.length} tracks from position ${Math.max(position, 1)} (by ${who})`);
    }
    if (!this.current) void this.playNext(false);
    else this.prefetchNext();
    return position;
  }

  skip(by: string): void {
    this.log.info(`Skipped "${this.current?.title}" (by ${by})`);
    this.current = undefined; // So Idle doesn't also log it as finished.
    if (this.resource) this.audio.stop(true); // Triggers Idle -> playNext
    else void this.playNext(); // Still looking it up: nothing is playing, so Idle won't fire.
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
    clearTimeout(this.startTimer);
    this.queue.length = 0;
    this.current = undefined;
    this.stream?.kill();
    this.audio.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    this.log.info(`Left voice channel${reason ? ` (${reason})` : ''}`);
  }

  private async playNext(announce = true): Promise<void> {
    if (this.destroyed) return;
    const token = ++this.playToken;
    this.stream?.kill();
    this.stream = undefined;
    this.resource = undefined;
    clearTimeout(this.idleTimer);
    clearTimeout(this.startTimer);

    const track = this.queue.shift();
    this.current = track;
    if (!track) {
      this.log.debug(`Queue empty, leaving in ${IDLE_TIMEOUT_MS / 60_000} min if nothing is added`);
      this.idleTimer = setTimeout(() => this.destroy('idle'), IDLE_TIMEOUT_MS);
      return;
    }
    this.requestedAt = Date.now();

    if (!isReady(track)) {
      // Normally done in the background while the previous track played; this covers the rest.
      try {
        await this.ensureReady(track);
      } catch (err) {
        if (token !== this.playToken || this.destroyed) return;
        const reason = errorMessage(err);
        this.log.warn(`Can't play "${track.title}", skipping: ${reason}`);
        this.textChannel?.send(`Skipped **${track.title}**: ${reason}`).catch(() => {});
        return this.playNext(announce);
      }
      if (token !== this.playToken || this.destroyed) return; // Skipped or stopped meanwhile.
    }

    this.log.info(`Now playing "${track.title}" (requested by ${track.requestedBy.username})`);
    this.stream = createAudioStream(track);
    this.resource = createAudioResource(this.stream.stream, { inputType: StreamType.Raw, inlineVolume: true });
    this.resource.volume?.setVolume(this.volume / 100);
    this.audio.play(this.resource);
    this.startTimer = setTimeout(() => {
      if (token !== this.playToken || this.destroyed || this.audio.state.status !== AudioPlayerStatus.Buffering) return;
      this.log.warn(`"${track.title}" produced no audio after ${START_TIMEOUT_MS / 1000} s, skipping`);
      this.textChannel?.send(`Skipped **${track.title}**: it didn't start (the source may be unavailable right now).`).catch(() => {});
      this.current = undefined; // So Idle doesn't log it as finished.
      this.audio.stop(true); // Idle -> playNext
    }, START_TIMEOUT_MS);

    if (announce) this.announce(track);
    this.prefetchNext();
  }

  /** Posts "Now playing" for a track that started from the queue. Never throws: playback matters more. */
  private announce(track: Track): void {
    if (!this.textChannel) return;
    try {
      this.textChannel.send({ embeds: [trackEmbed(track, 0)] }).catch((err: Error) => {
        this.log.warn(`Couldn't post "Now playing" message: ${err.message}`);
      });
    } catch (err) {
      this.log.warn(`Couldn't build "Now playing" message for "${track.title}":`, err);
    }
  }

  /** Looks the track up once, even if asked again while the lookup runs. */
  private ensureReady(track: Track): Promise<void> {
    if (isReady(track)) return Promise.resolve();
    let pending = this.lookups.get(track);
    if (!pending) {
      pending = lookupTrack(track.url)
        .then((info) => void Object.assign(track, info))
        .finally(() => this.lookups.delete(track));
      this.lookups.set(track, pending);
    }
    return pending;
  }

  /** Looks up the next track while this one plays, so it starts without a wait. */
  private prefetchNext(): void {
    const next = this.queue[0];
    if (!next || isReady(next)) return;
    this.log.debug(`Prefetching "${next.title}"`);
    this.ensureReady(next).catch((err) => this.log.debug(`Prefetch of "${next.title}" failed: ${errorMessage(err)}`));
  }
}

export function destroyAllPlayers(): void {
  for (const player of players.values()) player.destroy('shutdown');
}
