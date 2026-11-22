import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { GuildPlayer } from '../audio/player.js';
import { resolveTrack } from '../audio/ytdlp.js';
import type { Command } from './types.js';

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) return 'live';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
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

    let info;
    try {
      info = await resolveTrack(query);
    } catch (err) {
      console.error('resolveTrack failed:', err);
      await interaction.editReply(`Couldn't find anything playable for \`${query}\`.`);
      return;
    }

    const player = await GuildPlayer.join(channel);
    const position = player.enqueue({ ...info, requestedBy: interaction.user.id });
    const label = `**${info.title}** (${formatDuration(info.duration)})`;
    await interaction.editReply(position === 0 ? `Now playing ${label}` : `Queued ${label} at position ${position}`);
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
    player.skip();
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
    player.destroy();
    await interaction.reply('Stopped and left the channel.');
  },
};

export const queue: Command = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show what is playing and what is next'),
  async execute(interaction) {
    const player = GuildPlayer.get(interaction.guildId);
    if (!player?.current) {
      await interaction.reply({ content: 'The queue is empty.', flags: MessageFlags.Ephemeral });
      return;
    }
    const lines = [`Now playing: **${player.current.title}** (${formatDuration(player.current.duration)})`];
    player.queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${formatDuration(t.duration)})`));
    if (player.queue.length > 10) lines.push(`…and ${player.queue.length - 10} more`);
    await interaction.reply(lines.join('\n'));
  },
};
