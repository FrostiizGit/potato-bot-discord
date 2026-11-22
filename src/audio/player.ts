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
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { createAudioStream, type AudioStream, type TrackInfo } from './ytdlp.js';

export interface Track extends TrackInfo {
  requestedBy: string;
}

/** Leave the voice channel after this long with nothing playing. */
const IDLE_TIMEOUT_MS = 5 * 60_000;

const players = new Map<string, GuildPlayer>();

export class GuildPlayer {
  readonly queue: Track[] = [];
  current: Track | undefined;

  private readonly audio: AudioPlayer;
  private stream: AudioStream | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private destroyed = false;

  private constructor(
    readonly guildId: string,
    private readonly connection: VoiceConnection,
  ) {
    this.audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(this.audio);

    this.audio.on(AudioPlayerStatus.Idle, () => this.playNext());
    this.audio.on('error', (err) => {
      console.error(`[${guildId}] audio error on "${this.current?.title}":`, err.message);
      // Idle fires right after, which moves on to the next track.
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved to another channel: Discord reconnects by itself.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy(); // Kicked or channel deleted.
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
    const player = new GuildPlayer(channel.guild.id, connection);
    players.set(channel.guild.id, player);
    return player;
  }

  get channelId(): string | null {
    return this.connection.joinConfig.channelId;
  }

  /** Adds a track; starts playing if nothing is. Returns its position in the queue (0 = now playing). */
  enqueue(track: Track): number {
    this.queue.push(track);
    if (!this.current) {
      this.playNext();
      return 0;
    }
    return this.queue.length;
  }

  skip(): void {
    this.audio.stop(true); // Triggers Idle -> playNext
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    players.delete(this.guildId);
    clearTimeout(this.idleTimer);
    this.queue.length = 0;
    this.current = undefined;
    this.stream?.kill();
    this.audio.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
  }

  private playNext(): void {
    if (this.destroyed) return;
    this.stream?.kill();
    this.stream = undefined;
    clearTimeout(this.idleTimer);

    this.current = this.queue.shift();
    if (!this.current) {
      this.idleTimer = setTimeout(() => this.destroy(), IDLE_TIMEOUT_MS);
      return;
    }

    this.stream = createAudioStream(this.current.url);
    const resource = createAudioResource(this.stream.stream, { inputType: StreamType.OggOpus });
    this.audio.play(resource);
  }
}

export function destroyAllPlayers(): void {
  for (const player of players.values()) player.destroy();
}
