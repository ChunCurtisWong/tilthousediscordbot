const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { buildQueueEmbed } = require('../utils/embeds');

/**
 * Parses a user-supplied time string into a Unix timestamp (seconds).
 * Accepts:
 *  - Plain Unix timestamp (digits only)
 *  - Simple time of day: "7pm", "7:30pm", "19:00", "7:30 AM"
 *    → resolved to today if still in the future, otherwise tomorrow
 *  - ISO 8601 / any string parseable by Date
 * Returns null if the string cannot be parsed.
 */
function parseTime(timeStr) {
  const trimmed = timeStr.trim();

  // Plain Unix timestamp
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // Simple time-of-day: "7pm", "7:30pm", "19:00", "7:30 AM"
  const todMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (todMatch) {
    let hours = parseInt(todMatch[1], 10);
    const minutes = parseInt(todMatch[2] || '0', 10);
    const meridiem = (todMatch[3] || '').toLowerCase();

    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      const d = new Date();
      d.setHours(hours, minutes, 0, 0);
      if (d <= new Date()) d.setDate(d.getDate() + 1); // roll to tomorrow if past
      return Math.floor(d.getTime() / 1000);
    }
  }

  // ISO 8601 or any other Date-parseable string
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    return Math.floor(d.getTime() / 1000);
  }

  return null;
}

/**
 * Fetches and edits the live queue message, or posts a new one if not found.
 * Returns the sent/edited message.
 */
async function upsertQueueMessage(interaction, game, queueData) {
  const embed = buildQueueEmbed(game, queueData);

  if (queueData.messageId && queueData.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(queueData.channelId);
      const msg = await ch.messages.fetch(queueData.messageId);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch {
      // Message was deleted or channel changed — fall through to posting new
    }
  }

  const msg = await interaction.channel.send({ embeds: [embed] });
  queueData.messageId = msg.id;
  queueData.channelId = interaction.channel.id;
  return msg;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-queue')
    .setDescription('Manage game queues')
    .addSubcommand(sub =>
      sub
        .setName('join')
        .setDescription('Join a game queue, optionally setting thresholds and a scheduled time')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game name to queue for').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription('Scheduled time — e.g. 7pm, 7:30pm, 19:00, 2024-06-15T18:00:00Z, or Unix timestamp')
            .setRequired(false)
        )
        .addIntegerOption(opt =>
          opt
            .setName('min')
            .setDescription('Minimum players needed — pings everyone when reached')
            .setMinValue(2)
            .setMaxValue(100)
            .setRequired(false)
        )
        .addIntegerOption(opt =>
          opt
            .setName('max')
            .setDescription('Maximum players — closes queue and pings everyone when reached')
            .setMinValue(2)
            .setMaxValue(100)
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('leave')
        .setDescription('Leave a game queue')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game name to leave').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show the current queue status for a game')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game name to check').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('clear')
        .setDescription('Clear a game queue (host or moderator only)')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game queue to clear').setRequired(true)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const game = interaction.options.getString('game').trim();
    const userId = interaction.user.id;
    const username = interaction.user.username;

    logger.info(`Command: /th-queue ${sub}`, { userId, username, game });

    // ── /th-queue join ───────────────────────────────────────────────
    if (sub === 'join') {
      const queueData = storage.getQueue(game);
      const { min, max, scheduledTime } = queueData;

      // Reject if max is already reached
      if (max !== null && queueData.players.length >= max) {
        return interaction.reply({
          content: `❌ The **${game}** queue is full (${queueData.players.length}/${max}).`,
          ephemeral: true,
        });
      }

      if (queueData.players.find(p => p.userId === userId)) {
        return interaction.reply({
          content: `❌ You are already in the **${game}** queue.`,
          ephemeral: true,
        });
      }

      // min/max/time are set by the first player to specify them; ignored thereafter
      const minOpt = interaction.options.getInteger('min');
      const maxOpt = interaction.options.getInteger('max');
      const timeStr = interaction.options.getString('time');

      if (minOpt !== null && queueData.min === null) queueData.min = minOpt;
      if (maxOpt !== null && queueData.max === null) queueData.max = maxOpt;

      if (minOpt !== null && maxOpt !== null && minOpt >= maxOpt) {
        return interaction.reply({
          content: '❌ `min` must be less than `max`.',
          ephemeral: true,
        });
      }

      // Parse and store scheduled time (first setter wins)
      if (timeStr && queueData.scheduledTime === null) {
        const ts = parseTime(timeStr);
        if (!ts) {
          return interaction.reply({
            content:
              '❌ Could not parse the time. Try formats like:\n' +
              '`7pm`  `7:30pm`  `19:00`  `2024-06-15T18:00:00Z`  `1718474400`',
            ephemeral: true,
          });
        }
        if (ts <= Math.floor(Date.now() / 1000)) {
          return interaction.reply({
            content: '❌ The scheduled time must be in the future.',
            ephemeral: true,
          });
        }
        queueData.scheduledTime = ts;
      }

      queueData.players.push({ userId, username, joinedAt: Date.now() });
      await upsertQueueMessage(interaction, game, queueData);
      storage.saveQueue(game, queueData);

      const count = queueData.players.length;
      const effectiveMin = queueData.min;
      const effectiveMax = queueData.max;
      const effectiveTime = queueData.scheduledTime;

      let joinMsg = `✅ You joined the **${game}** queue!`;
      if (effectiveMax) joinMsg += ` (${count}/${effectiveMax})`;
      else if (effectiveMin) joinMsg += ` (${count} joined, ${effectiveMin} needed to start)`;
      else joinMsg += ` (${count} in queue)`;
      if (effectiveTime) joinMsg += `\n📅 Scheduled for <t:${effectiveTime}:F>`;

      logger.info('Player joined queue', { userId, game, count, min: effectiveMin, max: effectiveMax, scheduledTime: effectiveTime });

      await interaction.reply({ content: joinMsg, ephemeral: true });

      const pingList = queueData.players.map(p => `<@${p.userId}>`).join(' ');

      // ── Max reached: close queue and ping everyone ─────────────────
      if (effectiveMax !== null && count >= effectiveMax) {
        logger.info('Queue max reached — closing', { game, count, max: effectiveMax });
        const fullEmbed = new EmbedBuilder()
          .setColor('#FF6B6B')
          .setTitle(`🔒 Queue Full: ${game}`)
          .setDescription(
            `The **${game}** queue is now full with **${count}/${effectiveMax}** players!\n\n` +
              `**Players:** ${pingList}` +
              (effectiveTime
                ? `\n\n📅 **Scheduled:** <t:${effectiveTime}:F> (<t:${effectiveTime}:R>)`
                : '')
          )
          .setTimestamp();
        await interaction.channel.send({
          content: `${pingList}\n🔒 The **${game}** queue is full — no more spots!`,
          embeds: [fullEmbed],
        });
      }
      // ── Min reached (and max not yet hit): notify game is ready ───
      else if (effectiveMin !== null && count >= effectiveMin) {
        logger.info('Queue min reached — notifying', { game, count, min: effectiveMin });
        const readyEmbed = new EmbedBuilder()
          .setColor('#00FF7F')
          .setTitle(`✅ ${game} — Minimum Reached!`)
          .setDescription(
            `**${count}** players have joined — the minimum of **${effectiveMin}** is met!\n\n` +
              `**Players:** ${pingList}` +
              (effectiveTime
                ? `\n\n📅 **Scheduled:** <t:${effectiveTime}:F> (<t:${effectiveTime}:R>)`
                : '') +
              (effectiveMax ? `\n\nThe queue will close at **${effectiveMax}** players.` : '')
          )
          .setTimestamp();
        await interaction.channel.send({
          content: `${pingList}\n✅ The **${game}** queue has enough players — let's go!`,
          embeds: [readyEmbed],
        });
      }

      // ── Scheduled time within 10 minutes: ping immediately ────────
      if (effectiveTime && !queueData.reminderSent) {
        const secsUntil = effectiveTime - Math.floor(Date.now() / 1000);
        if (secsUntil <= 600 && secsUntil > 0) {
          queueData.reminderSent = true;
          storage.saveQueue(game, queueData);
          const minutesLeft = Math.max(1, Math.ceil(secsUntil / 60));
          logger.info('Queue scheduled within 10 min — pinging immediately', { game, minutesLeft });
          await interaction.channel.send({
            content:
              `${pingList}\n⏰ **${game}** starts in **${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}**! <t:${effectiveTime}:R>`,
          });
        }
      }

      return;
    }

    // ── /th-queue leave ──────────────────────────────────────────────
    if (sub === 'leave') {
      const queueData = storage.getQueue(game);
      const idx = queueData.players.findIndex(p => p.userId === userId);

      if (idx === -1) {
        return interaction.reply({
          content: `❌ You are not in the **${game}** queue.`,
          ephemeral: true,
        });
      }

      queueData.players.splice(idx, 1);
      await upsertQueueMessage(interaction, game, queueData);
      storage.saveQueue(game, queueData);

      logger.info('Player left queue', { userId, game, remaining: queueData.players.length });
      return interaction.reply({
        content: `✅ You left the **${game}** queue.`,
        ephemeral: true,
      });
    }

    // ── /th-queue status ─────────────────────────────────────────────
    if (sub === 'status') {
      const queueData = storage.getQueue(game);
      const embed = buildQueueEmbed(game, queueData);
      return interaction.reply({ embeds: [embed] });
    }

    // ── /th-queue clear ──────────────────────────────────────────────
    if (sub === 'clear') {
      const queueData = storage.getQueue(game);
      const isHost =
        queueData.players.length > 0 && queueData.players[0].userId === userId;
      const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      if (!isHost && !isMod) {
        return interaction.reply({
          content: '❌ Only the queue host or a moderator can clear the queue.',
          ephemeral: true,
        });
      }

      if (queueData.messageId && queueData.channelId) {
        try {
          const ch = await interaction.client.channels.fetch(queueData.channelId);
          const msg = await ch.messages.fetch(queueData.messageId);
          const clearedEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle(`🚫 Queue Cleared: ${game}`)
            .setDescription(`The **${game}** queue was cleared by <@${userId}>.`)
            .setTimestamp();
          await msg.edit({ embeds: [clearedEmbed] });
        } catch (err) {
          logger.warn('/th-queue clear: could not edit old queue embed', { error: err.message });
        }
      }

      storage.deleteQueue(game);
      logger.info('Queue cleared', { userId, game });

      return interaction.reply({
        content: `✅ The **${game}** queue has been cleared.`,
      });
    }
  },
};
