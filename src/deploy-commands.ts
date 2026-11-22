// Registers slash commands on your server. Run again whenever you add or change a command.
import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';
import { env } from './env.js';

const body = [...commands.values()].map((c) => c.data.toJSON());
const rest = new REST().setToken(env.DISCORD_TOKEN);

await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), { body });
console.log(`Registered ${body.length} commands: ${body.map((c) => `/${c.name}`).join(', ')}`);
