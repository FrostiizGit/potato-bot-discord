import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { COOKIES_SETTING, parseCookies, setYoutubeCookies } from '../audio/cookies.js';
import { errorMessage, lookupTrack } from '../audio/ytdlp.js';
import { setSetting } from '../db/settings.js';
import { createLogger } from '../logger.js';
import type { Command } from './types.js';

const log = createLogger('cookies');
const MAX_FILE_BYTES = 512 * 1024;
/** A short, always-available video to check the cookies get past YouTube's sign-in wall. */
const TEST_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

export const youtubeCookies: Command = {
  data: new SlashCommandBuilder()
    .setName('youtube-cookies')
    .setDescription('Admin: upload YouTube cookies so the bot can play YouTube from its server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption((o) =>
      o.setName('file').setDescription('cookies.txt (Netscape format) exported from a private window').setRequired(true),
    ),
  async execute(interaction) {
    // Hidden from non-admins by default, but server settings can change that: check again.
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Only server admins can change the YouTube cookies.', flags: MessageFlags.Ephemeral });
      return;
    }
    const file = interaction.options.getAttachment('file', true);
    if (file.size > MAX_FILE_BYTES) {
      await interaction.reply({ content: "That file is too big to be a cookies.txt export.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let parsed;
    try {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error(`Couldn't download the file (HTTP ${response.status}).`);
      parsed = parseCookies(await response.text());
    } catch (err) {
      await interaction.editReply(`Couldn't use that file: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Try them before saving: if YouTube still asks to sign in, keep the previous cookies.
    const previous = setYoutubeCookies(parsed.text);
    let testNote: string;
    try {
      await lookupTrack(TEST_VIDEO);
      testNote = 'Test lookup on YouTube worked.';
    } catch (err) {
      const reason = errorMessage(err);
      if (/sign in|blocking/i.test(reason)) {
        setYoutubeCookies(previous);
        log.warn(`Cookies from ${interaction.user.username} rejected by YouTube, kept the previous ones`);
        await interaction.editReply(
          "YouTube still asks to sign in with these cookies, so I kept the previous ones. Export them again from a private window where you're signed in, after opening youtube.com/robots.txt.",
        );
        return;
      }
      testNote = `Saved, but the test lookup failed for another reason: ${reason}`;
    }

    await setSetting(COOKIES_SETTING, parsed.text, interaction.user.username);
    log.info(`YouTube cookies updated by ${interaction.user.username} (${parsed.count} cookies)`);
    const ignored = parsed.dropped ? ` (${parsed.dropped} from other sites ignored)` : '';
    await interaction.editReply(
      [
        `Saved ${parsed.count} YouTube cookies${ignored}. ${testNote}`,
        '-# Close the private window without signing out, and delete the cookies.txt file: the session stays valid as long as it isn\'t used again.',
      ].join('\n'),
    );
  },
};
