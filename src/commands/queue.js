const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { buildQueueEmbed, buildQueueComponents } = require('../utils/embeds');
const { payoutQueue, getNextDailyReset } = require('../utils/trinkets');

// ─── Game list ───────────────────────────────────────────────────────────────

const GAMES = [
  'Counter Strike',
  'League of Legends (SR)',
  'League of Legends (ARAM)',
  'Valorant',
  'Rainbow 6 Siege',
  'Minecraft',
  'MW2 (Michael Myers)',
];

// ─── UI builders ─────────────────────────────────────────────────────────────

/** Dropdown of currently active queues — used for joining an existing queue. */
function buildActiveQueueSelectRow(queues) {
  const options = Object.entries(queues)
    .slice(0, 25)
    .map(([name, q]) => {
      const count = q.players?.length ?? 0;
      const fill = q.fill?.length ?? 0;
      let desc = `${count} player${count !== 1 ? 's' : ''}`;
      if (fill > 0) desc += `, ${fill} on fill`;
      if (q.scheduledTime) {
        const secsLeft = q.scheduledTime - Math.floor(Date.now() / 1000);
        if (secsLeft > 0) {
          const h = Math.floor(secsLeft / 3600);
          const m = Math.ceil((secsLeft % 3600) / 60);
          desc += h > 0 ? ` · in ${h}h ${m}m` : ` · in ${m}m`;
        }
      }
      return new StringSelectMenuOptionBuilder()
        .setLabel(name.slice(0, 100))
        .setValue(name.slice(0, 100))
        .setDescription(desc.slice(0, 100));
    });

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('q:join_select')
      .setPlaceholder('Choose a queue to join…')
      .addOptions(options)
  );
}

/** Dropdown of queues the user is currently in — used for smart leave. */
function buildUserQueueSelectRow(gameNames) {
  const options = gameNames.slice(0, 25).map(name =>
    new StringSelectMenuOptionBuilder()
      .setLabel(name.slice(0, 100))
      .setValue(name.slice(0, 100))
  );

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('q:leave_select')
      .setPlaceholder('Choose a queue to leave…')
      .addOptions(options)
  );
}

/** Yes / Cancel buttons for /th-queue clear-all confirmation. */
function buildClearAllConfirmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('q:clear_all:yes')
      .setLabel('Yes, clear all')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️'),
    new ButtonBuilder()
      .setCustomId('q:clear_all:no')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✖️'),
  );
}

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
 * Sends an ephemeral confirmation appropriate to the interaction type:
 *
 *  - Not deferred (slash command)  → reply({ ephemeral: true })
 *  - Button (deferred via deferUpdate) → followUp({ ephemeral: true })
 *  - Select menu or modal (deferred via deferUpdate / deferReply)
 *    → editReply({ components: [] })
 */
function respond(interaction, opts) {
  if (!interaction.deferred) {
    return interaction.reply({ ...opts, ephemeral: true });
  }
  if (interaction.isButton()) {
    return interaction.followUp({ ...opts, ephemeral: true });
  }
  return interaction.editReply({ ...opts, components: [] });
}

/**
 * Updates the live queue embed with the current state.
 *
 * Button path  → interaction.editReply() edits the message the button lives on.
 * Slash path   → edits the stored embed message by ID, or posts a new one
 *               if the original was deleted.
 */
async function refreshEmbed(interaction, game, queueData) {
  const embed = buildQueueEmbed(game, queueData);
  const components = [buildQueueComponents(game)];
  // Role mention sits as message content so Discord shows it above the embed.
  // Using content on edits is safe — Discord does not re-notify on message edits.
  const content = queueData.roleId ? `<@&${queueData.roleId}>` : null;

  if (interaction.isButton()) {
    await interaction.editReply({ content, embeds: [embed], components });
    queueData.messageId = interaction.message.id;
    queueData.channelId = interaction.channelId;
    return;
  }

  if (queueData.messageId && queueData.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(queueData.channelId);
      const msg = await ch.messages.fetch(queueData.messageId);
      await msg.edit({ content, embeds: [embed], components });
      return;
    } catch {
      // Stored message is gone — fall through to posting a new one
    }
  }

  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
  const msg = await channel.send({ content, embeds: [embed], components });
  queueData.messageId = msg.id;
  queueData.channelId = channel.id;
}

// ─── Shared join logic ──────────────────────────────────────────────────────

async function processJoin(interaction, game, userId, username, { minOpt, maxOpt, timeStr, roleId = null }) {
  const queueData = storage.getQueue(game);
  if (!queueData.fill) queueData.fill = [];
  if (roleId && !queueData.roleId) queueData.roleId = roleId;

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
    storage.saveQueue(game, queueData);
    await refreshEmbed(interaction, game, queueData);

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
  storage.saveQueue(game, queueData);
  await refreshEmbed(interaction, game, queueData);

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

  // ── Max reached: ping everyone, pay out trinkets, close queue ────
  if (max !== null && count >= max) {
    logger.info('Queue max reached', { game, count, max });

    // Payout trinkets before deleting queue data
    const { playerPayouts, fillPayouts, ineligible } = payoutQueue(queueData);

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

    // Public payout embed (eligible players only)
    const payoutLines = [
      ...playerPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙**`),
      ...fillPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙** (fill)`),
    ];
    if (payoutLines.length > 0) {
      const payoutEmbed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🪙 Trinket Payout')
        .setDescription(`Queue closed naturally — Trinkets awarded!\n\n${payoutLines.join('\n')}`);
      await channel.send({ embeds: [payoutEmbed] });
    }

    // DM players who already hit their daily queue Trinket limit
    const resetTs = Math.floor(getNextDailyReset() / 1000);
    for (const p of ineligible) {
      try {
        const user = await interaction.client.users.fetch(p.userId);
        await user.send(
          `You joined the **${game}** queue but you've already earned your queue Trinkets for today. ` +
            `They reset <t:${resetTs}:R> — join a queue after that to earn more! 🪙`
        );
      } catch {
        // DMs may be disabled — silently skip
      }
    }

    storage.deleteQueue(game);
    return;
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
  // Note: 10-minute reminder pings are handled exclusively by reminders.js
  // to avoid duplicate pings from concurrent code paths.
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

      storage.saveQueue(game, queueData);
      await refreshEmbed(interaction, game, queueData);

      await channel.send({
        content: `<@${promoted.userId}> A spot opened up — you've been promoted from the fill list to the **${game}** main queue! 🎮`,
      });
    } else {
      storage.saveQueue(game, queueData);
      await refreshEmbed(interaction, game, queueData);
      logger.info('Player left main queue', { userId, game, remaining: queueData.players.length });
    }

    return respond(interaction, { content: `✅ You left the **${game}** queue.` });
  }

  // ── Leaving fill list ────────────────────────────────────────────
  queueData.fill.splice(fillIdx, 1);
  storage.saveQueue(game, queueData);
  await refreshEmbed(interaction, game, queueData);

  logger.info('Player left fill list', { userId, game, fillRemaining: queueData.fill.length });
  return respond(interaction, { content: `✅ You've been removed from the **${game}** fill list.` });
}

// ─── Clear logic ────────────────────────────────────────────────────────────

async function processClear(interaction, game, userId) {
  const queueData = storage.getQueue(game);
  const isHost = queueData.players.length > 0 && queueData.players[0].userId === userId;
  const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

  if (!isHost && !isMod) {
    return interaction.update({
      content: `❌ You are not the host of the **${game}** queue and do not have moderator permissions.`,
      components: [],
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
      logger.warn('processClear: could not edit old queue embed', { error: err.message });
    }
  }

  storage.deleteQueue(game);
  logger.info('Queue cleared', { userId, game });

  return interaction.update({
    content: `✅ The **${game}** queue has been cleared.`,
    components: [],
  });
}

// ─── Command definition ─────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-queue')
    .setDescription('Manage game queues')
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription('Create a new game queue')
        .addStringOption(opt =>
          opt
            .setName('game')
            .setDescription('Game to queue for')
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption(opt =>
          opt
            .setName('time')
            .setDescription('Scheduled start time (e.g. 7pm, 7:30pm, 19:00)')
            .setRequired(false)
        )
        .addIntegerOption(opt =>
          opt
            .setName('min_players')
            .setDescription('Ping everyone when this many players have joined')
            .setMinValue(2)
            .setMaxValue(100)
            .setRequired(false)
        )
        .addIntegerOption(opt =>
          opt
            .setName('max_players')
            .setDescription('Lock the queue and ping everyone when full')
            .setMinValue(2)
            .setMaxValue(100)
            .setRequired(false)
        )
        .addRoleOption(opt =>
          opt
            .setName('role')
            .setDescription('Role to ping when the queue is posted')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('join')
        .setDescription('Join an existing active queue')
    )
    .addSubcommand(sub =>
      sub
        .setName('leave')
        .setDescription('Leave a queue or fill list you are in')
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show the current status of an active queue')
    )
    .addSubcommand(sub =>
      sub
        .setName('clear')
        .setDescription('Clear a game queue (host or moderator only)')
    )
    .addSubcommand(sub =>
      sub
        .setName('clear-all')
        .setDescription('Clear all active queues (moderator only)')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.username;

    logger.info(`Command: /th-queue ${sub}`, { userId, username });

    // ── /th-queue create ─────────────────────────────────────────────
    if (sub === 'create') {
      const game    = interaction.options.getString('game').trim();
      const timeStr = interaction.options.getString('time')?.trim() ?? '';
      const minOpt  = interaction.options.getInteger('min_players') ?? null;
      const maxOpt  = interaction.options.getInteger('max_players') ?? null;
      const roleId  = interaction.options.getRole('role')?.id ?? null;

      if (timeStr) {
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
      }

      if (minOpt !== null && maxOpt !== null && minOpt >= maxOpt) {
        return interaction.reply({
          content: '❌ `min_players` must be less than `max_players`.',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      return processJoin(interaction, game, userId, username, {
        timeStr: timeStr || null,
        minOpt,
        maxOpt,
        roleId,
      });
    }

    // ── /th-queue join ───────────────────────────────────────────────
    // Shows dropdown of currently active queues to join
    if (sub === 'join') {
      const queues = storage.getQueues();
      const activeQueues = Object.fromEntries(
        Object.entries(queues).filter(([, q]) => q.players || q.fill)
      );

      if (Object.keys(activeQueues).length === 0) {
        return interaction.reply({
          content: '❌ There are no active queues to join. Use `/th-queue create` to start one!',
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: '🎮 Choose a queue to join:',
        components: [buildActiveQueueSelectRow(activeQueues)],
        ephemeral: true,
      });
    }

    // ── /th-queue leave ──────────────────────────────────────────────
    // Smart leave: immediate if in 1 queue, dropdown if in multiple
    if (sub === 'leave') {
      const queues = storage.getQueues();
      const userQueues = Object.keys(queues).filter(game => {
        const q = queues[game];
        return (
          q.players?.some(p => p.userId === userId) ||
          q.fill?.some(p => p.userId === userId)
        );
      });

      if (userQueues.length === 0) {
        return interaction.reply({
          content: '❌ You are not in any active queue.',
          ephemeral: true,
        });
      }

      if (userQueues.length === 1) {
        await interaction.deferReply({ ephemeral: true });
        return processLeave(interaction, userQueues[0], userId);
      }

      return interaction.reply({
        content: '🚪 You are in multiple queues. Which one do you want to leave?',
        components: [buildUserQueueSelectRow(userQueues)],
        ephemeral: true,
      });
    }

    // ── /th-queue status ─────────────────────────────────────────────
    if (sub === 'status') {
      const queues = storage.getQueues();

      if (Object.keys(queues).length === 0) {
        return interaction.reply({
          content: '❌ There are no active queues at the moment.',
          ephemeral: true,
        });
      }

      const options = Object.entries(queues)
        .slice(0, 25)
        .map(([name, q]) => {
          const count = q.players?.length ?? 0;
          const fill = q.fill?.length ?? 0;
          let desc = `${count} player${count !== 1 ? 's' : ''}`;
          if (fill > 0) desc += `, ${fill} on fill`;
          if (q.scheduledTime) {
            const secsLeft = q.scheduledTime - Math.floor(Date.now() / 1000);
            if (secsLeft > 0) {
              const h = Math.floor(secsLeft / 3600);
              const m = Math.ceil((secsLeft % 3600) / 60);
              desc += h > 0 ? ` · in ${h}h ${m}m` : ` · in ${m}m`;
            }
          }
          return new StringSelectMenuOptionBuilder()
            .setLabel(name.slice(0, 100))
            .setValue(name.slice(0, 100))
            .setDescription(desc.slice(0, 100));
        });

      const select = new StringSelectMenuBuilder()
        .setCustomId('q:status_select')
        .setPlaceholder('Choose a queue to view…')
        .addOptions(options);

      return interaction.reply({
        content: '📋 Select a queue to view its status:',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // ── /th-queue clear ──────────────────────────────────────────────
    if (sub === 'clear') {
      const queues = storage.getQueues();
      const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      const clearable = Object.entries(queues).filter(([, q]) =>
        isMod || q.players?.[0]?.userId === userId
      );

      if (clearable.length === 0) {
        const reason = Object.keys(queues).length === 0
          ? 'No active queues to clear.'
          : '❌ You are not the host of any active queue and do not have moderator permissions.';
        return interaction.reply({ content: reason, ephemeral: true });
      }

      const options = clearable.slice(0, 25).map(([name, q]) => {
        const count = q.players?.length ?? 0;
        const fill = q.fill?.length ?? 0;
        let desc = `${count} player${count !== 1 ? 's' : ''}`;
        if (fill > 0) desc += `, ${fill} on fill`;
        if (q.scheduledTime) {
          const secsLeft = q.scheduledTime - Math.floor(Date.now() / 1000);
          if (secsLeft > 0) {
            const h = Math.floor(secsLeft / 3600);
            const m = Math.ceil((secsLeft % 3600) / 60);
            desc += h > 0 ? ` · in ${h}h ${m}m` : ` · in ${m}m`;
          }
        }
        return new StringSelectMenuOptionBuilder()
          .setLabel(name.slice(0, 100))
          .setValue(name.slice(0, 100))
          .setDescription(desc.slice(0, 100));
      });

      const select = new StringSelectMenuBuilder()
        .setCustomId('q:clear_select')
        .setPlaceholder('Choose a queue to clear…')
        .addOptions(options);

      return interaction.reply({
        content: '🗑️ Select a queue to clear:',
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    }

    // ── /th-queue clear-all ──────────────────────────────────────────
    if (sub === 'clear-all') {
      const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
      if (!isMod) {
        return interaction.reply({
          content: '❌ Only moderators (Manage Channels permission) can clear all queues.',
          ephemeral: true,
        });
      }

      const queues = storage.getQueues();
      const count = Object.keys(queues).length;

      if (count === 0) {
        return interaction.reply({ content: '❌ There are no active queues to clear.', ephemeral: true });
      }

      return interaction.reply({
        content: `⚠️ Are you sure you want to clear **all ${count} active queue${count !== 1 ? 's' : ''}**? This cannot be undone.`,
        components: [buildClearAllConfirmRow()],
        ephemeral: true,
      });
    }
  },

  // ── Autocomplete for /th-queue create game: ───────────────────────
  autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const suggestions = [...GAMES, 'Other']
      .filter(g => g.toLowerCase().includes(focused))
      .map(g => ({ name: g, value: g }));
    return interaction.respond(suggestions);
  },

  // ── Join select menu: user picked an active queue to join ──────────
  async handleJoinSelect(interaction) {
    await interaction.deferUpdate();
    const game = interaction.values[0];
    return processJoin(interaction, game, interaction.user.id, interaction.user.username, {
      minOpt: null,
      maxOpt: null,
      timeStr: null,
    });
  },

  // ── Leave select menu: user picked which queue to leave ───────────
  async handleLeaveSelect(interaction) {
    await interaction.deferUpdate();
    const game = interaction.values[0];
    return processLeave(interaction, game, interaction.user.id);
  },

  // ── Clear-all confirmation buttons ────────────────────────────────
  async handleClearAllButton(interaction) {
    const choice = interaction.customId.split(':')[2]; // 'yes' or 'no'

    if (choice === 'no') {
      return interaction.update({ content: '❌ Cancelled.', components: [] });
    }

    // Yes: clear all queues
    await interaction.deferUpdate();

    const queues = storage.getQueues();
    const gameNames = Object.keys(queues);
    const userId = interaction.user.id;

    logger.info('Clearing all queues', { userId, count: gameNames.length });

    for (const game of gameNames) {
      const q = queues[game];
      if (q.messageId && q.channelId) {
        try {
          const ch = await interaction.client.channels.fetch(q.channelId);
          const msg = await ch.messages.fetch(q.messageId);
          const clearedEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle(`🚫 Queue Cleared: ${game}`)
            .setDescription(`The **${game}** queue was cleared by <@${userId}>.`)
            .setTimestamp();
          await msg.edit({ embeds: [clearedEmbed], components: [] });
        } catch (err) {
          logger.warn('handleClearAllButton: could not edit queue embed', { game, error: err.message });
        }
      }
      storage.deleteQueue(game);
    }

    const n = gameNames.length;
    return interaction.editReply({
      content: `✅ Cleared **${n}** queue${n !== 1 ? 's' : ''}.`,
      components: [],
    });
  },

  // ── Status select menu: show the chosen queue's embed (ephemeral) ──
  async handleStatusSelect(interaction) {
    const game = interaction.values[0];
    const queueData = storage.getQueue(game);
    return interaction.update({
      content: null,
      embeds: [buildQueueEmbed(game, queueData)],
      components: [buildQueueComponents(game)],
    });
  },

  // ── Clear select menu ──────────────────────────────────────────────
  handleClearSelect(interaction) {
    return processClear(interaction, interaction.values[0], interaction.user.id);
  },

  // ── Queue embed buttons ────────────────────────────────────────────
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
