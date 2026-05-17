const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const storage = require('./storage');

/**
 * Builds the live-updating queue status embed showing the main queue,
 * optional fill list, scheduled time with per-user Discord timestamps,
 * and min/max threshold state.
 */
function buildQueueEmbed(game, queueData) {
  const players = queueData.players || [];
  const fill = queueData.fill || [];
  const count = players.length;
  const { min, max, scheduledTime } = queueData;

  // ── Status & color ───────────────────────────────────────────────
  let status, color;
  if (max !== null && count >= max) {
    status = '🔒 Queue Full!';
    color = '#FF6B6B';
  } else if (min !== null && count >= min) {
    status = '✅ Minimum reached — ready to play!';
    color = '#00FF7F';
  } else {
    status = '⏳ Waiting for players...';
    color = '#5865F2';
  }

  // ── Description: host + status + player limits + scheduled time ────
  const hostName = players[0]?.username ?? 'Unknown';
  let description = `*Started by ${hostName}*\n\n**Status:** ${status}`;
  if (min !== null) description += `\n👥 Min Players: ${min}`;
  if (max !== null) description += `\n🔒 Max Players: ${max}`;
  if (min === null && max === null) description += `\n👥 Players: Unlimited`;
  if (scheduledTime) {
    description += `\n\n📅 <t:${scheduledTime}:F> (<t:${scheduledTime}:R>)`;
    if (queueData.extendedTo) {
      description += `\n⏰ Rescheduled to <t:${queueData.extendedTo}:t>`;
    }

    // Per-user local times for everyone (main + fill)
    const timezones = storage.getTimezones();
    const everyone = [...players, ...fill];
    const playerTimes = everyone
      .map(p => {
        const tz = timezones[p.userId];
        if (!tz) return null;
        const localTime = new Date(scheduledTime * 1000).toLocaleString('en-US', {
          timeZone: tz,
          dateStyle: 'short',
          timeStyle: 'short',
        });
        return `<@${p.userId}>: \`${localTime}\` (${tz})`;
      })
      .filter(Boolean);

    if (playerTimes.length) {
      description += `\n\n**Local Times:**\n${playerTimes.join('\n')}`;
    }
  }

  // ── Build embed ──────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎮 ${game}`)
    .setDescription(description)
    .addFields({
      name: `👥 Players (${count})`,
      value:
        players.length > 0
          ? players.map(p => `• <@${p.userId}>`).join('\n')
          : '*No players yet — be the first!*',
      inline: false,
    });

  if (fill.length > 0) {
    embed.addFields({
      name: '🔄 Fill List',
      value: fill
        .map((p, i) => `${i + 1}. <@${p.userId}>${i === 0 ? ' *(first in line)*' : ''}`)
        .join('\n'),
      inline: false,
    });
  }

  if (max !== null && count >= max) {
    embed.addFields({
      name: '\u200b',
      value: '⚠️ Queue is full — you can still join as a fill player!',
      inline: false,
    });
  }

  embed.setFooter({ text: `Queue: ${game}` }).setTimestamp();

  return embed;
}

/**
 * Returns an ActionRow with Join Queue, Join as Fill, Leave Queue, and Edit Queue buttons.
 */
function buildQueueComponents(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:join:${game}`)
      .setLabel('Join Queue')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`q:join_fill:${game}`)
      .setLabel('Join as Fill')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`q:leave:${game}`)
      .setLabel('Leave Queue')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`q:edit:${game}`)
      .setLabel('Edit Queue')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`q:start_now:${game}`)
      .setLabel('Start Now')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success),
  );
}

/**
 * Returns an ActionRow with "Ready Up" and "Un-Ready" buttons for timed queues.
 * Both buttons are shared and affect only the player who clicks them.
 */
function buildReadyUpRow(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:ready:${game}`)
      .setLabel('Ready Up')
      .setEmoji('✋')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`q:unready:${game}`)
      .setLabel('Un-Ready')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Returns an ActionRow with three recovery options shown after host clicks No.
 */
function buildSessionNoOptionsRow(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:sno_extend:${game}`)
      .setLabel('Extend 30 Minutes')
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`q:sno_newtime:${game}`)
      .setLabel('Set New Time')
      .setEmoji('🕐')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`q:sno_close:${game}`)
      .setLabel('Close Queue')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Returns an ActionRow with Yes / No buttons for the host session prompt.
 */
function buildSessionPromptRow(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:session_yes:${game}`)
      .setLabel('Yes')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`q:session_no:${game}`)
      .setLabel('No')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Builds a live ready-up status embed showing per-player ready state.
 */
function buildReadyStatusEmbed(game, queueData) {
  const players = queueData.players ?? [];
  const readySet = new Set(queueData.readyPlayers ?? []);
  const readyCount = readySet.size;
  const totalPlayers = players.length;

  const lines = players.map(p =>
    readySet.has(p.userId) ? `✅ <@${p.userId}>` : `⏳ <@${p.userId}>`
  );

  const allReady = readyCount >= totalPlayers && totalPlayers > 0;

  return new EmbedBuilder()
    .setColor(allReady ? '#00FF7F' : '#FFD700')
    .setTitle(`✋ ${game} — Ready Up!`)
    .setDescription(
      `Session starts <t:${queueData.scheduledTime}:R>.\n\n` +
      `**${readyCount}/${totalPlayers} ready:**\n` +
      (lines.length > 0 ? lines.join('\n') : '*No players*')
    )
    .setTimestamp();
}

/**
 * Builds the post-session summary embed showing who played and trinket payouts.
 */
function buildSessionSummaryEmbed(game, queueData) {
  const {
    sessionPaidPlayers = [],
    playersAfterSession = [],
    sessionPaidFill = [],
    fillAfterSession = [],
    sessionStartedAt,
  } = queueData;

  const totalPlaying = sessionPaidPlayers.length + playersAfterSession.length;

  const playerLines = [
    ...sessionPaidPlayers.map(p =>
      p.amount > 0 ? `• <@${p.userId}> — **+${p.amount} 🪙**` : `• <@${p.userId}>`
    ),
    ...playersAfterSession.map(p => `• <@${p.userId}>`),
  ];
  const fillLines = [
    ...sessionPaidFill.map(p =>
      p.amount > 0 ? `• <@${p.userId}> — **+${p.amount} 🪙**` : `• <@${p.userId}>`
    ),
    ...fillAfterSession.map(p => `• <@${p.userId}>`),
  ];

  let description = `**Playing (${totalPlaying}):**\n`;
  description += playerLines.length > 0 ? playerLines.join('\n') : '*None*';
  description += '\n\n**Fill:**\n';
  description += fillLines.length > 0 ? fillLines.join('\n') : '*None*';

  return new EmbedBuilder()
    .setColor('#57F287')
    .setTitle(`🎮 ${game} — Session Started!`)
    .setDescription(description)
    .setFooter({ text: 'Session started' })
    .setTimestamp(sessionStartedAt ? sessionStartedAt * 1000 : Date.now());
}

/**
 * Returns an ActionRow with the appropriate join button(s) for the live session:
 *  - No max set           → Join Session only
 *  - Max set, spots open  → Join Session + Join as Fill
 *  - Max set, queue full  → Join as Fill only
 */
function buildSessionJoinRow(game, queueData) {
  const { max, sessionPaidPlayers = [], playersAfterSession = [] } = queueData;
  const totalPlaying = sessionPaidPlayers.length + playersAfterSession.length;
  const isFull       = max !== null && max !== undefined && totalPlaying >= max;
  const hasMax       = max !== null && max !== undefined;

  const joinSessionBtn = new ButtonBuilder()
    .setCustomId(`q:session_join:${game}`)
    .setLabel('Join Session')
    .setEmoji('🎮')
    .setStyle(ButtonStyle.Success);

  const joinFillBtn = new ButtonBuilder()
    .setCustomId(`q:session_fill:${game}`)
    .setLabel('Join as Fill')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Primary);

  if (!hasMax || !isFull) {
    // No max, or max set but spots still open — show Join Session (+ Fill if max is set)
    return new ActionRowBuilder().addComponents(
      ...(hasMax ? [joinSessionBtn, joinFillBtn] : [joinSessionBtn]),
    );
  }
  // Max set and full — only Fill
  return new ActionRowBuilder().addComponents(joinFillBtn);
}

/**
 * Builds a closed-state embed for a queue that has ended.
 */
function buildClosedQueueEmbed(game, queueData = null, reason = null) {
  const hostName = queueData?.players?.[0]?.username ?? null;
  let description = '';
  if (hostName) description += `*Started by ${hostName}*\n\n`;
  description += 'This queue has closed and is no longer accepting players.';
  if (reason) description += `\n\n${reason}`;
  return new EmbedBuilder()
    .setColor('#888888')
    .setTitle(`⏹️ ${game} — Queue Closed`)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Returns an ActionRow with a single disabled "Queue Closed" button.
 */
function buildClosedQueueComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('q:closed')
      .setLabel('Queue Closed')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

module.exports = {
  buildQueueEmbed,
  buildQueueComponents,
  buildReadyUpRow,
  buildReadyStatusEmbed,
  buildSessionPromptRow,
  buildSessionNoOptionsRow,
  buildSessionSummaryEmbed,
  buildSessionJoinRow,
  buildClosedQueueEmbed,
  buildClosedQueueComponents,
};
