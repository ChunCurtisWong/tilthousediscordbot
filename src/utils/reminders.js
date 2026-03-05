const { EmbedBuilder } = require('discord.js');
const logger = require('./logger');
const storage = require('./storage');
const { payoutQueue } = require('./trinkets');

/**
 * Starts a 60-second interval that:
 *  - Sends a reminder ping ~10 minutes before a queue's scheduled session.
 *  - Pays out Trinkets when a queue's scheduled time has passed.
 *  - Cleans up queues whose scheduled time ended more than 1 hour ago.
 */
function startReminderChecker(client) {
  logger.info('Reminder checker: started (interval: 60s)');

  setInterval(async () => {
    const queues = storage.getQueues();
    const now = Math.floor(Date.now() / 1000);

    for (const [game, queueData] of Object.entries(queues)) {
      if (!queueData.scheduledTime) continue;

      const { scheduledTime, reminderSent, payoutSent, channelId } = queueData;
      const timeUntil = scheduledTime - now;

      // ── Send reminder if within the 10-minute window ──────────────
      if (!reminderSent && timeUntil <= 600 && timeUntil > 0) {
        logger.info('Reminder checker: sending reminder', { game, secondsUntil: timeUntil });

        queueData.reminderSent = true;
        storage.saveQueue(game, queueData);

        const pingList = queueData.players?.map(p => `<@${p.userId}>`).join(' ') || '';
        const minutesLeft = Math.ceil(timeUntil / 60);

        const reminderEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(`⏰ Reminder: ${game} starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`)
          .setDescription(
            `**Session Time:** <t:${scheduledTime}:F>\n` +
              `Starts <t:${scheduledTime}:R>.\n\n` +
              `Make sure you're ready to play!`
          )
          .setTimestamp();

        try {
          const channel = await client.channels.fetch(channelId);
          await channel.send({
            content: `${pingList}\n⏰ **${game}** starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`,
            embeds: [reminderEmbed],
          });
          logger.info('Reminder checker: reminder sent', { game, scheduledTime });
        } catch (err) {
          logger.error('Reminder checker: failed to send reminder', {
            error: err.message,
            stack: err.stack,
            game,
          });
        }
      }

      // ── Pay out Trinkets when session time has passed ──────────────
      if (!payoutSent && scheduledTime <= now) {
        logger.info('Reminder checker: queue time expired, paying out trinkets', { game });

        queueData.payoutSent = true;
        storage.saveQueue(game, queueData);

        try {
          const { playerPayouts, fillPayouts } = payoutQueue(queueData);
          const payoutLines = [
            ...playerPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙**`),
            ...fillPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙** (fill)`),
          ];
          if (payoutLines.length > 0) {
            const payoutEmbed = new EmbedBuilder()
              .setColor('#FFD700')
              .setTitle('🪙 Trinket Payout')
              .setDescription(`**${game}** session ended — Trinkets awarded!\n\n${payoutLines.join('\n')}`);
            const channel = await client.channels.fetch(channelId);
            await channel.send({ embeds: [payoutEmbed] });
            logger.info('Reminder checker: trinket payout sent', {
              game,
              players: playerPayouts.length,
              fill: fillPayouts.length,
            });
          }
        } catch (err) {
          logger.error('Reminder checker: failed to send payout', {
            error: err.message,
            stack: err.stack,
            game,
          });
        }
      }

      // ── Clean up queues whose session ended more than 1 hour ago ──
      if (scheduledTime < now - 3600) {
        logger.info('Reminder checker: cleaning up expired queue', { game });
        storage.deleteQueue(game);
      }
    }
  }, 60_000);
}

module.exports = { startReminderChecker };
