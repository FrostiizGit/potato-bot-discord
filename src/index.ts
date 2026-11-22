import { Client, Events, GatewayIntentBits, MessageFlags, type CommandInteractionOption } from 'discord.js';
import { destroyAllPlayers } from './audio/player.js';
import { commands } from './commands/index.js';
import { pool, runMigrations } from './db/index.js';
import { ensureUser } from './db/users.js';
import { env } from './env.js';
import { createLogger } from './logger.js';

const log = createLogger('bot');
const cmdLog = createLogger('cmd');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => {
  log.info(`Logged in as ${c.user.tag}, ${commands.size} commands loaded`);
});
client.on(Events.Warn, (m) => log.warn(m));
client.on(Events.Error, (e) => log.error('Client error:', e));

/** `query="lofi" volume=80`, including subcommand options. */
function formatOptions(options: readonly CommandInteractionOption[]): string {
  return options
    .map((o) => (o.options ? `${o.name} ${formatOptions(o.options)}` : `${o.name}=${JSON.stringify(o.value)}`))
    .join(' ');
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'This bot only works in its server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const command = commands.get(interaction.commandName);
  const who = `${interaction.user.username} (${interaction.user.id})`;
  const what = `/${interaction.commandName}${interaction.options.data.length ? ` ${formatOptions(interaction.options.data)}` : ''}`;
  if (!command) {
    cmdLog.warn(`${who} used unknown command ${what}`);
    return;
  }

  const channel = interaction.channel ? `#${interaction.channel.name}` : 'unknown channel';
  cmdLog.info(`${who} → ${what} in ${channel}`);
  const started = Date.now();
  try {
    await ensureUser(interaction.user);
    await command.execute(interaction);
    cmdLog.debug(`/${interaction.commandName} by ${interaction.user.username} done in ${Date.now() - started} ms`);
  } catch (error) {
    cmdLog.error(`/${interaction.commandName} by ${interaction.user.username} failed after ${Date.now() - started} ms:`, error);
    const content = 'Something went wrong running that command.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  destroyAllPlayers();
  await client.destroy();
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await runMigrations();
log.info('Database ready');
await client.login(env.DISCORD_TOKEN);
