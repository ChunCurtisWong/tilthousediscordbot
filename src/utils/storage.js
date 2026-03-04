const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readJSON(filename) {
  const filePath = path.join(dataDir, filename);
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.error(`Failed to read ${filename}`, { error: err.message, stack: err.stack });
    return {};
  }
}

function writeJSON(filename, data) {
  const filePath = path.join(dataDir, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    logger.debug(`Persisted ${filename}`);
  } catch (err) {
    logger.error(`Failed to write ${filename}`, { error: err.message, stack: err.stack });
  }
}

// ─── YouTube ───────────────────────────────────────────────────────────────

function getLastVideoId() {
  return readJSON('youtube.json').lastVideoId || null;
}

function setLastVideoId(videoId) {
  writeJSON('youtube.json', { lastVideoId: videoId });
}

// ─── Timezones ─────────────────────────────────────────────────────────────

function getTimezones() {
  return readJSON('timezones.json');
}

function setUserTimezone(userId, timezone) {
  const data = getTimezones();
  data[userId] = timezone;
  writeJSON('timezones.json', data);
}

function getUserTimezone(userId) {
  return getTimezones()[userId] || null;
}

// ─── Queues ────────────────────────────────────────────────────────────────

function getQueues() {
  return readJSON('queues.json');
}

function getQueue(game) {
  return getQueues()[game] || {
    players: [],
    min: null,
    max: null,
    scheduledTime: null,
    reminderSent: false,
    messageId: null,
    channelId: null,
  };
}

function saveQueue(game, queueData) {
  const queues = getQueues();
  queues[game] = queueData;
  writeJSON('queues.json', queues);
}

function deleteQueue(game) {
  const queues = getQueues();
  delete queues[game];
  writeJSON('queues.json', queues);
}

// ─── Schedules ─────────────────────────────────────────────────────────────

function getSchedules() {
  return readJSON('schedules.json');
}

function getSchedule(game) {
  return getSchedules()[game] || null;
}

function saveSchedule(game, scheduleData) {
  const schedules = getSchedules();
  schedules[game] = scheduleData;
  writeJSON('schedules.json', schedules);
}

function deleteSchedule(game) {
  const schedules = getSchedules();
  delete schedules[game];
  writeJSON('schedules.json', schedules);
}

module.exports = {
  getLastVideoId,
  setLastVideoId,
  getTimezones,
  setUserTimezone,
  getUserTimezone,
  getQueue,
  saveQueue,
  deleteQueue,
  getSchedules,
  getSchedule,
  saveSchedule,
  deleteSchedule,
};
