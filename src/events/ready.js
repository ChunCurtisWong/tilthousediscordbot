const logger = require('../utils/logger');
// const { startYouTubePoller }  = require('../utils/youtube'); // disabled
const { startReminderChecker } = require('../utils/reminders');
const { startTrinketBackups }  = require('../utils/trinkets');
const { runStartupCheck }      = require('../utils/startupCheck');

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client) {
    logger.info(`Bot online — logged in as ${client.user.tag} (${client.user.id})`);
    logger.info(`Serving ${client.guilds.cache.size} guild(s)`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

    client.user.setPresence({
      activities: [{ name: 'game queues | /th-queue create', type: 3 }],
      status: 'online',
    });

    // startYouTubePoller(client); // disabled — re-enable when needed
    startReminderChecker(client);
    startTrinketBackups();
    runStartupCheck();
  },
};
