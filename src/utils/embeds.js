const { EmbedBuilder } = require('discord.js');
const storage = require('./storage');

/**
 * Builds the live-updating queue status embed.
 * Handles optional min/max thresholds and an optional scheduled time,
 * showing per-user local times via Discord Unix timestamps.
 */
function buildQueueEmbed(game, queueData) {
  const players = queueData.players || [];
  const count = players.length;
  const { min, max, scheduledTime } = queueData;

  // ── Status line ──────────────────────────────────────────────────
  let status;
  if (max !== null && count >= max) {
    status = '🔒 Queue Full!';
  } else if (min !== null && count >= min) {
    status = '✅ Minimum reached — ready to play!';
  } else {
    status = '⏳ Waiting for players...';
  }

  // ── Capacity display ─────────────────────────────────────────────
  let capacityStr = `${count} player${count !== 1 ? 's' : ''}`;
  if (min !== null && max !== null) capacityStr += ` (min ${min} / max ${max})`;
  else if (min !== null) capacityStr += ` (min ${min})`;
  else if (max !== null) capacityStr += ` / ${max} max`;

  // ── Scheduled time with per-user local times ─────────────────────
  let timeSection = '';
  if (scheduledTime) {
    timeSection = `\n\n📅 **Scheduled:** <t:${scheduledTime}:F> (<t:${scheduledTime}:R>)`;

    const timezones = storage.getTimezones();
    const playerTimes = players
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
      timeSection += `\n\n**Local Times:**\n${playerTimes.join('\n')}`;
    }
  }

  // ── Color ────────────────────────────────────────────────────────
  let color;
  if (max !== null && count >= max) color = '#FF6B6B';
  else if (min !== null && count >= min) color = '#00FF7F';
  else color = '#5865F2';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎮 Game Queue: ${game}`)
    .setDescription(`**Status:** ${status}\n**Players:** ${capacityStr}${timeSection}`)
    .addFields({
      name: `Players in Queue`,
      value:
        players.length > 0
          ? players.map((p, i) => `${i + 1}. <@${p.userId}>`).join('\n')
          : '*No players yet — be the first!*',
      inline: false,
    })
    .setFooter({ text: `Queue: ${game}` })
    .setTimestamp();
}

module.exports = { buildQueueEmbed };
