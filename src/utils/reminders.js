const { EmbedBuilder } = require('discord.js');
const logger  = require('./logger');
const storage = require('./storage');
const { payoutQueue, getNextDailyReset } = require('./trinkets');

// Timed queues close 30 minutes after their scheduled session start
const QUEUE_CLOSE_OFFSET = 1800; // seconds

// No-time queues auto-close after 3 hours of inactivity
const INACTIVITY_TIMEOUT = 10_800; // seconds

// ─── Shared close notification ────────────────────────────────────────────────

async function sendCloseNotification(client, channelId, game, payoutResult) {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    logger.error('sendCloseNotification: could not fetch channel', { game, channelId, error: err.message });
    return;
  }

  if (!payoutResult.ok) {
    let description;
    if (payoutResult.reason === 'insufficient_players') {
      description = `The **${game}** queue has closed — not enough players joined.`;
    } else if (payoutResult.reason === 'min_not_met') {
      description =
        `The **${game}** queue has closed — the minimum of **${payoutResult.required}** ` +
        `player${payoutResult.required !== 1 ? 's' : ''} was not reached ` +
        `(${payoutResult.count} joined).`;
    } else {
      description = `The **${game}** queue has closed.`;
    }
    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#888888')
            .setTitle(`⏹️ Queue Closed: ${game}`)
            .setDescription(description)
            .setTimestamp(),
        ],
      });
    } catch (err) {
      logger.error('sendCloseNotification: failed to send no-payout message', { game, error: err.message });
    }
    return;
  }

  const { playerPayouts, fillPayouts, ineligible } = payoutResult;
  const payoutLines = [
    ...playerPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙**`),
    ...fillPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙** (fill)`),
  ];

  if (payoutLines.length > 0) {
    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🪙 Trinket Payout')
            .setDescription(`**${game}** queue closed — Trinkets awarded!\n\n${payoutLines.join('\n')}`),
        ],
      });
    } catch (err) {
      logger.error('sendCloseNotification: failed to send payout embed', { game, error: err.message });
    }
  }

  // DM eligible players
  for (const p of [...playerPayouts, ...fillPayouts]) {
    try {
      const user = await client.users.fetch(p.userId);
      await user.send(`You earned **+${p.amount} 🪙** from the **${game}** queue! 🪙`);
    } catch { /* DMs may be disabled */ }
  }

  // DM ineligible players (daily limit already hit)
  const resetTs = Math.floor(getNextDailyReset() / 1000);
  for (const p of ineligible) {
    try {
      const user = await client.users.fetch(p.userId);
      await user.send(
        `You joined the **${game}** queue but you've already earned your queue Trinkets for today. ` +
          `They reset <t:${resetTs}:R> — join a queue after that to earn more! 🪙`
      );
    } catch { /* DMs may be disabled */ }
  }
}

// ─── Single queue-check pass ──────────────────────────────────────────────────

/**
 * Runs one pass over all active queues.
 *
 * isStartup = true:
 *  - Timed queues that already passed their close time are closed immediately
 *    with a "closed while offline" message and NO Trinket payout.
 *  - Reminder pings are NOT sent (avoids late / duplicate reminders).
 *  - Inactivity-expired no-time queues are closed normally (same message).
 *
 * isStartup = false (normal 60s interval):
 *  - Standard behaviour: reminders, payouts, cleanup.
 */
async function runQueueCheck(client, isStartup = false) {
  const queues = storage.getQueues();
  const now    = Math.floor(Date.now() / 1000);

  for (const [game, queueData] of Object.entries(queues)) {
    const { scheduledTime, channelId } = queueData;

    // ── No-time queues: inactivity auto-close ───────────────────────
    if (!scheduledTime) {
      const lastActivity = queueData.lastActivityAt
        ? Math.floor(queueData.lastActivityAt / 1000)
        : null;

      if (lastActivity !== null && now - lastActivity > INACTIVITY_TIMEOUT) {
        logger.info('Queue closed due to inactivity', { game, isStartup });
        storage.deleteQueue(game);

        if (channelId) {
          try {
            const ch = await client.channels.fetch(channelId);
            await ch.send({
              embeds: [
                new EmbedBuilder()
                  .setColor('#888888')
                  .setTitle(`⏹️ Queue Closed: ${game}`)
                  .setDescription(`The **${game}** queue has closed due to inactivity.`)
                  .setTimestamp(),
              ],
            });
          } catch (err) {
            logger.error('Failed to send inactivity close message', { game, error: err.message });
          }
        }
      }
      continue;
    }

    // ── Timed queues ────────────────────────────────────────────────
    const { reminderSent, payoutSent } = queueData;
    const closeTime = scheduledTime + QUEUE_CLOSE_OFFSET;
    const timeUntil = scheduledTime - now;

    // 10-minute reminder (skip on startup to avoid late/duplicate pings)
    if (!isStartup && !reminderSent && timeUntil <= 600 && timeUntil > 0) {
      logger.info('Reminder checker: sending reminder', { game, secondsUntil: timeUntil });

      queueData.reminderSent = true;
      storage.saveQueue(game, queueData);

      const pingList    = queueData.players?.map(p => `<@${p.userId}>`).join(' ') || '';
      const minutesLeft = Math.ceil(timeUntil / 60);

      try {
        const ch = await client.channels.fetch(channelId);
        await ch.send({
          content: `${pingList}\n⏰ **${game}** starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`,
          embeds: [
            new EmbedBuilder()
              .setColor('#FFD700')
              .setTitle(`⏰ Reminder: ${game} starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`)
              .setDescription(
                `**Session Time:** <t:${scheduledTime}:F>\n` +
                  `Starts <t:${scheduledTime}:R>.\n\n` +
                  `The queue stays open for **30 minutes** after start time.`
              )
              .setTimestamp(),
          ],
        });
        logger.info('Reminder checker: reminder sent', { game, scheduledTime });
      } catch (err) {
        logger.error('Reminder checker: failed to send reminder', { game, error: err.message });
      }
    }

    // Natural close: 30 minutes after scheduled start
    if (!payoutSent && closeTime <= now) {
      queueData.payoutSent = true;
      storage.saveQueue(game, queueData);

      if (isStartup) {
        // Closed while the bot was offline — no Trinket payout
        logger.info('Queue expired while bot was offline — closing without payout', { game, closeTime });
        try {
          const ch = await client.channels.fetch(channelId);
          await ch.send({
            embeds: [
              new EmbedBuilder()
                .setColor('#888888')
                .setTitle(`⏹️ Queue Closed: ${game}`)
                .setDescription(
                  `The **${game}** queue was closed while the bot was offline. ` +
                    `No Trinkets were awarded.`
                )
                .setTimestamp(),
            ],
          });
        } catch (err) {
          logger.error('Failed to send offline-close message', { game, error: err.message });
        }
      } else {
        // Normal close with payout
        logger.info('Queue closed naturally (timed)', { game, closeTime });
        try {
          const payoutResult = await payoutQueue(queueData);
          await sendCloseNotification(client, channelId, game, payoutResult);
        } catch (err) {
          logger.error('Error during timed queue close', { game, error: err.message });
        }
      }
    }

    // Cleanup: 1 hour after natural close
    if (closeTime < now - 3600) {
      logger.info('Removing closed queue from storage', { game });
      storage.deleteQueue(game);
    }
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

function startReminderChecker(client) {
  logger.info('Reminder checker: started (interval: 60s)');

  // Immediately process any queues that expired while the bot was offline
  runQueueCheck(client, true).catch(err =>
    logger.error('Startup queue check failed', { error: err.message })
  );

  // Then poll every 60 seconds
  setInterval(() => runQueueCheck(client), 60_000);
}

module.exports = { startReminderChecker, sendCloseNotification };
