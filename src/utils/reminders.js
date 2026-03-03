const { EmbedBuilder } = require('discord.js');
const logger = require('./logger');
const storage = require('./storage');

/**
 * Starts a 60-second interval that:
 *  - Sends a reminder ping ~10 minutes before a scheduled session.
 *  - Cleans up schedule entries that are more than 1 hour old.
 */
function startReminderChecker(client) {
  logger.info('Reminder checker: started (interval: 60s)');

  setInterval(async () => {
    const schedules = storage.getSchedules();
    const now = Math.floor(Date.now() / 1000);

    for (const [game, schedule] of Object.entries(schedules)) {
      const timeUntil = schedule.unixTimestamp - now;

      // ── Send reminder if within the 10-minute window ─────────────
      if (!schedule.reminderSent && timeUntil <= 600 && timeUntil > 0) {
        logger.info('Reminder checker: sending reminder', { game, secondsUntil: timeUntil });

        schedule.reminderSent = true;
        storage.saveSchedule(game, schedule);

        const queueData = storage.getQueue(game);
        const pingList =
          queueData.players?.map(p => `<@${p.userId}>`).join(' ') || '';

        const minutesLeft = Math.ceil(timeUntil / 60);
        const reminderEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(`⏰ Reminder: ${game} starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`)
          .setDescription(
            `**Session Time:** <t:${schedule.unixTimestamp}:F>\n` +
              `Starts <t:${schedule.unixTimestamp}:R>.\n\n` +
              `Make sure you're ready to play!`
          )
          .setTimestamp();

        try {
          const channel = await client.channels.fetch(schedule.channelId);
          await channel.send({
            content: `${pingList}\n⏰ **${game}** starts in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}!`,
            embeds: [reminderEmbed],
          });
          logger.info('Reminder checker: reminder sent', { game, unixTimestamp: schedule.unixTimestamp });
        } catch (err) {
          logger.error('Reminder checker: failed to send reminder', {
            error: err.message,
            stack: err.stack,
            game,
          });
        }
      }

      // ── Clean up sessions that ended more than 1 hour ago ────────
      if (schedule.unixTimestamp < now - 3600) {
        logger.info('Reminder checker: cleaning up expired schedule', { game });
        storage.deleteSchedule(game);
      }
    }
  }, 60_000);
}

module.exports = { startReminderChecker };
