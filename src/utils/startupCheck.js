const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.join(process.cwd(), 'data');

function checkFile(label, filepath) {
  try {
    if (!fs.existsSync(filepath)) {
      logger.warn(`Startup check: ${label} — file not found`, { filepath });
      return false;
    }
    JSON.parse(fs.readFileSync(filepath, 'utf8'));
    return true;
  } catch (err) {
    logger.warn(`Startup check: ${label} — invalid JSON`, { filepath, error: err.message });
    return false;
  }
}

function runStartupCheck() {
  logger.info('Running startup system checks…');
  let warnings = 0;

  // Data files
  const dataFiles = [
    ['trinkets.json', path.join(DATA_DIR, 'trinkets.json')],
    ['queues.json', path.join(DATA_DIR, 'queues.json')],
    ['trinkets-latest-backup.json', path.join(DATA_DIR, 'trinkets-latest-backup.json')],
  ];
  for (const [label, filepath] of dataFiles) {
    if (!checkFile(label, filepath)) warnings++;
  }

  // Backups directory
  const backupsDir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(backupsDir) || !fs.statSync(backupsDir).isDirectory()) {
    logger.warn('Startup check: data/backups/ — directory missing');
    warnings++;
  }

  // YouTube environment variable checks disabled — YouTube notifier is currently disabled
  // if (!process.env.YOUTUBE_API_KEY) { ... }
  // if (!process.env.YOUTUBE_CHANNEL_ID) { ... }
  // if (!process.env.YOUTUBE_DISCORD_CHANNEL_ID) { ... }

  if (warnings === 0) {
    logger.info('Startup checks passed — all systems nominal');
  } else {
    logger.warn(`Startup checks complete — ${warnings} warning(s) detected (bot will continue)`);
  }
}

module.exports = { runStartupCheck };
