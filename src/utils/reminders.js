const { EmbedBuilder } = require('discord.js');
const logger = require('./logger');
const storage = require('./storage');
const { payoutQueue, getNextDailyReset } = require('./trinkets');

// Queue closes 10 minutes after its scheduled time
const QUEUE_CLOSE_OFFSET = 600; // seconds

/**
 * Sends a Trinket payout embed to the channel and DMs ineligible players.
 */
async function sendPayoutNotification(client, channelId, game, playerPayouts, fillPayouts, ineligible) {
  const payoutLines = [
    ...playerPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙**`),
    ...fillPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙** (fill)`),
  ];

  if (payoutLines.length > 0) {
    const payoutEmbed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Trinket Payout')
      .setDescription(`**${game}** queue closed — Trinkets awarded!\n\n${payoutLines.join('\n')}`);
    try {
      const channel = await client.channels.fetch(channelId);
      await channel.send({ embeds: [payoutEmbed] });
    } catch (err) {
      logger.error('Failed to send payout embed', { game, error: err.message });
    }
  }

  // DM players who hit the daily queue Trinket limit
  const nextReset = getNextDailyReset();
  const resetTs   = Math.floor(nextReset / 1000);
  for (const p of ineligible) {
    try {
      const user = await client.users.fetch(p.userId);
      await user.send(
        `You joined the **${game}** queue but you've already earned your queue Trinkets for today. ` +
          `They reset <t:${resetTs}:R> — join a queue after that to earn more! 🪙`
      );
    } catch {
      // DMs may be disabled — silently skip
    }
  }
}

/**
 * Starts a 60-second interval that:
 *  - Sends a reminder ping 10 minutes before a queue's scheduled session.
 *  - Closes the queue and pays out Trinkets 10 minutes AFTER the scheduled time.
 *  - Cleans up closed queues after 1 additional hour.
 */
function startReminderChecker(client) {
  logger.info('Reminder checker: started (interval: 60s)');

  setInterval(async () => {
    const queues = storage.getQueues();
    const now    = Math.floor(Date.now() / 1000);

    for (const [game, queueData] of Object.entries(queues)) {
      if (!queueData.scheduledTime) continue;

      const { scheduledTime, reminderSent, payoutSent, channelId } = queueData;
      const closeTime = scheduledTime + QUEUE_CLOSE_OFFSET; // 10 min after start

      // ── 10-minute reminder (before session start) ──────────────────
      const timeUntil = scheduledTime - now;
      if (!reminderSent && timeUntil <= 600 && timeUntil > 0) {
        logger.info('Reminder checker: sending reminder', { game, secondsUntil: timeUntil });

        queueData.reminderSent = true;
        storage.saveQueue(game, queueData);

        const pingList   = queueData.players?.map(p => `<@${p.userId}>`).join(' ') || '';
        const minutesLeft = Math.ceil(timeUntil / 60);

        const reminderEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(`⏰ Reminder: ${game} starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`)
          .setDescription(
            `**Session Time:** <t:${scheduledTime}:F>\n` +
              `Starts <t:${scheduledTime}:R>.\n\n` +
              `Make sure you're ready to play! The queue stays open for **10 minutes** after start time.`
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
          logger.error('Reminder checker: failed to send reminder', { error: err.message, game });
        }
      }

      // ── Natural close: 10 minutes after scheduled time ────────────
      if (!payoutSent && closeTime <= now) {
        logger.info('Reminder checker: queue closed naturally, paying out trinkets', { game, closeTime });

        queueData.payoutSent = true;
        storage.saveQueue(game, queueData);

        try {
          const { playerPayouts, fillPayouts, ineligible } = payoutQueue(queueData);
          await sendPayoutNotification(client, channelId, game, playerPayouts, fillPayouts, ineligible);
          logger.info('Reminder checker: payout complete', {
            game,
            eligible:   playerPayouts.length + fillPayouts.length,
            ineligible: ineligible.length,
          });
        } catch (err) {
          logger.error('Reminder checker: failed during payout', { error: err.message, game });
        }
      }

      // ── Cleanup: 1 hour after natural close ───────────────────────
      if (closeTime < now - 3600) {
        logger.info('Reminder checker: cleaning up closed queue', { game });
        storage.deleteQueue(game);
      }
    }
  }, 60_000);
}

module.exports = { startReminderChecker };
