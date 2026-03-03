const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { buildScheduleEmbed } = require('../utils/embeds');

module.exports = {
  name: 'messageReactionAdd',
  async execute(reaction, user) {
    if (user.bot) return;

    // Fetch partial reaction/message so we have full data
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (err) {
        logger.error('messageReactionAdd: failed to fetch partial reaction', {
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
        logger.error('messageReactionAdd: failed to fetch partial message', {
          error: err.message,
          stack: err.stack,
        });
        return;
      }
    }

    const emoji = reaction.emoji.name;
    if (!['✅', '❌'].includes(emoji)) return;

    // Find a schedule whose embed message matches
    const schedules = storage.getSchedules();
    const game = Object.keys(schedules).find(
      g => schedules[g].messageId === reaction.message.id
    );
    if (!game) return;

    const scheduleData = schedules[game];
    if (!scheduleData.votes) scheduleData.votes = {};

    scheduleData.votes[user.id] = emoji;
    storage.saveSchedule(game, scheduleData);

    logger.info('Vote recorded', { game, userId: user.id, emoji });

    try {
      const embed = buildScheduleEmbed(game, scheduleData);
      await reaction.message.edit({ embeds: [embed] });
    } catch (err) {
      logger.error('messageReactionAdd: failed to update schedule embed', {
        error: err.message,
        stack: err.stack,
        game,
      });
    }
  },
};
