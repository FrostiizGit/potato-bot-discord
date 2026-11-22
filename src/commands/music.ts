import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { GuildPlayer, MAX_VOLUME } from '../audio/player.js';
import { resolveTrack } from '../audio/ytdlp.js';
import { createLogger } from '../logger.js';
import type { Command } from './types.js';

const log = createLogger('music');
const QUEUE_PAGE = 10;

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return 'live';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = (total % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function progressBar(elapsed: number, duration: number | undefined, width = 16): string {
  if (!duration) return '';
  const filled = Math.min(width, Math.round((elapsed / duration) * width));
  return `${'▬'.repeat(filled)}🔘${'▬'.repeat(width - filled)}`;
}

export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play audio from YouTube, SoundCloud, a direct link, or a YouTube search')
    .addStringOption((o) => o.setName('query').setDescription('URL or search terms').setRequired(true)),
  async execute(interaction) {
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
    const query = interaction.options.getString('query', true);

    // Join while yt-dlp looks the track up, instead of one after the other.
    const [resolved, joined] = await Promise.allSettled([resolveTrack(query), GuildPlayer.join(channel)]);
    if (joined.status === 'rejected') {
      log.error(`Could not join #${channel.name}:`, joined.reason);
      await interaction.editReply(`I couldn't join <#${channel.id}>.`);
      return;
    }
    if (resolved.status === 'rejected') {
      log.warn(`Nothing playable for "${query}": ${String(resolved.reason?.stderr ?? resolved.reason).trim()}`);
      const player = joined.value;
      if (!player.current && player.queue.length === 0) player.destroy('nothing to play');
      await interaction.editReply(`Couldn't find anything playable for \`${query}\`.`);
      return;
    }

    const info = resolved.value;
    const player = joined.value;
    const position = player.enqueue({
      ...info,
      requestedBy: { id: interaction.user.id, username: interaction.user.username },
    });
    const label = `**[${info.title}](<${info.url}>)** (${formatDuration(info.duration)})`;
    await interaction.editReply(position === 0 ? `▶️ Now playing ${label}` : `➕ Queued ${label} at position ${position}`);
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
    await interaction.reply(`⏭️ Skipped **${skipped}**`);
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
    await interaction.reply('⏹️ Stopped and left the channel.');
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
      await interaction.reply({ content: `🔊 Volume is ${player.volume}%`, flags: MessageFlags.Ephemeral });
      return;
    }
    const before = player.volume;
    player.setVolume(percent, interaction.user.username);
    const icon = percent === 0 ? '🔇' : percent < before ? '🔉' : '🔊';
    const note = percent > 100 ? ' (above 100% loud tracks may distort)' : '';
    await interaction.reply(`${icon} Volume ${before}% → **${percent}%**${note}`);
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
      .map((t, i) => `\`${i + 1}.\` [${t.title}](<${t.url}>) · ${formatDuration(t.duration)} · ${t.requestedBy.username}`);
    if (player.queue.length > QUEUE_PAGE) upcoming.push(`…and ${player.queue.length - QUEUE_PAGE} more`);

    const remaining =
      (current.duration ? Math.max(0, current.duration - elapsed) : 0) +
      player.queue.reduce((sum, t) => sum + (t.duration ?? 0), 0);

    const embed = new EmbedBuilder()
      .setColor(0xc8a165)
      .setTitle('Now playing')
      .setDescription(
        [
          `**[${current.title}](${current.url})**`,
          `${progressBar(elapsed, current.duration)} ${formatDuration(elapsed)} / ${formatDuration(current.duration)}`,
          `Requested by ${current.requestedBy.username}`,
        ].join('\n'),
      )
      .addFields({ name: `Up next (${player.queue.length})`, value: upcoming.join('\n') || 'Nothing queued' })
      .setFooter({ text: `Volume ${player.volume}% · ${formatDuration(remaining)} left in total` });

    await interaction.reply({ embeds: [embed] });
  },
};
