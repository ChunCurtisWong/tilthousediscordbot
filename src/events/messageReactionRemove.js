const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { buildScheduleEmbed } = require('../utils/embeds');

module.exports = {
  name: 'messageReactionRemove',
  async execute(reaction, user) {
    if (user.bot) return;

    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (err) {
        logger.error('messageReactionRemove: failed to fetch partial reaction', {
          error: err.message,
          stack: err.stack,
        });
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch (err) {
        logger.error('messageReactionRemove: failed to fetch partial message', {
          error: err.message,
          stack: err.stack,
        });
        return;
      }
    }

    const emoji = reaction.emoji.name;
    if (!['✅', '❌'].includes(emoji)) return;

    const schedules = storage.getSchedules();
    const game = Object.keys(schedules).find(
      g => schedules[g].messageId === reaction.message.id
    );
    if (!game) return;

    const scheduleData = schedules[game];
    if (!scheduleData.votes) return;

    // Only remove the vote if it matches the emoji that was un-reacted
    if (scheduleData.votes[user.id] === emoji) {
      delete scheduleData.votes[user.id];
      storage.saveSchedule(game, scheduleData);
      logger.info('Vote removed', { game, userId: user.id, emoji });

      try {
        const embed = buildScheduleEmbed(game, scheduleData);
        await reaction.message.edit({ embeds: [embed] });
      } catch (err) {
        logger.error('messageReactionRemove: failed to update schedule embed', {
          error: err.message,
          stack: err.stack,
          game,
        });
      }
    }
  },
};
