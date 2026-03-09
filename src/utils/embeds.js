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

  // ── Description: status + player limits + scheduled time ────────
  let description = `**Status:** ${status}`;
  if (min !== null) description += `\n👥 Min Players: ${min}`;
  if (max !== null) description += `\n🔒 Max Players: ${max}`;
  if (min === null && max === null) description += `\n👥 Players: Unlimited`;
  if (scheduledTime) {
    description += `\n\n📅 <t:${scheduledTime}:F> (<t:${scheduledTime}:R>)`;

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
          ? players.map((p, i) => `${i + 1}. <@${p.userId}>`).join('\n')
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
 * Returns an ActionRow with Join Queue / Leave Queue buttons for a game.
 * Custom IDs use the format "q:join:<game>" and "q:leave:<game>".
 */
function buildQueueComponents(game) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q:join:${game}`)
      .setLabel('Join Queue')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`q:leave:${game}`)
      .setLabel('Leave Queue')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Builds a closed-state embed for a queue that has ended.
 */
function buildClosedQueueEmbed(game) {
  return new EmbedBuilder()
    .setColor('#888888')
    .setTitle(`⏹️ ${game} — Queue Closed`)
    .setDescription('This queue has closed and is no longer accepting players.')
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

module.exports = { buildQueueEmbed, buildQueueComponents, buildClosedQueueEmbed, buildClosedQueueComponents };
