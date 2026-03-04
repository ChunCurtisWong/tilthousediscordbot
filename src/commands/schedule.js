const { SlashCommandBuilder } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { buildScheduleEmbed } = require('../utils/embeds');

/**
 * Parses a user-supplied time string into a Unix timestamp (seconds).
 * Accepts:
 *  - Plain Unix timestamp (digits only)
 *  - ISO 8601 date strings  (e.g. 2024-06-15T18:00:00Z)
 * Returns null if the string cannot be parsed.
 */
function parseTime(timeStr) {
  const trimmed = timeStr.trim();

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    return Math.floor(d.getTime() / 1000);
  }

  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-schedule')
    .setDescription('Schedule a game session for all queued players')
    .addStringOption(opt =>
      opt.setName('game').setDescription('Game to schedule').setRequired(true)
    )
    .addStringOption(opt =>
      opt
        .setName('time')
        .setDescription('Session time — ISO 8601 (2024-06-15T18:00:00Z) or Unix timestamp')
        .setRequired(true)
    ),

  async execute(interaction) {
    const game = interaction.options.getString('game').trim();
    const timeStr = interaction.options.getString('time');
    const userId = interaction.user.id;
    const username = interaction.user.username;

    logger.info('Command: /th-schedule', { userId, username, game, timeStr });

    // ── Validate queue exists ───────────────────────────────────────
    const queueData = storage.getQueue(game);
    if (!queueData.players || queueData.players.length === 0) {
      return interaction.reply({
        content:
          `❌ No active queue found for **${game}**.\n` +
          `Players must first join with \`/th-queue join ${game}\`.`,
        ephemeral: true,
      });
    }

    // ── Validate time ───────────────────────────────────────────────
    const unixTimestamp = parseTime(timeStr);
    if (!unixTimestamp) {
      return interaction.reply({
        content:
          '❌ Could not parse the time. Use ISO 8601 format:\n' +
          '`2024-06-15T18:00:00Z`  or a Unix timestamp like `1718474400`.',
        ephemeral: true,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    if (unixTimestamp <= now) {
      return interaction.reply({
        content: '❌ The scheduled time must be in the future.',
        ephemeral: true,
      });
    }

    // ── Persist schedule ────────────────────────────────────────────
    const scheduleData = {
      game,
      hostId: userId,
      unixTimestamp,
      votes: {},
      messageId: null,
      channelId: null,
      reminderSent: false,
    };
    storage.saveSchedule(game, scheduleData);

    // ── Post embed ──────────────────────────────────────────────────
    await interaction.reply({ content: `📅 Scheduling **${game}**…`, ephemeral: true });

    const pingList = queueData.players.map(p => `<@${p.userId}>`).join(' ');
    const embed = buildScheduleEmbed(game, scheduleData);

    const scheduleMsg = await interaction.channel.send({
      content: `${pingList}\n📅 A session has been scheduled for **${game}**! React to vote.`,
      embeds: [embed],
    });

    // Add voting reactions
    await scheduleMsg.react('✅');
    await scheduleMsg.react('❌');

    // Persist message reference so reactions can update it
    scheduleData.messageId = scheduleMsg.id;
    scheduleData.channelId = interaction.channel.id;
    storage.saveSchedule(game, scheduleData);

    logger.info('Schedule posted', {
      game,
      unixTimestamp,
      hostId: userId,
      messageId: scheduleMsg.id,
      channelId: interaction.channel.id,
      reminderIn: `${Math.round((unixTimestamp - 600 - now) / 60)} minutes`,
    });
  },
};
