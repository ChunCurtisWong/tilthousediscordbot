const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const logger  = require('../utils/logger');
const storage = require('../utils/storage');
const {
  buildQueueEmbed, buildQueueComponents, buildReadyUpRow,
  buildReadyStatusEmbed, buildSessionPromptRow, buildSessionNoOptionsRow,
  buildSessionSummaryEmbed, buildSessionFillRow,
  buildClosedQueueEmbed, buildClosedQueueComponents,
} = require('../utils/embeds');
const { payoutQueue }  = require('../utils/trinkets');
const {
  sendCloseNotification, markQueueEmbedClosed, sendSessionPrompt,
} = require('../utils/reminders');

// Host prompt re-send cooldown: 10 minutes
const HOST_PROMPT_COOLDOWN = 10 * 60 * 1000; // ms

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

function buildHostPromptRow(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:host_fulfilled:${game}`)
      .setLabel('Fulfilled')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`q:host_extend:${game}`)
      .setLabel('Extend')
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`q:host_clear:${game}`)
      .setLabel('Clear')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

// ─── Time parsing ─────────────────────────────────────────────────────────────

/**
 * Parses a natural time string (e.g. "7pm", "7:30 PM", "19:30") interpreted in
 * the given IANA timezone. Returns a UTC Unix timestamp (seconds), or null on failure.
 * Pure digit strings are treated as Unix timestamps and returned as-is.
 */
function parseNaturalTimeInTZ(timeStr, tz) {
  const trimmed = timeStr.trim();

  // Pass-through for raw Unix timestamps
  if (/^\d{9,12}$/.test(trimmed)) return parseInt(trimmed, 10);

  // Parse H[:MM][am/pm]
  const match = trimmed.replace(/\s+/g, '').match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i);
  if (!match) return null;

  let h = parseInt(match[1], 10);
  const m = parseInt(match[2] || '0', 10);
  const mer = (match[3] || '').toLowerCase();

  if (mer === 'pm' && h !== 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;

  // Get today's date components in the target timezone
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const yr = parseInt(parts.find(p => p.type === 'year').value);
  const mo = parseInt(parts.find(p => p.type === 'month').value);
  const dy = parseInt(parts.find(p => p.type === 'day').value);

  // Rough UTC candidate: treat the desired h:m as UTC, then adjust by timezone offset
  const rough = Date.UTC(yr, mo - 1, dy, h, m, 0);
  const dispParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(rough));
  const dh = parseInt(dispParts.find(p => p.type === 'hour').value) % 24;
  const dm = parseInt(dispParts.find(p => p.type === 'minute').value);

  let tsMs = rough - ((dh * 60 + dm) - (h * 60 + m)) * 60 * 1000;

  // Advance to next occurrence if in the past
  if (tsMs <= now.getTime()) tsMs += 24 * 60 * 60 * 1000;

  return Math.floor(tsMs / 1000);
}

/** Formats a Unix timestamp as a human-readable time in the given timezone, e.g. "7:30 PM". */
function formatTimeInTZ(unixSec, tz) {
  return new Date(unixSec * 1000).toLocaleString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function parseTime(timeStr) {
  const trimmed = timeStr.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

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
  if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  return null;
}

// ─── Response helper ──────────────────────────────────────────────────────────

function respond(interaction, opts) {
  if (!interaction.deferred) return interaction.reply({ ...opts, flags: 64 });
  if (interaction.isButton()) return interaction.followUp({ ...opts, flags: 64 });
  return interaction.editReply({ ...opts, components: [] });
}

// ─── Bulleted player list ─────────────────────────────────────────────────────

function bulletList(players) {
  return players.map(p => `• <@${p.userId}>`).join('\n');
}

// ─── Embed refresh ────────────────────────────────────────────────────────────

async function refreshEmbed(interaction, game, queueData) {
  const embed      = buildQueueEmbed(game, queueData);
  const components = [buildQueueComponents(game)];
  const content    = queueData.roleId ? `<@&${queueData.roleId}>` : null;

  if (interaction.isButton()) {
    await interaction.editReply({ content, embeds: [embed], components });
    queueData.messageId = interaction.message.id;
    queueData.channelId = interaction.channelId;
    return;
  }

  if (queueData.messageId && queueData.channelId) {
    try {
      const ch  = await interaction.client.channels.fetch(queueData.channelId);
      const msg = await ch.messages.fetch(queueData.messageId);
      await msg.edit({ content, embeds: [embed], components });
      return;
    } catch { /* Stored message gone — fall through */ }
  }

  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
  const msg = await channel.send({ content, embeds: [embed], components });
  queueData.messageId = msg.id;
  queueData.channelId = channel.id;
}

// ─── Message deletion helper ─────────────────────────────────────────────────

async function deleteMessageById(client, channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    const ch  = await client.channels.fetch(channelId);
    const msg = await ch.messages.fetch(messageId);
    await msg.delete();
  } catch { /* already deleted or inaccessible */ }
}

// ─── Host prompt (Case C) ─────────────────────────────────────────────────────

async function maybePromptHost(channel, game, queueData) {
  const now = Date.now();
  if (queueData.lastHostPromptAt && now - queueData.lastHostPromptAt < HOST_PROMPT_COOLDOWN) return;

  const host = queueData.players[0];
  if (!host) return;

  const count = queueData.players.length;
  const msg = await channel.send({
    content:
      `<@${host.userId}> You're the host of the **${game}** queue ` +
      `(${count} player${count !== 1 ? 's' : ''} so far). What would you like to do?`,
    components: [buildHostPromptRow(game)],
  });

  queueData.lastHostPromptAt    = now;
  queueData.hostPromptMessageId = msg.id;
  storage.saveQueue(game, queueData);
}

// ─── Threshold notification (Case B) ─────────────────────────────────────────

async function sendThresholdNotification(channel, game, queueData, type) {
  const { players, min, max, thresholdHitAt } = queueData;
  const pingList = players.map(p => `<@${p.userId}>`).join(' ');
  const closeTs  = thresholdHitAt + 1800;

  let title, desc, color;
  if (type === 'max') {
    title = `🔒 ${game} — Queue Full!`;
    desc  =
      `The queue is full with **${players.length}/${max}** players.\n` +
      `Closing <t:${closeTs}:R> — fill spots still available until then!\n\n` +
      `**Players:**\n${bulletList(players)}`;
    color = '#FF6B6B';
  } else {
    title = `✅ ${game} — Minimum Reached!`;
    desc  =
      `**${players.length}** players joined — minimum of **${min}** met!\n` +
      `Closing <t:${closeTs}:R>.\n\n` +
      `**Players:**\n${bulletList(players)}`;
    color = '#00FF7F';
  }

  await channel.send({
    content: pingList,
    embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp()],
  });
}

// ─── Join logic ───────────────────────────────────────────────────────────────

async function processJoin(interaction, game, userId, username, { minOpt, maxOpt, timeStr, roleId = null }) {
  const queueData = storage.getQueue(game);
  if (!queueData.fill) queueData.fill = [];
  if (roleId && !queueData.roleId) queueData.roleId = roleId;

  if (queueData.players.find(p => p.userId === userId)) {
    return respond(interaction, { content: `❌ You are already in the **${game}** queue.` });
  }
  if (queueData.fill.find(p => p.userId === userId)) {
    return respond(interaction, { content: `❌ You are already on the **${game}** fill list.` });
  }

  if (minOpt !== null && queueData.min === null) queueData.min = minOpt;
  if (maxOpt !== null && queueData.max === null) queueData.max = maxOpt;
  if (minOpt !== null && maxOpt !== null && minOpt >= maxOpt) {
    return respond(interaction, { content: '❌ `min` must be less than `max`.' });
  }

  if (timeStr && queueData.scheduledTime === null) {
    const ts = parseTime(timeStr);
    if (!ts) {
      return respond(interaction, {
        content: '❌ Could not parse the time. Try formats like:\n`7pm`  `7:30pm`  `19:00`  `2024-06-15T18:00:00Z`  `1718474400`',
      });
    }
    if (ts <= Math.floor(Date.now() / 1000)) {
      return respond(interaction, { content: '❌ The scheduled time must be in the future.' });
    }
    queueData.scheduledTime = ts;
  }

  const { max, min, scheduledTime } = queueData;
  if (!queueData.channelId) queueData.channelId = interaction.channelId;

  // Queue full → send to fill list
  if (max !== null && queueData.players.length >= max) {
    queueData.fill.push({ userId, username, joinedAt: Date.now() });
    storage.saveQueue(game, queueData);
    await refreshEmbed(interaction, game, queueData);
    storage.saveQueue(game, queueData);

    // Case B: record threshold the first time fill kicks in (no scheduled time)
    if (!scheduledTime && !queueData.thresholdHitAt) {
      queueData.thresholdHitAt = Math.floor(Date.now() / 1000);
      storage.saveQueue(game, queueData);
      const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
      await sendThresholdNotification(channel, game, queueData, 'max');
    }

    const pos = queueData.fill.length;
    logger.info('Player added to fill list', { userId, game, fillPosition: pos });
    return;
  }

  // Add to main queue
  queueData.players.push({ userId, username, joinedAt: Date.now() });
  queueData.lastActivityAt = Date.now();
  storage.saveQueue(game, queueData);
  await refreshEmbed(interaction, game, queueData);
  storage.saveQueue(game, queueData);

  const count   = queueData.players.length;
  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);

  logger.info('Player joined queue', { userId, game, count, min, max, scheduledTime });

  // ── Post-join notifications ──────────────────────────────────────
  const pingList = queueData.players.map(p => `<@${p.userId}>`).join(' ');

  if (scheduledTime) {
    // Case A: notify on thresholds — Trinket payout controlled by host, not a timer
    if (max !== null && count >= max) {
      await channel.send({
        content: `${pingList}\n🔒 The **${game}** queue is full!`,
        embeds: [
          new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle(`🔒 ${game} — Queue Full!`)
            .setDescription(
              `The queue is full with **${count}/${max}** players.\n` +
              `A ready-up check will begin 10 minutes before the session starts!\n\n` +
              `**Players:**\n${bulletList(queueData.players)}`
            )
            .setTimestamp(),
        ],
      });
    } else if (min !== null && count === min) {
      // Ping only at the exact moment min is first reached
      await channel.send({
        content: `${pingList}\n✅ The **${game}** queue has enough players!`,
        embeds: [
          new EmbedBuilder()
            .setColor('#00FF7F')
            .setTitle(`✅ ${game} — Minimum Reached!`)
            .setDescription(
              `**${count}** players joined — minimum of **${min}** met!\n` +
              `Session starts <t:${scheduledTime}:R>.\n\n` +
              `**Players:**\n${bulletList(queueData.players)}`
            )
            .setTimestamp(),
        ],
      });
    }
    return;
  }

  // Case B: has min or max, no scheduled time
  if (max !== null && count >= max && !queueData.thresholdHitAt) {
    queueData.thresholdHitAt = Math.floor(Date.now() / 1000);
    storage.saveQueue(game, queueData);
    await sendThresholdNotification(channel, game, queueData, 'max');
  } else if (min !== null && count >= min && !queueData.thresholdHitAt) {
    queueData.thresholdHitAt = Math.floor(Date.now() / 1000);
    storage.saveQueue(game, queueData);
    await sendThresholdNotification(channel, game, queueData, 'min');
  } else if (min === null && max === null && count > 1) {
    // Case C: no limits — prompt the host
    await maybePromptHost(channel, game, queueData);
  }
}

// ─── Leave logic ──────────────────────────────────────────────────────────────

async function processLeave(interaction, game, userId) {
  const queueData = storage.getQueue(game);
  if (!queueData.fill) queueData.fill = [];

  const playerIdx = queueData.players.findIndex(p => p.userId === userId);
  const fillIdx   = queueData.fill.findIndex(p => p.userId === userId);

  if (playerIdx === -1 && fillIdx === -1) {
    return respond(interaction, { content: `❌ You are not in the **${game}** queue or fill list.` });
  }

  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);

  if (playerIdx !== -1) {
    queueData.players.splice(playerIdx, 1);

    if (queueData.fill.length > 0) {
      const promoted = queueData.fill.shift();
      queueData.players.push(promoted);
      logger.info('Fill player promoted to main queue', { promotedUserId: promoted.userId, game });
      storage.saveQueue(game, queueData);
      await refreshEmbed(interaction, game, queueData);

      // If we're inside the ready-up window, the promoted player needs to ready up too
      if (queueData.readyWindowEnd && !queueData.sessionPromptSent) {
        await channel.send({
          content:
            `<@${promoted.userId}> You've been promoted to the **${game}** main queue! 🎮\n` +
            `Please ready up before the window closes <t:${queueData.readyWindowEnd}:R>!`,
          components: [buildReadyUpRow(game)],
        });
      } else {
        await channel.send({
          content: `<@${promoted.userId}> A spot opened up — you've been promoted from the fill list to the **${game}** main queue! 🎮`,
        });
      }
    } else {
      storage.saveQueue(game, queueData);
      await refreshEmbed(interaction, game, queueData);
      logger.info('Player left main queue', { userId, game, remaining: queueData.players.length });
    }

    return respond(interaction, { content: `✅ You left the **${game}** queue.` });
  }

  queueData.fill.splice(fillIdx, 1);
  storage.saveQueue(game, queueData);
  await refreshEmbed(interaction, game, queueData);
  logger.info('Player left fill list', { userId, game, fillRemaining: queueData.fill.length });
  return respond(interaction, { content: `✅ You've been removed from the **${game}** fill list.` });
}

// ─── Clear logic ──────────────────────────────────────────────────────────────

async function processClear(interaction, game, userId) {
  const queueData = storage.getQueue(game);
  const isHost    = queueData.players.length > 0 && queueData.players[0].userId === userId;
  const isMod     = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

  if (!isHost && !isMod) {
    return interaction.update({
      content: `❌ You are not the host of the **${game}** queue and do not have moderator permissions.`,
      components: [],
    });
  }

  await markQueueEmbedClosed(interaction.client, game, queueData);
  storage.deleteQueue(game);
  logger.info('Queue cleared', { userId, game });

  return interaction.update({ content: `✅ The **${game}** queue has been cleared.`, components: [] });
}

// ─── Command definition ─────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-queue')
    .setDescription('Manage game queues')
    .addSubcommand(sub =>
      sub.setName('create').setDescription('Create a new game queue')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game to queue for').setRequired(true).setAutocomplete(true)
        )
        .addStringOption(opt =>
          opt.setName('time').setDescription('Scheduled start time (e.g. 7pm, 7:30pm, 19:00)').setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('min_players').setDescription('Ping everyone when this many players have joined')
            .setMinValue(2).setMaxValue(100).setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('max_players').setDescription('Lock the queue and ping everyone when full')
            .setMinValue(2).setMaxValue(100).setRequired(false)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to ping when the queue is posted').setRequired(false)
        )
    )
    .addSubcommand(sub => sub.setName('join').setDescription('Join an existing active queue'))
    .addSubcommand(sub => sub.setName('leave').setDescription('Leave a queue or fill list you are in'))
    .addSubcommand(sub => sub.setName('status').setDescription('Show the current status of an active queue'))
    .addSubcommand(sub => sub.setName('clear').setDescription('Clear a game queue (host or moderator only)'))
    .addSubcommand(sub => sub.setName('clear-all').setDescription('Clear all active queues (moderator only)')),

  async execute(interaction) {
    const sub      = interaction.options.getSubcommand();
    const userId   = interaction.user.id;
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
            content: '❌ Could not parse the time. Try formats like:\n`7pm`  `7:30pm`  `19:00`  `2024-06-15T18:00:00Z`  `1718474400`',
            flags: 64,
          });
        }
        if (ts <= Math.floor(Date.now() / 1000)) {
          return interaction.reply({ content: '❌ The scheduled time must be in the future.', flags: 64 });
        }
      }

      if (minOpt !== null && maxOpt !== null && minOpt >= maxOpt) {
        return interaction.reply({ content: '❌ `min_players` must be less than `max_players`.', flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });
      await processJoin(interaction, game, userId, username, { timeStr: timeStr || null, minOpt, maxOpt, roleId });
      // Delete the deferred reply on success — the queue embed appearing is confirmation enough
      if (!interaction.replied) interaction.deleteReply().catch(() => {});
      return;
    }

    // ── /th-queue join ───────────────────────────────────────────────
    if (sub === 'join') {
      const queues = storage.getQueues();
      const active = Object.fromEntries(Object.entries(queues).filter(([, q]) => q.players || q.fill));
      if (Object.keys(active).length === 0) {
        return interaction.reply({
          content: '❌ There are no active queues to join. Use `/th-queue create` to start one!',
          flags: 64,
        });
      }
      return interaction.reply({ content: '🎮 Choose a queue to join:', components: [buildActiveQueueSelectRow(active)], flags: 64 });
    }

    // ── /th-queue leave ──────────────────────────────────────────────
    if (sub === 'leave') {
      const queues = storage.getQueues();
      const userQueues = Object.keys(queues).filter(game => {
        const q = queues[game];
        return q.players?.some(p => p.userId === userId) || q.fill?.some(p => p.userId === userId);
      });
      if (userQueues.length === 0) {
        return interaction.reply({ content: '❌ You are not in any active queue.', flags: 64 });
      }
      if (userQueues.length === 1) {
        await interaction.deferReply({ flags: 64 });
        return processLeave(interaction, userQueues[0], userId);
      }
      return interaction.reply({
        content: '🚪 You are in multiple queues. Which one do you want to leave?',
        components: [buildUserQueueSelectRow(userQueues)],
        flags: 64,
      });
    }

    // ── /th-queue status ─────────────────────────────────────────────
    if (sub === 'status') {
      const queues = storage.getQueues();
      if (Object.keys(queues).length === 0) {
        return interaction.reply({ content: '❌ There are no active queues at the moment.', flags: 64 });
      }
      const options = Object.entries(queues).slice(0, 25).map(([name, q]) => {
        const count = q.players?.length ?? 0;
        const fill  = q.fill?.length ?? 0;
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
          .setLabel(name.slice(0, 100)).setValue(name.slice(0, 100)).setDescription(desc.slice(0, 100));
      });
      return interaction.reply({
        content: '📋 Select a queue to view its status:',
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('q:status_select').setPlaceholder('Choose a queue to view…').addOptions(options)
        )],
        flags: 64,
      });
    }

    // ── /th-queue clear ──────────────────────────────────────────────
    if (sub === 'clear') {
      const queues    = storage.getQueues();
      const isMod     = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
      const clearable = Object.entries(queues).filter(([, q]) => isMod || q.players?.[0]?.userId === userId);

      if (clearable.length === 0) {
        const reason = Object.keys(queues).length === 0
          ? 'No active queues to clear.'
          : '❌ You are not the host of any active queue and do not have moderator permissions.';
        return interaction.reply({ content: reason, flags: 64 });
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
          .setLabel(name.slice(0, 100)).setValue(name.slice(0, 100)).setDescription(desc.slice(0, 100));
      });

      return interaction.reply({
        content: '🗑️ Select a queue to clear:',
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('q:clear_select').setPlaceholder('Choose a queue to clear…').addOptions(options)
        )],
        flags: 64,
      });
    }

    // ── /th-queue clear-all ──────────────────────────────────────────
    if (sub === 'clear-all') {
      const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
      if (!isMod) {
        return interaction.reply({
          content: '❌ Only moderators (Manage Channels permission) can clear all queues.',
          flags: 64,
        });
      }
      const queues = storage.getQueues();
      const count  = Object.keys(queues).length;
      if (count === 0) return interaction.reply({ content: '❌ There are no active queues to clear.', flags: 64 });

      return interaction.reply({
        content: `⚠️ Are you sure you want to clear **all ${count} active queue${count !== 1 ? 's' : ''}**? This cannot be undone.`,
        components: [buildClearAllConfirmRow()],
        flags: 64,
      });
    }
  },

  autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const suggestions = [...GAMES, 'Other']
      .filter(g => g.toLowerCase().includes(focused))
      .map(g => ({ name: g, value: g }));
    return interaction.respond(suggestions);
  },

  async handleJoinSelect(interaction) {
    await interaction.deferUpdate();
    const game = interaction.values[0];
    return processJoin(interaction, game, interaction.user.id, interaction.user.username, {
      minOpt: null, maxOpt: null, timeStr: null,
    });
  },

  async handleLeaveSelect(interaction) {
    await interaction.deferUpdate();
    return processLeave(interaction, interaction.values[0], interaction.user.id);
  },

  async handleClearAllButton(interaction) {
    const choice = interaction.customId.split(':')[2];
    if (choice === 'no') return interaction.update({ content: '❌ Cancelled.', components: [] });

    await interaction.deferUpdate();
    const queues    = storage.getQueues();
    const gameNames = Object.keys(queues);
    const userId    = interaction.user.id;
    logger.info('Clearing all queues', { userId, count: gameNames.length });

    for (const game of gameNames) {
      await markQueueEmbedClosed(interaction.client, game, queues[game]);
      storage.deleteQueue(game);
    }

    const n = gameNames.length;
    return interaction.editReply({ content: `✅ Cleared **${n}** queue${n !== 1 ? 's' : ''}.`, components: [] });
  },

  async handleStatusSelect(interaction) {
    const game      = interaction.values[0];
    const queueData = storage.getQueue(game);
    return interaction.update({
      content: null,
      embeds: [buildQueueEmbed(game, queueData)],
      components: [buildQueueComponents(game)],
    });
  },

  handleClearSelect(interaction) {
    return processClear(interaction, interaction.values[0], interaction.user.id);
  },

  async handleButtonJoin(interaction, game) {
    await interaction.deferUpdate();
    return processJoin(interaction, game, interaction.user.id, interaction.user.username, {
      minOpt: null, maxOpt: null, timeStr: null,
    });
  },

  async handleButtonLeave(interaction, game) {
    await interaction.deferUpdate();
    return processLeave(interaction, game, interaction.user.id);
  },

  // ── Join as Fill button ─────────────────────────────────────────
  async handleButtonJoinFill(interaction, game) {
    await interaction.deferUpdate();
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;
    const username  = interaction.user.username;

    if (!queueData.fill) queueData.fill = [];

    if (queueData.players.find(p => p.userId === userId)) {
      return interaction.followUp({ content: `❌ You are already in the **${game}** main queue.`, flags: 64 });
    }
    if (queueData.fill.find(p => p.userId === userId)) {
      return interaction.followUp({ content: `❌ You are already on the **${game}** fill list.`, flags: 64 });
    }

    queueData.fill.push({ userId, username, joinedAt: Date.now() });
    storage.saveQueue(game, queueData);
    await refreshEmbed(interaction, game, queueData);
    storage.saveQueue(game, queueData);

    logger.info('Player joined fill list directly', { userId, game, fillPosition: queueData.fill.length });
  },

  // ── Edit Queue button (host only) ───────────────────────────────
  async handleButtonEdit(interaction, game) {
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length || queueData.players[0].userId !== userId) {
      return interaction.reply({ content: '❌ Only the queue host can edit the queue.', flags: 64 });
    }

    const modal = new ModalBuilder()
      .setCustomId(`q:edit_modal:${game}`)
      .setTitle(`Edit: ${game}`.slice(0, 45));

    const gameInput = new TextInputBuilder()
      .setCustomId('game_name')
      .setLabel('Game Name')
      .setStyle(TextInputStyle.Short)
      .setValue(game)
      .setMaxLength(100)
      .setRequired(true);

    const hostTZ = storage.getUserTimezone(userId) ?? 'America/New_York';
    const timeInput = new TextInputBuilder()
      .setCustomId('scheduled_time')
      .setLabel('Set Time (blank=keep, "clear" to remove)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 7pm, 9:30pm · Uses your registered timezone (/th-timezone)')
      .setRequired(false);
    if (queueData.scheduledTime) timeInput.setValue(formatTimeInTZ(queueData.scheduledTime, hostTZ));

    const minInput = new TextInputBuilder()
      .setCustomId('min_players')
      .setLabel('Min Players (blank=keep, 0 to clear)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (queueData.min !== null) minInput.setValue(String(queueData.min));

    const maxInput = new TextInputBuilder()
      .setCustomId('max_players')
      .setLabel('Max Players (blank=keep, 0 to clear)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (queueData.max !== null) maxInput.setValue(String(queueData.max));

    modal.addComponents(
      new ActionRowBuilder().addComponents(gameInput),
      new ActionRowBuilder().addComponents(timeInput),
      new ActionRowBuilder().addComponents(minInput),
      new ActionRowBuilder().addComponents(maxInput),
    );

    return interaction.showModal(modal);
  },

  // ── Edit Queue modal submit ─────────────────────────────────────
  async handleEditModalSubmit(interaction, game) {
    await interaction.deferReply({ flags: 64 });
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length || queueData.players[0].userId !== userId) {
      return interaction.editReply({ content: '❌ Only the queue host can edit the queue.' });
    }

    const newGame  = interaction.fields.getTextInputValue('game_name').trim() || game;
    const rawTime  = interaction.fields.getTextInputValue('scheduled_time').trim();
    const rawMin   = interaction.fields.getTextInputValue('min_players').trim();
    const rawMax   = interaction.fields.getTextInputValue('max_players').trim();

    // Track whether a ready-up message is active before applying changes
    const oldReadyMessageId = queueData.readyMessageId;
    const hadReadyMessage   = !!oldReadyMessageId;
    const channelId         = queueData.channelId;

    // Apply scheduled time
    if (rawTime !== '') {
      if (rawTime.toLowerCase() === 'clear') {
        queueData.scheduledTime     = null;
        queueData.reminderSent      = false;
        queueData.readyWindowEnd    = null;
        queueData.readyPlayers      = [];
        queueData.sessionPromptSent = false;
      } else {
        const hostTZ = storage.getUserTimezone(userId) ?? 'America/New_York';
        const ts = parseNaturalTimeInTZ(rawTime, hostTZ);
        if (!ts) {
          return interaction.editReply({
            content: '❌ Could not parse the time. Try formats like `7pm`, `7:30pm`, or `19:30`.',
          });
        }
        queueData.scheduledTime     = ts;
        queueData.reminderSent      = false;
        queueData.readyWindowEnd    = null;
        queueData.readyPlayers      = [];
        queueData.sessionPromptSent = false;
      }
    }

    // Apply min players
    if (rawMin !== '') {
      const minVal = parseInt(rawMin, 10);
      if (isNaN(minVal) || minVal < 0) {
        return interaction.editReply({ content: '❌ Min players must be a number (or 0 to clear).' });
      }
      queueData.min = minVal === 0 ? null : minVal;
    }

    // Apply max players
    if (rawMax !== '') {
      const maxVal = parseInt(rawMax, 10);
      if (isNaN(maxVal) || maxVal < 0) {
        return interaction.editReply({ content: '❌ Max players must be a number (or 0 to clear).' });
      }
      queueData.max = maxVal === 0 ? null : maxVal;
    }

    if (queueData.min !== null && queueData.max !== null && queueData.min >= queueData.max) {
      return interaction.editReply({ content: '❌ Min players must be less than max players.' });
    }

    // Reset ready-up state if a ready-up message was active
    if (hadReadyMessage) {
      queueData.readyPlayers      = [];
      queueData.readyMessageId    = null;
      queueData.sessionPromptSent = false;
    }

    // Handle rename + save
    if (newGame !== game) {
      storage.deleteQueue(game);
      storage.saveQueue(newGame, queueData);
    } else {
      storage.saveQueue(game, queueData);
    }

    await refreshEmbed(interaction, newGame, queueData);
    storage.saveQueue(newGame, queueData);

    // Handle ready-up message reset
    if (hadReadyMessage && channelId) {
      await deleteMessageById(interaction.client, channelId, oldReadyMessageId);

      // Repost if the ready window is still active after edits
      if (queueData.readyWindowEnd && queueData.readyWindowEnd > Math.floor(Date.now() / 1000)) {
        try {
          const ch       = await interaction.client.channels.fetch(channelId);
          const pingList = (queueData.players ?? []).map(p => `<@${p.userId}>`).join(' ');
          const sentMsg  = await ch.send({
            content:    `${pingList}\n🔄 **${newGame}** queue updated — please ready up again!`,
            embeds:     [buildReadyStatusEmbed(newGame, queueData)],
            components: [buildReadyUpRow(newGame)],
          });
          queueData.readyMessageId = sentMsg.id;
          storage.saveQueue(newGame, queueData);
        } catch (err) {
          logger.error('Failed to repost ready-up after edit', { game: newGame, error: err.message });
        }
      }
    }

    interaction.deleteReply().catch(() => {});
    logger.info('Queue edited by host', { game, newGame, userId });
  },

  // ── Ready Up button ─────────────────────────────────────────────
  async handleButtonReady(interaction, game) {
    await interaction.deferUpdate();
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length) {
      return interaction.followUp({ content: '❌ This queue no longer exists.', flags: 64 });
    }
    if (!queueData.readyWindowEnd || queueData.sessionPromptSent) {
      return interaction.followUp({ content: '❌ The ready-up window for this queue is not active.', flags: 64 });
    }

    const isInQueue = queueData.players.some(p => p.userId === userId);
    if (!isInQueue) {
      return interaction.followUp({ content: `❌ You are not in the **${game}** main queue.`, flags: 64 });
    }

    if (!queueData.readyPlayers) queueData.readyPlayers = [];
    if (queueData.readyPlayers.includes(userId)) {
      return interaction.followUp({ content: `✅ You have already readied up for **${game}**!`, flags: 64 });
    }

    queueData.readyPlayers.push(userId);
    if (!queueData.readyMessageId) queueData.readyMessageId = interaction.message.id;
    storage.saveQueue(game, queueData);

    const totalPlayers = queueData.players.length;
    const readyCount   = queueData.readyPlayers.length;
    const allReady     = readyCount >= totalPlayers;

    // Update the ready-up embed with live per-player status
    await interaction.editReply({
      embeds: [buildReadyStatusEmbed(game, queueData)],
      components: allReady ? [] : [buildReadyUpRow(game)],
    });

    // All ready — send host prompt now if scheduled time has passed; otherwise let poller handle it
    if (allReady) {
      const now = Math.floor(Date.now() / 1000);
      if (!queueData.scheduledTime || queueData.scheduledTime <= now) {
        queueData.sessionPromptSent = true;
        storage.saveQueue(game, queueData);
        const channel = interaction.channel ?? await interaction.client.channels.fetch(queueData.channelId);
        await sendSessionPrompt(channel, game, queueData);
        logger.info('All players ready — session prompt sent immediately', { game, readyCount });
      } else {
        logger.info('All players ready — waiting for scheduled time to prompt host', {
          game, readyCount, scheduledTime: queueData.scheduledTime,
        });
      }
    }
  },

  // ── Session prompt: Yes ─────────────────────────────────────────
  async handleSessionYes(interaction, game) {
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length || queueData.players[0].userId !== userId) {
      return interaction.reply({ content: '❌ Only the queue host can use this button.', flags: 64 });
    }

    // Compute payout (filter fill to window only)
    const windowStartSec = queueData.thresholdHitAt ?? queueData.fulfilledAt ?? queueData.scheduledTime;
    const windowStartMs  = windowStartSec ? windowStartSec * 1000 : 0;
    const filteredFill   = (queueData.fill ?? []).filter(p => p.joinedAt >= windowStartMs);
    const payoutResult   = await payoutQueue({ ...queueData, fill: filteredFill });

    // Build payout maps
    const playerAmountMap = new Map();
    const fillAmountMap   = new Map();
    if (payoutResult?.ok) {
      for (const p of payoutResult.playerPayouts) playerAmountMap.set(p.userId, p.amount);
      for (const p of payoutResult.fillPayouts)   fillAmountMap.set(p.userId, p.amount);
    }

    const now = Math.floor(Date.now() / 1000);

    // Transition queue to session-started state
    queueData.sessionStarted     = true;
    queueData.sessionStartedAt   = now;
    queueData.sessionPaidPlayers = queueData.players.map(p => ({
      userId: p.userId, amount: playerAmountMap.get(p.userId) ?? 0,
    }));
    queueData.sessionPaidFill  = filteredFill.map(p => ({
      userId: p.userId, amount: fillAmountMap.get(p.userId) ?? 0,
    }));
    queueData.fillAfterSession = [];
    storage.saveQueue(game, queueData);

    // Replace host confirmation with session summary
    await interaction.update({
      content: null,
      embeds:  [buildSessionSummaryEmbed(game, queueData)],
      components: [buildSessionFillRow(game)],
    });

    // Delete original queue embed and ready-up message
    await deleteMessageById(interaction.client, queueData.channelId, queueData.messageId);
    await deleteMessageById(interaction.client, queueData.channelId, queueData.readyMessageId);

    logger.info('Queue session started', { game, userId });
  },

  // ── Session prompt: No ──────────────────────────────────────────
  async handleSessionNo(interaction, game) {
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length || queueData.players[0].userId !== userId) {
      return interaction.reply({ content: '❌ Only the queue host can use this button.', flags: 64 });
    }

    await interaction.update({
      content: null,
      embeds: [
        new EmbedBuilder()
          .setColor('#888888')
          .setTitle(`⏹️ ${game} — Session Not Started`)
          .setDescription('What would you like to do?')
          .setTimestamp(),
      ],
      components: [buildSessionNoOptionsRow(game)],
    });

    logger.info('Session not started — options shown to host', { game, userId });
  },

  // ── Session No: Extend 30 minutes ───────────────────────────────
  async handleSessionNoExtend(interaction, game) {
    await interaction.deferUpdate();
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length || queueData.players[0].userId !== userId) {
      return interaction.followUp({ content: '❌ Only the queue host can use this button.', flags: 64 });
    }

    const now              = Math.floor(Date.now() / 1000);
    const newTime          = now + 1800;
    const oldReadyMessageId = queueData.readyMessageId;

    queueData.scheduledTime     = newTime;
    queueData.reminderSent      = false;
    queueData.readyWindowEnd    = null;
    queueData.readyPlayers      = [];
    queueData.readyMessageId    = null;
    queueData.sessionPromptSent = false;
    storage.saveQueue(game, queueData);

    await deleteMessageById(interaction.client, queueData.channelId, oldReadyMessageId);

    // Refresh the queue embed with the new scheduled time
    if (queueData.messageId && queueData.channelId) {
      try {
        const ch      = await interaction.client.channels.fetch(queueData.channelId);
        const queueMsg = await ch.messages.fetch(queueData.messageId);
        await queueMsg.edit({
          content:    queueData.roleId ? `<@&${queueData.roleId}>` : null,
          embeds:     [buildQueueEmbed(game, queueData)],
          components: [buildQueueComponents(game)],
        });
      } catch { /* Queue embed gone — fine */ }
    }

    const confirmMsg = await interaction.editReply({
      content: null,
      embeds: [
        new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(`⏰ ${game} — Extended 30 Minutes`)
          .setDescription(`Session rescheduled to <t:${newTime}:F>. Ready-up check will begin 10 minutes before.`)
          .setTimestamp(),
      ],
      components: [],
    });
    setTimeout(() => confirmMsg.delete().catch(() => {}), 10 * 60 * 1000);

    logger.info('Session extended by 30 minutes', { game, userId, newTime });
  },

  // ── Session No: Set New Time (opens modal) ───────────────────────
  async handleSessionNoNewTime(interaction, game) {
    const queueData = storage.getQueue(game);
    queueData.sessionNoMessageId = interaction.message.id;
    storage.saveQueue(game, queueData);

    const modal = new ModalBuilder()
      .setCustomId(`q:sno_modal:${game}`)
      .setTitle(`Set New Time: ${game}`.slice(0, 45));

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('new_time')
          .setLabel('New Start Time')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 8:30pm, 9pm · Uses your registered timezone (/th-timezone)')
          .setRequired(true),
      ),
    );

    return interaction.showModal(modal);
  },

  // ── Session No: Set New Time modal submit ────────────────────────
  async handleSessionNoNewTimeSubmit(interaction, game) {
    await interaction.deferReply({ flags: 64 });
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length || queueData.players[0].userId !== userId) {
      return interaction.editReply({ content: '❌ Only the queue host can use this.' });
    }

    const rawTime = interaction.fields.getTextInputValue('new_time').trim();
    const hostTZ  = storage.getUserTimezone(userId) ?? 'America/New_York';
    const ts      = parseNaturalTimeInTZ(rawTime, hostTZ);

    if (!ts) {
      return interaction.editReply({
        content: '❌ Could not parse the time. Try formats like `7pm`, `7:30pm`, or `19:30`.',
      });
    }
    if (ts <= Math.floor(Date.now() / 1000)) {
      return interaction.editReply({ content: '❌ The scheduled time must be in the future.' });
    }

    const oldReadyMessageId  = queueData.readyMessageId;
    const sessionNoMessageId = queueData.sessionNoMessageId;
    const channelId          = queueData.channelId;

    queueData.scheduledTime      = ts;
    queueData.reminderSent       = false;
    queueData.readyWindowEnd     = null;
    queueData.readyPlayers       = [];
    queueData.readyMessageId     = null;
    queueData.sessionNoMessageId = null;
    queueData.sessionPromptSent  = false;
    storage.saveQueue(game, queueData);

    await deleteMessageById(interaction.client, channelId, oldReadyMessageId);

    // Refresh the queue embed with the new scheduled time
    await refreshEmbed(interaction, game, queueData);
    storage.saveQueue(game, queueData);

    // Update the session-no options message to confirm the change, then auto-delete after 10 min
    if (sessionNoMessageId && channelId) {
      try {
        const ch  = await interaction.client.channels.fetch(channelId);
        const msg = await ch.messages.fetch(sessionNoMessageId);
        const confirmMsg = await msg.edit({
          content: null,
          embeds: [
            new EmbedBuilder()
              .setColor('#5865F2')
              .setTitle(`🕐 ${game} — New Time Set`)
              .setDescription(`Session rescheduled to <t:${ts}:F>. Ready-up check will begin 10 minutes before.`)
              .setTimestamp(),
          ],
          components: [],
        });
        setTimeout(() => confirmMsg.delete().catch(() => {}), 10 * 60 * 1000);
      } catch { /* Message gone — fine */ }
    }

    interaction.deleteReply().catch(() => {});
    logger.info('Session rescheduled to new time', { game, userId, ts });
  },

  // ── Session No: Close Queue ──────────────────────────────────────
  async handleSessionNoClose(interaction, game) {
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players?.length || queueData.players[0].userId !== userId) {
      return interaction.reply({ content: '❌ Only the queue host can use this button.', flags: 64 });
    }

    await interaction.update({
      content: null,
      embeds: [
        new EmbedBuilder()
          .setColor('#888888')
          .setTitle(`⏹️ ${game} — Queue Closed`)
          .setDescription('Queue closed.')
          .setTimestamp(),
      ],
      components: [],
    });

    await deleteMessageById(interaction.client, queueData.channelId, queueData.messageId);
    await deleteMessageById(interaction.client, queueData.channelId, queueData.readyMessageId);
    storage.deleteQueue(game);
    logger.info('Queue closed by host (no session)', { game, userId });
  },

  // ── Session fill button ─────────────────────────────────────────
  async handleSessionFill(interaction, game) {
    await interaction.deferUpdate();
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;
    const username  = interaction.user.username;

    if (!queueData?.sessionStarted) {
      return interaction.followUp({ content: '❌ This session is no longer active.', flags: 64 });
    }

    const alreadyIn = [
      ...(queueData.sessionPaidPlayers ?? []),
      ...(queueData.sessionPaidFill    ?? []),
      ...(queueData.fillAfterSession   ?? []),
    ].some(p => p.userId === userId);

    if (alreadyIn) {
      return interaction.followUp({ content: `❌ You are already in the **${game}** session.`, flags: 64 });
    }

    queueData.fillAfterSession = queueData.fillAfterSession ?? [];
    queueData.fillAfterSession.push({ userId, username });
    storage.saveQueue(game, queueData);

    await interaction.editReply({
      content: null,
      embeds:  [buildSessionSummaryEmbed(game, queueData)],
      components: [buildSessionFillRow(game)],
    });

    logger.info('Player joined session fill', { userId, game });
  },

  // ── Host prompt: Fulfilled ──────────────────────────────────────
  async handleHostFulfilled(interaction, game) {
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players.length || queueData.players[0].userId !== userId) {
      return interaction.reply({ content: '❌ Only the queue host can use this button.', flags: 64 });
    }

    const now     = Math.floor(Date.now() / 1000);
    const closeTs = now + 1800;
    queueData.fulfilledAt         = now;
    queueData.hostPromptMessageId = null;
    storage.saveQueue(game, queueData);

    const pingList = queueData.players.map(p => `<@${p.userId}>`).join(' ');
    await interaction.update({
      content: `✅ **${game}** marked as fulfilled — queue closes <t:${closeTs}:R>. Fill spots still available!`,
      components: [],
    });

    const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
    await channel.send({
      content: pingList,
      embeds: [
        new EmbedBuilder()
          .setColor('#00FF7F')
          .setTitle(`✅ ${game} — Queue Fulfilled!`)
          .setDescription(
            `The host has marked this queue as ready.\n` +
            `Queue closes <t:${closeTs}:R> — join as a fill player until then!\n\n` +
            `**Players:**\n${bulletList(queueData.players)}`
          )
          .setTimestamp(),
      ],
    });

    logger.info('Queue marked fulfilled by host', { game, userId, closeTs });
  },

  // ── Host prompt: Extend ─────────────────────────────────────────
  async handleHostExtend(interaction, game) {
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players.length || queueData.players[0].userId !== userId) {
      return interaction.reply({ content: '❌ Only the queue host can use this button.', flags: 64 });
    }

    // Add 30 minutes to lastActivityAt so the inactivity timer is pushed forward
    queueData.lastActivityAt      = (queueData.lastActivityAt ?? Date.now()) + 30 * 60 * 1000;
    queueData.hostPromptMessageId = null;
    storage.saveQueue(game, queueData);

    await interaction.update({ content: `⏰ Timer extended by 30 minutes for **${game}**.`, components: [] });
    logger.info('Queue timer extended by host', { game, userId });
  },

  // ── Host prompt: Clear ──────────────────────────────────────────
  async handleHostClear(interaction, game) {
    const queueData = storage.getQueue(game);
    const userId    = interaction.user.id;

    if (!queueData.players.length || queueData.players[0].userId !== userId) {
      return interaction.reply({ content: '❌ Only the queue host can use this button.', flags: 64 });
    }

    await markQueueEmbedClosed(interaction.client, game, queueData);
    storage.deleteQueue(game);

    await interaction.update({ content: `✅ The **${game}** queue has been cleared.`, components: [] });
    logger.info('Queue cleared by host via prompt', { game, userId });
  },
};
