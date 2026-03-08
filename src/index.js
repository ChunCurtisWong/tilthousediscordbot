// ── Load environment variables before anything else ─────────────────────────
const env = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: require('path').join(process.cwd(), `.env.${env}`) });
console.log('DISCORD_TOKEN after dotenv:', process.env.DISCORD_TOKEN);

const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

logger.info(`=== Tilthouse Discord Bot starting in [${env}] mode ===`);

// ── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  // Partials are required to receive reaction events on messages that were
  // sent before the bot started (uncached messages).
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ── Load commands ────────────────────────────────────────────────────────────
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
    logger.debug(`Registered command: /${command.data.name}`, { file });
  } else {
    logger.warn(`Skipping ${file}: missing "data" or "execute" export`);
  }
}

logger.info(`Loaded ${client.commands.size} command(s)`);

// ── Load events ──────────────────────────────────────────────────────────────
const eventsPath = path.join(__dirname, 'events');

for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));

  const handler = (...args) => {
    logger.debug(`Event: ${event.name}`);
    event.execute(...args);
  };

  if (event.once) {
    client.once(event.name, handler);
  } else {
    client.on(event.name, handler);
  }

  logger.debug(`Registered event: ${event.name}${event.once ? ' (once)' : ''}`);
}

// ── Global error handling ────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message ?? String(reason),
    stack: reason?.stack,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM — shutting down gracefully');
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT — shutting down gracefully');
  client.destroy();
  process.exit(0);
});

// ── Login ────────────────────────────────────────────────────────────────────
console.log('NODE_ENV:', env, '| cwd:', process.cwd());
console.log('dotenv path:', require('path').join(process.cwd(), `.env.${env}`));
const token = process.env.DISCORD_TOKEN;
if (!token) {
  logger.error('DISCORD_TOKEN is not set. Check your .env file and NODE_ENV.');
  process.exit(1);
}

logger.info('Connecting to Discord…');
client.login(token).catch(err => {
  logger.error('Login failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
