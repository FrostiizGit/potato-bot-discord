import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { destroyAllPlayers } from './audio/player.js';
import { commands } from './commands/index.js';
import { pool, runMigrations } from './db/index.js';
import { ensureUser } from './db/users.js';
import { env } from './env.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: 'This bot only works in its server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await ensureUser(interaction.user);
    await command.execute(interaction);
  } catch (error) {
    console.error(`/${interaction.commandName} failed:`, error);
    const content = 'Something went wrong running that command.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  destroyAllPlayers();
  await client.destroy();
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await runMigrations();
await client.login(env.DISCORD_TOKEN);
