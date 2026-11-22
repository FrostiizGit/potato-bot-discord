import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { formatDuration, link, playlistEmbed, trackEmbed } from '../audio/embeds.js';
import { GuildPlayer, MAX_VOLUME, type Track } from '../audio/player.js';
import { errorMessage, isVideoInPlaylist, resolveQuery } from '../audio/ytdlp.js';
import { createLogger } from '../logger.js';
import type { Command } from './types.js';

const log = createLogger('music');
const QUEUE_PAGE = 10;

function progressBar(elapsed: number, duration: number | undefined, width = 12): string {
  if (!duration) return '';
  const filled = Math.min(width, Math.round((elapsed / duration) * width));
  return `\`${'━'.repeat(filled)}●${'─'.repeat(width - filled)}\``;
}

/** Shared by /play and /playlist: join, look up, queue, reply with an embed. */
async function playQuery(interaction: ChatInputCommandInteraction<'cached'>, query: string, wholePlaylist: boolean) {
  const channel = interaction.member.voice.channel;
  if (!channel) {
    await interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    return;
  }
  const existing = GuildPlayer.get(interaction.guildId);
  if (existing && existing.channelId !== channel.id) {
    await interaction.reply({ content: `I'm already playing in <#${existing.channelId}>.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  // Join while yt-dlp looks the track up, instead of one after the other.
  const [resolved, joined] = await Promise.allSettled([
    resolveQuery(query, { wholePlaylist }),
    GuildPlayer.join(channel),
  ]);
  if (joined.status === 'rejected') {
    log.error(`Could not join #${channel.name}:`, joined.reason);
    await interaction.editReply(`I couldn't join <#${channel.id}>.`);
    return;
  }
  const player = joined.value;
  if (resolved.status === 'rejected') {
    const reason = errorMessage(resolved.reason);
    log.warn(`Nothing playable for "${query}": ${reason}`);
    if (!player.current && player.queue.length === 0) player.destroy('nothing to play');
    await interaction.editReply(`Couldn't play \`${query}\`: ${reason}`);
    return;
  }

  const { tracks: infos, playlist } = resolved.value;
  const requestedBy = {
    id: interaction.user.id,
    username: interaction.member.displayName,
    avatarUrl: interaction.member.displayAvatarURL({ size: 64 }),
  };
  const tracks: Track[] = infos.map((info) => ({ ...info, requestedBy }));
  if (interaction.channel?.isSendable()) player.textChannel = interaction.channel;

  const position = player.enqueue(tracks);
  const embed = playlist ? playlistEmbed(playlist, tracks, position) : trackEmbed(tracks[0]!, position);
  const hint =
    !wholePlaylist && isVideoInPlaylist(query)
      ? '-# This video is part of a playlist. Use `/playlist` with the same link to queue all of it.'
      : undefined;
  await interaction.editReply({ content: hint, embeds: [embed] });
}

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a YouTube/SoundCloud track or playlist, a direct link, or a YouTube search')
    .addStringOption((o) => o.setName('query').setDescription('URL, playlist URL or search terms').setRequired(true)),
  async execute(interaction) {
    await playQuery(interaction, interaction.options.getString('query', true), false);
  },
};

export const playlist: Command = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Queue a whole playlist, also from a link to a video inside it (starts at that video)')
    .addStringOption((o) =>
      o.setName('url').setDescription('Playlist link, or a video link from a playlist (watch?v=…&list=…)').setRequired(true),
    ),
  async execute(interaction) {
    await playQuery(interaction, interaction.options.getString('url', true), true);
  },
};

export const skip: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  async execute(interaction) {
    const player = GuildPlayer.get(interaction.guildId);
    if (!player?.current) {
      await interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
      return;
    }
    const skipped = player.current.title;
    player.skip(interaction.user.username);
    await interaction.reply(`Skipped **${skipped}**`);
  },
};

export const stop: Command = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop playback, clear the queue and leave'),
  async execute(interaction) {
    const player = GuildPlayer.get(interaction.guildId);
    if (!player) {
      await interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    player.destroy(`stopped by ${interaction.user.username}`);
    await interaction.reply('Stopped and left the channel.');
  },
};

export const volume: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or change the playback volume')
    .addIntegerOption((o) =>
      o
        .setName('percent')
        .setDescription(`0–${MAX_VOLUME}, 100 is the original level`)
        .setMinValue(0)
        .setMaxValue(MAX_VOLUME),
    ),
  async execute(interaction) {
    const player = GuildPlayer.get(interaction.guildId);
    if (!player) {
      await interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    const percent = interaction.options.getInteger('percent');
    if (percent === null) {
      await interaction.reply({ content: `Volume is ${player.volume}%`, flags: MessageFlags.Ephemeral });
      return;
    }
    const before = player.volume;
    player.setVolume(percent, interaction.user.username);
    const note = percent > 100 ? ' (above 100% loud tracks may distort)' : '';
    await interaction.reply(`Volume ${before}% → **${percent}%**${note}`);
  },
};

export const queue: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show what is playing and what is next'),
  async execute(interaction) {
    const player = GuildPlayer.get(interaction.guildId);
    if (!player?.current) {
      await interaction.reply({ content: 'Nothing is playing and the queue is empty.', flags: MessageFlags.Ephemeral });
      return;
    }
    const { current } = player;
    const elapsed = player.elapsed;

    const upcoming = player.queue
      .slice(0, QUEUE_PAGE)
      .map((t, i) => {
        const title = t.title.length > 80 ? `${t.title.slice(0, 79)}…` : t.title;
        return `${i + 1}. ${link(title, t.url)} · ${formatDuration(t.duration)} · ${t.requestedBy.username}`;
      });
    if (player.queue.length > QUEUE_PAGE) upcoming.push(`…and ${player.queue.length - QUEUE_PAGE} more`);

    // Unknown durations (SoundCloud set tracks not looked up yet) count as 0.
    const remaining =
      (current.duration ? Math.max(0, current.duration - elapsed) : 0) +
      player.queue.reduce((sum, t) => sum + (t.duration ?? 0), 0);

    // The list goes in the description (4096 chars) rather than a field (1024).
    const footerText = `Requested by ${current.requestedBy.username} · Volume ${player.volume}% · ${formatDuration(remaining)} left in total`;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'Now playing' })
      .setTitle(current.title.slice(0, 256))
      .setURL(current.url)
      .setDescription(
        [
          `${progressBar(elapsed, current.duration)} ${formatDuration(elapsed)} / ${formatDuration(current.duration)}`,
          '',
          `**Up next (${player.queue.length})**`,
          upcoming.join('\n') || 'Nothing queued',
        ].join('\n'),
      )
      .setFooter(
        current.requestedBy.avatarUrl ? { text: footerText, iconURL: current.requestedBy.avatarUrl } : { text: footerText },
      );
    if (current.thumbnail) embed.setThumbnail(current.thumbnail);

    await interaction.reply({ embeds: [embed] });
  },
};
