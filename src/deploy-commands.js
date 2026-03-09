// ── Load environment variables before anything else ─────────────────────────
const env = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: `.env.${env}` });

const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  logger.error('DISCORD_TOKEN and CLIENT_ID must be set before deploying commands.');
  process.exit(1);
}

if (!GUILD_ID) {
  logger.error('GUILD_ID is required for guild-scoped command deployment.');
  process.exit(1);
}

// ── Collect command JSON payloads ────────────────────────────────────────────
const commands = [];
const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command.data) {
    commands.push(command.data.toJSON());
    logger.info(`Queued command for deployment: /${command.data.name}`);
  }
}

// ── Deploy ───────────────────────────────────────────────────────────────────
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    logger.info(`Deploying ${commands.length} command(s) to guild ${GUILD_ID}…`);

    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    logger.info(`✅ Commands deployed to guild ${GUILD_ID} (instant update)`);
  } catch (err) {
    logger.error('Command deployment failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
})();
