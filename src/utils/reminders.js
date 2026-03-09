const { EmbedBuilder } = require('discord.js');
const logger  = require('./logger');
const storage = require('./storage');
const { payoutQueue } = require('./trinkets');
const { buildClosedQueueEmbed, buildClosedQueueComponents } = require('./embeds');

// Case A: timed queues close 30 minutes after scheduled start
const QUEUE_CLOSE_OFFSET = 1800; // seconds

// Fallback inactivity timeout for no-time queues (3 hours)
const INACTIVITY_TIMEOUT = 10_800; // seconds

// Case B / C: 30-minute window after threshold/fulfilled before close
const WINDOW_DURATION = 1800; // seconds

// Case C: host prompt auto-expires after 5 minutes → Extend applied
const HOST_PROMPT_EXPIRY = 300; // seconds

// ─── Mark the original queue embed as closed ──────────────────────────────────

async function markQueueEmbedClosed(client, game, queueData) {
  if (!queueData.messageId || !queueData.channelId) return;
  try {
    const ch  = await client.channels.fetch(queueData.channelId);
    const msg = await ch.messages.fetch(queueData.messageId);
    await msg.edit({
      content: null,
      embeds: [buildClosedQueueEmbed(game)],
      components: [buildClosedQueueComponents()],
    });
  } catch {
    // Message deleted or inaccessible — ignore
  }
}

// ─── Shared close notification ────────────────────────────────────────────────

async function sendCloseNotification(client, channelId, game, payoutResult) {
  if (!channelId) {
    logger.warn('sendCloseNotification: skipping — channelId is null', { game });
    return;
  }
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
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#888888')
          .setTitle(`⏹️ Queue Closed: ${game}`)
          .setDescription(description)
          .setTimestamp(),
      ],
    }).catch(err => logger.error('sendCloseNotification: failed to send no-payout embed', { game, error: err.message }));
    return;
  }

  const { playerPayouts, fillPayouts } = payoutResult;
  const payoutLines = [
    ...playerPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙**`),
    ...fillPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙** (fill)`),
  ];

  if (payoutLines.length > 0) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle('🪙 Trinket Payout')
          .setDescription(`**${game}** queue closed — Trinkets awarded!\n\n${payoutLines.join('\n')}`),
      ],
    }).catch(err => logger.error('sendCloseNotification: failed to send payout embed', { game, error: err.message }));
  }
}

// ─── Close a queue with optional payout ──────────────────────────────────────

async function closeQueue(client, game, queueData, { withPayout = false, reason = 'default' } = {}) {
  logger.info('Closing queue', { game, withPayout, reason });

  await markQueueEmbedClosed(client, game, queueData);
  storage.deleteQueue(game);

  if (!queueData.channelId) return;

  let channel;
  try {
    channel = await client.channels.fetch(queueData.channelId);
  } catch (err) {
    logger.error('closeQueue: could not fetch channel', { game, error: err.message });
    return;
  }

  if (!withPayout) {
    const descriptions = {
      offline:    `The **${game}** queue was closed while the bot was offline. No Trinkets were awarded.`,
      inactivity: `The **${game}** queue has closed due to inactivity.`,
      default:    `The **${game}** queue has closed.`,
    };
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#888888')
          .setTitle(`⏹️ Queue Closed: ${game}`)
          .setDescription(descriptions[reason] ?? descriptions.default)
          .setTimestamp(),
      ],
    }).catch(() => {});
    return;
  }

  // Only fill players who joined during the close window earn Trinkets
  const windowStartSec = queueData.thresholdHitAt ?? queueData.fulfilledAt ?? queueData.scheduledTime;
  const windowStartMs  = windowStartSec ? windowStartSec * 1000 : 0;
  const filteredData   = {
    ...queueData,
    fill: (queueData.fill ?? []).filter(p => p.joinedAt >= windowStartMs),
  };

  const payoutResult = await payoutQueue(filteredData);
  await sendCloseNotification(client, queueData.channelId, game, payoutResult);
}

// ─── Expire an active host prompt (auto-extend on timeout) ────────────────────

async function expireHostPrompt(client, game, queueData) {
  if (queueData.channelId && queueData.hostPromptMessageId) {
    try {
      const ch  = await client.channels.fetch(queueData.channelId);
      const msg = await ch.messages.fetch(queueData.hostPromptMessageId);
      await msg.edit({
        content: '⏰ Host prompt expired — **Extend** applied automatically.',
        components: [],
      });
    } catch { /* Message gone — fine */ }
  }

  // Push lastActivityAt forward by 30 minutes
  queueData.lastActivityAt = (queueData.lastActivityAt ?? Date.now()) + WINDOW_DURATION * 1000;
  queueData.hostPromptMessageId = null;
  storage.saveQueue(game, queueData);
}

// ─── Single queue-check pass ──────────────────────────────────────────────────

async function runQueueCheck(client, isStartup = false) {
  const queues = storage.getQueues();
  const now    = Math.floor(Date.now() / 1000);

  for (const [game, queueData] of Object.entries(queues)) {
    const { scheduledTime, min, max, thresholdHitAt, fulfilledAt, channelId } = queueData;

    // ── CASE A: Scheduled time set ───────────────────────────────────
    if (scheduledTime) {
      const closeTime = scheduledTime + QUEUE_CLOSE_OFFSET;
      const timeUntil = scheduledTime - now;

      // 10-minute reminder (skip on startup)
      if (!isStartup && !queueData.reminderSent && timeUntil <= 600 && timeUntil > 0) {
        queueData.reminderSent = true;
        storage.saveQueue(game, queueData);

        if (channelId) {
          try {
            const ch       = await client.channels.fetch(channelId);
            const pingList = (queueData.players ?? []).map(p => `<@${p.userId}>`).join(' ');
            const minLeft  = Math.ceil(timeUntil / 60);
            await ch.send({
              content: `${pingList}\n⏰ **${game}** starts in ${minLeft} minute${minLeft !== 1 ? 's' : ''}!`,
              embeds: [
                new EmbedBuilder()
                  .setColor('#FFD700')
                  .setTitle(`⏰ Reminder: ${game} starts in ${minLeft} minute${minLeft !== 1 ? 's' : ''}!`)
                  .setDescription(
                    `**Session Time:** <t:${scheduledTime}:F>\nStarts <t:${scheduledTime}:R>.\n\n` +
                    `The queue stays open for **30 minutes** after start time.`
                  )
                  .setTimestamp(),
              ],
            });
            logger.info('Reminder sent', { game, scheduledTime });
          } catch (err) {
            logger.error('Failed to send reminder', { game, error: err.message });
          }
        }
      }

      // Close 30 minutes after scheduled start
      if (!queueData.payoutSent && closeTime <= now) {
        queueData.payoutSent = true;
        storage.saveQueue(game, queueData);
        await closeQueue(client, game, queueData, {
          withPayout: !isStartup,
          reason: isStartup ? 'offline' : 'default',
        });
      }

      // Remove from storage 1 hour after close
      if (closeTime < now - 3600) storage.deleteQueue(game);
      continue;
    }

    // ── CASE B: Has min or max, threshold hit ────────────────────────
    if (thresholdHitAt !== null) {
      const windowEnd = thresholdHitAt + WINDOW_DURATION;

      if (!queueData.payoutSent && windowEnd <= now) {
        queueData.payoutSent = true;
        storage.saveQueue(game, queueData);
        await closeQueue(client, game, queueData, {
          withPayout: !isStartup,
          reason: isStartup ? 'offline' : 'default',
        });
      }

      if (queueData.payoutSent && windowEnd < now - 3600) storage.deleteQueue(game);
      continue;
    }

    // ── CASE C: No time, no threshold — fulfilled countdown ──────────
    if (fulfilledAt !== null) {
      const windowEnd = fulfilledAt + WINDOW_DURATION;

      if (!queueData.payoutSent && windowEnd <= now) {
        queueData.payoutSent = true;
        storage.saveQueue(game, queueData);
        await closeQueue(client, game, queueData, {
          withPayout: !isStartup,
          reason: isStartup ? 'offline' : 'default',
        });
      }

      if (queueData.payoutSent && windowEnd < now - 3600) storage.deleteQueue(game);
      continue;
    }

    // ── CASE C / B fallback: waiting for threshold or fulfilled ──────

    // Expire host prompt after 5 minutes → auto-extend
    if (!isStartup && min === null && max === null && queueData.hostPromptMessageId) {
      const promptSentSec = queueData.lastHostPromptAt
        ? Math.floor(queueData.lastHostPromptAt / 1000)
        : null;
      if (promptSentSec !== null && now - promptSentSec > HOST_PROMPT_EXPIRY) {
        await expireHostPrompt(client, game, queueData);
        const updated = storage.getQueue(game);
        Object.assign(queueData, updated);
      }
    }

    // Inactivity close: 3h with no new joins
    const lastActivity = queueData.lastActivityAt
      ? Math.floor(queueData.lastActivityAt / 1000)
      : null;

    if (lastActivity !== null && now - lastActivity > INACTIVITY_TIMEOUT) {
      logger.info('Queue closed due to inactivity', { game, isStartup });
      await closeQueue(client, game, queueData, { withPayout: false, reason: 'inactivity' });
    }
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

function startReminderChecker(client) {
  logger.info('Reminder checker: started (interval: 60s)');
  runQueueCheck(client, true).catch(err =>
    logger.error('Startup queue check failed', { error: err.message })
  );
  setInterval(() => runQueueCheck(client), 60_000);
}

module.exports = { startReminderChecker, sendCloseNotification, markQueueEmbedClosed };
