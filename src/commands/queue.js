const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { buildQueueEmbed, buildQueueComponents } = require('../utils/embeds');

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

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

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
      if (d <= new Date()) d.setDate(d.getDate() + 1);
      return Math.floor(d.getTime() / 1000);
    }
  }

  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    return Math.floor(d.getTime() / 1000);
  }

  return null;
}

/**
 * Sends an ephemeral reply or followUp depending on whether the interaction
 * has already been deferred (button path) or not (slash command path).
 */
function respond(interaction, opts) {
  return interaction.deferred
    ? interaction.followUp({ ...opts, ephemeral: true })
    : interaction.reply({ ...opts, ephemeral: true });
}

/**
 * Updates the live queue embed with the current state.
 *
 * Button path  → interaction.editReply() edits the message the button lives on
 *               in-place, with no new message posted.
 * Slash path   → edits the stored embed message by ID, or posts a new one
 *               if the original was deleted.
 */
async function refreshEmbed(interaction, game, queueData) {
  const embed = buildQueueEmbed(game, queueData);
  const components = [buildQueueComponents(game)];

  if (interaction.isButton()) {
    // editReply targets the exact message the button was on
    await interaction.editReply({ embeds: [embed], components });
    // Keep stored IDs in sync (they should already match)
    queueData.messageId = interaction.message.id;
    queueData.channelId = interaction.channelId;
    return;
  }

  // Slash command: edit the stored embed message, or post a fresh one
  if (queueData.messageId && queueData.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(queueData.channelId);
      const msg = await ch.messages.fetch(queueData.messageId);
      await msg.edit({ embeds: [embed], components });
      return;
    } catch {
      // Stored message is gone — fall through to posting a new one
    }
  }

  const msg = await interaction.channel.send({ embeds: [embed], components });
  queueData.messageId = msg.id;
  queueData.channelId = interaction.channel.id;
}

// ─── Shared join logic ──────────────────────────────────────────────────────

async function processJoin(interaction, game, userId, username, { minOpt, maxOpt, timeStr }) {
  const queueData = storage.getQueue(game);
  if (!queueData.fill) queueData.fill = [];

  // ── Already in queue or fill ─────────────────────────────────────
  if (queueData.players.find(p => p.userId === userId)) {
    return respond(interaction, { content: `❌ You are already in the **${game}** queue.` });
  }
  if (queueData.fill.find(p => p.userId === userId)) {
    return respond(interaction, { content: `❌ You are already on the **${game}** fill list.` });
  }

  // ── Apply queue parameters (first setter wins for each) ──────────
  if (minOpt !== null && queueData.min === null) queueData.min = minOpt;
  if (maxOpt !== null && queueData.max === null) queueData.max = maxOpt;

  if (minOpt !== null && maxOpt !== null && minOpt >= maxOpt) {
    return respond(interaction, { content: '❌ `min` must be less than `max`.' });
  }

  if (timeStr && queueData.scheduledTime === null) {
    const ts = parseTime(timeStr);
    if (!ts) {
      return respond(interaction, {
        content:
          '❌ Could not parse the time. Try formats like:\n' +
          '`7pm`  `7:30pm`  `19:00`  `2024-06-15T18:00:00Z`  `1718474400`',
      });
    }
    if (ts <= Math.floor(Date.now() / 1000)) {
      return respond(interaction, { content: '❌ The scheduled time must be in the future.' });
    }
    queueData.scheduledTime = ts;
  }

  const { max, min, scheduledTime } = queueData;

  // ── Queue full → add to fill list ────────────────────────────────
  if (max !== null && queueData.players.length >= max) {
    queueData.fill.push({ userId, username, joinedAt: Date.now() });
    await refreshEmbed(interaction, game, queueData);
    storage.saveQueue(game, queueData);

    const pos = queueData.fill.length;
    logger.info('Player added to fill list', { userId, game, fillPosition: pos });
    return respond(interaction, {
      content:
        `✅ The **${game}** queue is full — you've been added to the fill list at position **#${pos}**.\n` +
        `You'll be promoted automatically if a spot opens up!`,
    });
  }

  // ── Add to main queue ────────────────────────────────────────────
  queueData.players.push({ userId, username, joinedAt: Date.now() });
  await refreshEmbed(interaction, game, queueData);
  storage.saveQueue(game, queueData);

  const count = queueData.players.length;

  let joinMsg = `✅ You joined the **${game}** queue!`;
  if (max) joinMsg += ` (${count}/${max})`;
  else if (min) joinMsg += ` (${count} joined, ${min} needed to start)`;
  else joinMsg += ` (${count} in queue)`;
  if (scheduledTime) joinMsg += `\n📅 Scheduled for <t:${scheduledTime}:F>`;

  logger.info('Player joined queue', { userId, game, count, min, max, scheduledTime });
  await respond(interaction, { content: joinMsg });

  // Public notifications — always sent to the channel, not as ephemeral
  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
  const pingList = queueData.players.map(p => `<@${p.userId}>`).join(' ');

  // ── Max reached: ping everyone ────────────────────────────────────
  if (max !== null && count >= max) {
    logger.info('Queue max reached', { game, count, max });
    const fullEmbed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setTitle(`🔒 Queue Full: ${game}`)
      .setDescription(
        `The **${game}** queue is now full with **${count}/${max}** players!\n\n` +
          `**Players:** ${pingList}` +
          (scheduledTime ? `\n\n📅 **Scheduled:** <t:${scheduledTime}:F> (<t:${scheduledTime}:R>)` : '')
      )
      .setTimestamp();
    await channel.send({
      content: `${pingList}\n🔒 The **${game}** queue is full — no more spots!`,
      embeds: [fullEmbed],
    });
  }
  // ── Min reached (max not yet hit): notify ─────────────────────────
  else if (min !== null && count >= min) {
    logger.info('Queue min reached', { game, count, min });
    const readyEmbed = new EmbedBuilder()
      .setColor('#00FF7F')
      .setTitle(`✅ ${game} — Minimum Reached!`)
      .setDescription(
        `**${count}** players have joined — the minimum of **${min}** is met!\n\n` +
          `**Players:** ${pingList}` +
          (scheduledTime ? `\n\n📅 **Scheduled:** <t:${scheduledTime}:F> (<t:${scheduledTime}:R>)` : '') +
          (max ? `\n\nThe queue will close at **${max}** players.` : '')
      )
      .setTimestamp();
    await channel.send({
      content: `${pingList}\n✅ The **${game}** queue has enough players — let's go!`,
      embeds: [readyEmbed],
    });
  }

  // ── Scheduled within 10 min: ping immediately ─────────────────────
  if (scheduledTime && !queueData.reminderSent) {
    const secsUntil = scheduledTime - Math.floor(Date.now() / 1000);
    if (secsUntil <= 600 && secsUntil > 0) {
      queueData.reminderSent = true;
      storage.saveQueue(game, queueData);
      const minutesLeft = Math.max(1, Math.ceil(secsUntil / 60));
      logger.info('Queue scheduled within 10 min — pinging immediately', { game, minutesLeft });
      await channel.send({
        content: `${pingList}\n⏰ **${game}** starts in **${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}**! <t:${scheduledTime}:R>`,
      });
    }
  }
}

// ─── Shared leave logic ─────────────────────────────────────────────────────

async function processLeave(interaction, game, userId) {
  const queueData = storage.getQueue(game);
  if (!queueData.fill) queueData.fill = [];

  const playerIdx = queueData.players.findIndex(p => p.userId === userId);
  const fillIdx = queueData.fill.findIndex(p => p.userId === userId);

  if (playerIdx === -1 && fillIdx === -1) {
    return respond(interaction, {
      content: `❌ You are not in the **${game}** queue or fill list.`,
    });
  }

  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);

  // ── Leaving main queue ───────────────────────────────────────────
  if (playerIdx !== -1) {
    queueData.players.splice(playerIdx, 1);

    if (queueData.fill.length > 0) {
      const promoted = queueData.fill.shift();
      queueData.players.push(promoted);

      logger.info('Fill player promoted to main queue', {
        promotedUserId: promoted.userId,
        game,
        remaining: queueData.players.length,
        fillRemaining: queueData.fill.length,
      });

      await refreshEmbed(interaction, game, queueData);
      storage.saveQueue(game, queueData);

      await channel.send({
        content: `<@${promoted.userId}> A spot opened up — you've been promoted from the fill list to the **${game}** main queue! 🎮`,
      });
    } else {
      await refreshEmbed(interaction, game, queueData);
      storage.saveQueue(game, queueData);
      logger.info('Player left main queue', { userId, game, remaining: queueData.players.length });
    }

    return respond(interaction, { content: `✅ You left the **${game}** queue.` });
  }

  // ── Leaving fill list ────────────────────────────────────────────
  queueData.fill.splice(fillIdx, 1);
  await refreshEmbed(interaction, game, queueData);
  storage.saveQueue(game, queueData);

  logger.info('Player left fill list', { userId, game, fillRemaining: queueData.fill.length });
  return respond(interaction, { content: `✅ You've been removed from the **${game}** fill list.` });
}

// ─── Command definition ─────────────────────────────────────────────────────

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
        .setDescription('Leave a game queue or fill list')
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

    if (sub === 'join') {
      return processJoin(interaction, game, userId, username, {
        minOpt: interaction.options.getInteger('min'),
        maxOpt: interaction.options.getInteger('max'),
        timeStr: interaction.options.getString('time'),
      });
    }

    if (sub === 'leave') {
      return processLeave(interaction, game, userId);
    }

    // ── /th-queue status ─────────────────────────────────────────────
    if (sub === 'status') {
      const queueData = storage.getQueue(game);
      return interaction.reply({
        embeds: [buildQueueEmbed(game, queueData)],
        components: [buildQueueComponents(game)],
      });
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
          await msg.edit({ embeds: [clearedEmbed], components: [] });
        } catch (err) {
          logger.warn('/th-queue clear: could not edit old queue embed', { error: err.message });
        }
      }

      storage.deleteQueue(game);
      logger.info('Queue cleared', { userId, game });
      return interaction.reply({ content: `✅ The **${game}** queue has been cleared.` });
    }
  },

  // Exported for button interaction dispatch in interactionCreate.js.
  // deferUpdate() is called first so Discord acknowledges the click instantly,
  // then processJoin/Leave use editReply() to update the message in-place.
  async handleButtonJoin(interaction, game) {
    await interaction.deferUpdate();
    return processJoin(interaction, game, interaction.user.id, interaction.user.username, {
      minOpt: null,
      maxOpt: null,
      timeStr: null,
    });
  },

  async handleButtonLeave(interaction, game) {
    await interaction.deferUpdate();
    return processLeave(interaction, game, interaction.user.id);
  },
};
