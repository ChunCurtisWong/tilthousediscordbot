const { EmbedBuilder } = require('discord.js');
const logger  = require('./logger');
const storage = require('./storage');
const { payoutQueue } = require('./trinkets');
const {
  buildClosedQueueEmbed, buildClosedQueueComponents,
  buildReadyUpRow, buildSessionPromptRow, buildSessionNoOptionsRow,
  buildQueueEmbed, buildQueueComponents, buildReadyStatusEmbed,
} = require('./embeds');

// Case B / C: 30-minute window after threshold/fulfilled before close
const WINDOW_DURATION = 1800; // seconds

// Case C: host prompt auto-expires after 5 minutes → Extend applied
const HOST_PROMPT_EXPIRY = 300; // seconds

// Fallback inactivity timeout for no-time queues (3 hours)
const INACTIVITY_TIMEOUT = 10_800; // seconds

// ─── Update the live queue embed ──────────────────────────────────────────────

async function updateQueueEmbed(client, game, queueData) {
  if (!queueData.messageId || !queueData.channelId) return;
  try {
    const ch  = await client.channels.fetch(queueData.channelId);
    const msg = await ch.messages.fetch(queueData.messageId);
    await msg.edit({
      embeds:     [buildQueueEmbed(game, queueData)],
      components: [buildQueueComponents(game)],
    });
  } catch { /* Message gone or inaccessible */ }
}

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
// Sends a single combined "Queue Closed" embed (with payout lines if applicable).
// Skips silently if fewer than 2 players were in the main queue.

async function sendCloseNotification(client, channelId, game, payoutResult, queueData) {
  // No notification for queues that never had enough players
  if ((queueData?.players?.length ?? 0) < 2) return;

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

  let color = '#888888';
  let description;

  if (!payoutResult?.ok) {
    if (payoutResult?.reason === 'insufficient_players') {
      description = `Not enough players joined — no Trinkets awarded.`;
    } else if (payoutResult?.reason === 'min_not_met') {
      description =
        `Minimum of **${payoutResult.required}** player${payoutResult.required !== 1 ? 's' : ''} not reached ` +
        `(${payoutResult.count} joined) — no Trinkets awarded.`;
    } else {
      description = `The queue has closed.`;
    }
  } else {
    const { playerPayouts, fillPayouts } = payoutResult;
    const lines = [
      ...playerPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙**`),
      ...fillPayouts.map(p => `<@${p.userId}> — **+${p.amount} 🪙** (fill)`),
    ];
    if (lines.length > 0) {
      color = '#FFD700';
      description = `Trinkets awarded!\n\n${lines.join('\n')}`;
    } else {
      description = `Queue closed — no players were eligible for Trinkets today.`;
    }
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(color)
        .setTitle(`⏹️ Queue Closed: ${game}`)
        .setDescription(description)
        .setTimestamp(),
    ],
  }).catch(err => logger.error('sendCloseNotification: failed to send embed', { game, error: err.message }));
}

// ─── Session prompt ────────────────────────────────────────────────────────────

async function sendSessionPrompt(channel, game, queueData) {
  const host = queueData.players?.[0];
  if (!host) return;

  await channel.send({
    content: `<@${host.userId}>`,
    embeds: [
      new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🎮 ${game} — Has the session started?`)
        .setDescription('Has the session started?')
        .setTimestamp(),
    ],
    components: [buildSessionPromptRow(game)],
  });
}

// ─── Close a queue with optional payout ──────────────────────────────────────

async function closeQueue(client, game, queueData, { withPayout = false, reason = 'default' } = {}) {
  logger.info('Closing queue', { game, withPayout, reason });

  await markQueueEmbedClosed(client, game, queueData);

  // Delete the ready-up message if it was still visible
  if (queueData.readyMessageId && queueData.channelId) {
    try {
      const ch  = await client.channels.fetch(queueData.channelId);
      const msg = await ch.messages.fetch(queueData.readyMessageId);
      await msg.delete();
    } catch { /* Already gone — fine */ }
  }

  storage.deleteQueue(game);

  // No notification for queues with fewer than 2 players
  if ((queueData.players?.length ?? 0) < 2) return;

  if (!queueData.channelId) return;

  if (!withPayout) {
    let channel;
    try {
      channel = await client.channels.fetch(queueData.channelId);
    } catch (err) {
      logger.error('closeQueue: could not fetch channel', { game, error: err.message });
      return;
    }
    const descriptions = {
      offline:    `Closed while the bot was offline — no Trinkets awarded.`,
      inactivity: `Closed due to inactivity.`,
      default:    `The queue has closed.`,
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
  await sendCloseNotification(client, queueData.channelId, game, payoutResult, queueData);
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
    // ── Session already started — clean up after 3 hours ──────────────
    if (queueData.sessionStarted) {
      if (queueData.sessionStartedAt && now - queueData.sessionStartedAt > 10800) {
        storage.deleteQueue(game);
      }
      continue;
    }

    const { scheduledTime, min, max, thresholdHitAt, fulfilledAt, channelId } = queueData;

    // ── CASE A: Scheduled time set ───────────────────────────────────
    if (scheduledTime) {
      const timeUntil = scheduledTime - now;

      // ── 10-minute reminder — opens the ready-up window ───────────
      if (!isStartup && !queueData.reminderSent && timeUntil <= 600 && timeUntil > 0) {
        queueData.reminderSent   = true;
        queueData.readyWindowEnd = scheduledTime + 600; // window closes 10 min after start
        queueData.readyPlayers   = [];
        storage.saveQueue(game, queueData);

        if (channelId) {
          try {
            const ch = await client.channels.fetch(channelId);

            // Delete any stale messages from a previous extension cycle before posting
            for (const msgId of queueData.pendingDeleteMessageIds ?? []) {
              try {
                const old = await ch.messages.fetch(msgId);
                await old.delete();
              } catch { /* Already gone — fine */ }
            }
            if ((queueData.pendingDeleteMessageIds ?? []).length > 0) {
              queueData.pendingDeleteMessageIds = [];
              storage.saveQueue(game, queueData);
            }

            const effectiveMinReminder = queueData.min ?? 2;
            if ((queueData.players ?? []).length >= effectiveMinReminder) {
              const pingList = (queueData.players ?? []).map(p => `<@${p.userId}>`).join(' ');
              const minLeft  = Math.ceil(timeUntil / 60);
              const sentMsg  = await ch.send({
                content: `${pingList}\n⏰ **${game}** starts in ${minLeft} minute${minLeft !== 1 ? 's' : ''}! Ready up below.`,
                embeds: [
                  new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle(`⏰ ${game} — Starts in ${minLeft} minute${minLeft !== 1 ? 's' : ''}!`)
                    .setDescription(
                      `**Session Time:** <t:${scheduledTime}:F>\nStarts <t:${scheduledTime}:R>.\n\n` +
                      `Click **Ready Up!** to confirm you'll be there.\n` +
                      `Ready-up window closes <t:${scheduledTime + 600}:R>.`
                    )
                    .setTimestamp(),
                ],
                components: [buildReadyUpRow(game)],
              });
              queueData.readyMessageId = sentMsg.id;
              storage.saveQueue(game, queueData);
              logger.info('Reminder sent with ready-up button', { game, scheduledTime });
            } else {
              logger.info('Ready-up window opened — waiting for min players before posting', {
                game, players: (queueData.players ?? []).length, effectiveMinReminder,
              });
            }
          } catch (err) {
            logger.error('Failed to send reminder', { game, error: err.message });
          }
        }
      }

      // If scheduled time passed without a reminder (e.g. bot was offline), initialise window
      if (!queueData.readyWindowEnd && timeUntil <= 0) {
        queueData.reminderSent   = true;
        queueData.readyWindowEnd = scheduledTime + 600;
        queueData.readyPlayers   = queueData.readyPlayers ?? [];
        storage.saveQueue(game, queueData);
      }

      // ── All players ready — ask host at scheduled time ───────────
      const allReady =
        (queueData.readyPlayers ?? []).length >= (queueData.players ?? []).length &&
        (queueData.players ?? []).length > 0;
      const effectiveMinAllReady = queueData.min ?? 2;
      if (
        !isStartup &&
        !queueData.sessionPromptSent &&
        queueData.readyWindowEnd &&
        allReady &&
        scheduledTime <= now &&
        (queueData.players ?? []).length >= effectiveMinAllReady
      ) {
        queueData.sessionPromptSent = true;
        storage.saveQueue(game, queueData);
        if (channelId) {
          try {
            const ch = await client.channels.fetch(channelId);
            await sendSessionPrompt(ch, game, queueData);
            logger.info('All ready — session prompt sent at scheduled time', { game });
          } catch (err) {
            logger.error('Failed to send session prompt (all ready at scheduled time)', { game, error: err.message });
          }
        }
      }

      // ── Ready-up window expiry ────────────────────────────────────
      const readyWindowEnd = queueData.readyWindowEnd;
      if (
        !isStartup &&
        readyWindowEnd &&
        readyWindowEnd <= now &&
        !queueData.sessionPromptSent
      ) {
        if (!channelId) {
          queueData.sessionPromptSent = true;
          storage.saveQueue(game, queueData);
        } else {
          try {
            const ch = await client.channels.fetch(channelId);

            // Case 1: min was never met — ready-up message was never posted
            if (!queueData.readyMessageId) {
              queueData.sessionPromptSent = true;
              storage.saveQueue(game, queueData);
              const host = queueData.players?.[0];
              if (host) {
                await ch.send({
                  content: `<@${host.userId}>`,
                  embeds: [
                    new EmbedBuilder()
                      .setColor('#FF6B6B')
                      .setTitle(`❌ ${game} — Not Enough Players`)
                      .setDescription('Not enough players to start. What would you like to do?')
                      .setTimestamp(),
                  ],
                  components: [buildSessionNoOptionsRow(game)],
                });
              }
              logger.info('Ready window expired — min never met, host prompted', {
                game, players: (queueData.players ?? []).length,
              });
            } else {
              const readySet = new Set(queueData.readyPlayers ?? []);
              const notReady = (queueData.players ?? []).filter(p => !readySet.has(p.userId));

              // Case 2: all ready — session prompt
              if (notReady.length === 0) {
                queueData.sessionPromptSent = true;
                storage.saveQueue(game, queueData);
                await sendSessionPrompt(ch, game, queueData);
                logger.info('Ready window expired — all ready, session prompt sent', { game });

              // Case 3: not all ready, fill available — promote and reset window
              } else if ((queueData.fill ?? []).length > 0) {
                const readyPlayers  = (queueData.players ?? []).filter(p => readySet.has(p.userId));
                const toPromote     = Math.min(notReady.length, queueData.fill.length);
                const newlyPromoted = queueData.fill.splice(0, toPromote);
                queueData.players   = [...readyPlayers, ...newlyPromoted];

                // Reset ready-up window (sessionPromptSent stays false)
                queueData.readyWindowEnd = now + 600;
                queueData.readyPlayers   = [];
                const oldReadyMessageId  = queueData.readyMessageId;
                queueData.readyMessageId = null;
                storage.saveQueue(game, queueData);

                // Delete old ready-up message
                if (oldReadyMessageId) {
                  try {
                    const oldMsg = await ch.messages.fetch(oldReadyMessageId);
                    await oldMsg.delete();
                  } catch { /* Already gone */ }
                }

                // Refresh queue embed
                await updateQueueEmbed(client, game, storage.getQueue(game));

                // Post new ready-up message
                const pingList = queueData.players.map(p => `<@${p.userId}>`).join(' ');
                const sentMsg  = await ch.send({
                  content:    `${pingList}\n⏰ **${game}** is ready to start! Ready up below.`,
                  embeds:     [buildReadyStatusEmbed(game, queueData)],
                  components: [buildReadyUpRow(game)],
                });
                queueData.readyMessageId = sentMsg.id;
                storage.saveQueue(game, queueData);

                // Notify promoted players
                for (const p of newlyPromoted) {
                  await ch.send({
                    content: `<@${p.userId}> You've been promoted from the fill list to the **${game}** main queue! 🎮`,
                  });
                }

                logger.info('Ready window expired — fill promoted, window reset', {
                  game, promoted: toPromote, notReady: notReady.length,
                });

              // Case 4: not all ready, no fill — ask host
              } else {
                queueData.sessionPromptSent = true;
                storage.saveQueue(game, queueData);
                const host = queueData.players?.[0];
                if (host) {
                  await ch.send({
                    content: `<@${host.userId}>`,
                    embeds: [
                      new EmbedBuilder()
                        .setColor('#FF6B6B')
                        .setTitle(`⚠️ ${game} — Not All Players Are Ready`)
                        .setDescription('Not all players are ready. What would you like to do?')
                        .setTimestamp(),
                    ],
                    components: [buildSessionNoOptionsRow(game)],
                  });
                }
                logger.info('Ready window expired — not all ready, no fill, host prompted', {
                  game, notReady: notReady.length,
                });
              }
            }
          } catch (err) {
            logger.error('Failed to process ready window expiry', { game, error: err.message });
          }
        }
      }

      // ── Fallback: auto-close 2 hours after scheduled time if host never responded ──
      if (
        !isStartup &&
        queueData.sessionPromptSent &&
        scheduledTime + 7200 <= now &&
        !queueData.payoutSent
      ) {
        queueData.payoutSent = true;
        storage.saveQueue(game, queueData);
        logger.info('Queue auto-closed after session prompt timeout', { game });
        await markQueueEmbedClosed(client, game, queueData);
        storage.deleteQueue(game);
      }

      // ── Cleanup: remove record 3 hours after scheduled time ──────
      if (scheduledTime + 10800 < now) storage.deleteQueue(game);
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

module.exports = {
  startReminderChecker,
  sendCloseNotification,
  markQueueEmbedClosed,
  sendSessionPrompt,
};
