const { EmbedBuilder } = require('discord.js');
const storage = require('./storage');

/**
 * Builds the live-updating queue status embed.
 */
function buildQueueEmbed(game, queueData) {
  const threshold = queueData.threshold || 5;
  const players = queueData.players || [];
  const filled = players.length;
  const barLength = Math.min(threshold, 20);
  const progressBar =
    '█'.repeat(Math.min(filled, barLength)) +
    '░'.repeat(Math.max(0, barLength - filled));

  return new EmbedBuilder()
    .setColor(filled >= threshold ? '#00FF7F' : '#5865F2')
    .setTitle(`🎮 Game Queue: ${game}`)
    .setDescription(
      `**Status:** ${filled >= threshold ? '✅ Queue Full!' : '⏳ Waiting for players...'}\n\n` +
        `**Progress:** \`[${progressBar}]\` ${filled}/${threshold}`
    )
    .addFields({
      name: `Players in Queue (${filled}/${threshold})`,
      value:
        players.length > 0
          ? players.map((p, i) => `${i + 1}. <@${p.userId}>`).join('\n')
          : '*No players yet — be the first!*',
      inline: false,
    })
    .setFooter({ text: `Queue: ${game}` })
    .setTimestamp();
}

/**
 * Builds the schedule/voting embed, showing each player's local time
 * derived from their stored IANA timezone.
 */
function buildScheduleEmbed(game, scheduleData) {
  const timezones = storage.getTimezones();
  const queueData = storage.getQueue(game);
  const players = queueData.players || [];
  const { unixTimestamp, votes = {}, hostId } = scheduleData;

  const playerList = players.map(p => {
    const tz = timezones[p.userId];
    if (!tz) return `<@${p.userId}> — *no timezone set*`;
    const localTime = new Date(unixTimestamp * 1000).toLocaleString('en-US', {
      timeZone: tz,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    return `<@${p.userId}> — \`${localTime}\` (${tz})`;
  });

  const yesVotes = Object.values(votes).filter(v => v === '✅').length;
  const noVotes = Object.values(votes).filter(v => v === '❌').length;

  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`📅 Session Scheduled: ${game}`)
    .setDescription(
      `**Proposed Time:** <t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)\n\n` +
        `**Players' Local Times:**\n${
          playerList.length ? playerList.join('\n') : '*No players in queue*'
        }\n\n` +
        `**Votes:** ✅ ${yesVotes} | ❌ ${noVotes}\n\n` +
        `React with ✅ to confirm attendance or ❌ to decline.`
    )
    .addFields(
      { name: 'Host', value: `<@${hostId}>`, inline: true },
      { name: 'Game', value: game, inline: true },
      { name: 'Players', value: `${players.length}`, inline: true }
    )
    .setFooter({ text: 'Vote by reacting below!' })
    .setTimestamp();
}

module.exports = { buildQueueEmbed, buildScheduleEmbed };
