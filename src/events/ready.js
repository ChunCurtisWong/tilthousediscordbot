const logger = require('../utils/logger');
const { startYouTubePoller } = require('../utils/youtube');
const { startReminderChecker } = require('../utils/reminders');

module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    logger.info(`Bot online — logged in as ${client.user.tag} (${client.user.id})`);
    logger.info(`Serving ${client.guilds.cache.size} guild(s)`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

    client.user.setPresence({
      activities: [{ name: 'game queues | /queue join', type: 3 }],
      status: 'online',
    });

    startYouTubePoller(client);
    startReminderChecker(client);
  },
};
