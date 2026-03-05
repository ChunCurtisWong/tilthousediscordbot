const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'trinkets.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function read() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    logger.error('Failed to read trinkets.json', { error: err.message });
    return {};
  }
}

function write(data) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.error('Failed to write trinkets.json', { error: err.message });
  }
}

// ─── Player record helpers ────────────────────────────────────────────────────

function getPlayer(userId) {
  return read()[userId] ?? { username: null, balance: 0, streak: 0, lastDaily: null };
}

function savePlayer(userId, playerData) {
  const data = read();
  data[userId] = playerData;
  write(data);
}

/**
 * Adds `amount` Trinkets to a player's balance.
 * Pass `username` to keep the stored display name up to date.
 * Returns the new balance.
 */
function addTrinkets(userId, amount, username = null) {
  const data = read();
  const player = data[userId] ?? { username: null, balance: 0, streak: 0, lastDaily: null };
  player.balance = (player.balance ?? 0) + amount;
  if (username) player.username = username;
  data[userId] = player;
  write(data);
  return player.balance;
}

// ─── Daily reward ─────────────────────────────────────────────────────────────

const STREAK_REWARDS = [0, 100, 150, 200, 250, 300]; // index = streak day (capped at 5)

function streakReward(streak) {
  return STREAK_REWARDS[Math.min(streak, 5)];
}

/**
 * Attempts to claim the daily reward for a user.
 * Returns { ok, reason, reward, newStreak, newBalance } where
 * `ok` is false if the user already claimed today.
 */
function claimDaily(userId, username) {
  const data = read();
  const player = data[userId] ?? { username: null, balance: 0, streak: 0, lastDaily: null };
  const now = Date.now();
  const msPerDay = 86_400_000;

  if (player.lastDaily !== null) {
    const elapsed = now - player.lastDaily;

    // Already claimed within the last 24 hours
    if (elapsed < msPerDay) {
      const msLeft = msPerDay - elapsed;
      const hLeft = Math.floor(msLeft / 3_600_000);
      const mLeft = Math.ceil((msLeft % 3_600_000) / 60_000);
      return { ok: false, hoursLeft: hLeft, minutesLeft: mLeft };
    }

    // Missed a day (>48 h since last claim) — reset streak
    if (elapsed >= msPerDay * 2) {
      player.streak = 0;
    }
  }

  player.streak = (player.streak ?? 0) + 1;
  const reward = streakReward(player.streak);
  player.balance = (player.balance ?? 0) + reward;
  player.lastDaily = now;
  if (username) player.username = username;

  data[userId] = player;
  write(data);

  return {
    ok: true,
    reward,
    newStreak: player.streak,
    newBalance: player.balance,
    nextReward: streakReward(player.streak + 1),
  };
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

function getLeaderboard(limit = 3) {
  return Object.entries(read())
    .map(([userId, p]) => ({ userId, username: p.username ?? 'Unknown User', balance: p.balance ?? 0 }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

// ─── Queue payout ─────────────────────────────────────────────────────────────

/**
 * Awards Trinkets for a naturally-closed queue (max reached or time expired).
 * Main queue players: 20 each. Fill list players: 5 each.
 * Returns arrays of { userId, username, amount } for notification messages.
 */
function payoutQueue(queueData) {
  const playerPayouts = [];
  const fillPayouts   = [];

  for (const p of queueData.players ?? []) {
    addTrinkets(p.userId, 20, p.username);
    playerPayouts.push({ userId: p.userId, username: p.username, amount: 20 });
  }
  for (const p of queueData.fill ?? []) {
    addTrinkets(p.userId, 5, p.username);
    fillPayouts.push({ userId: p.userId, username: p.username, amount: 5 });
  }

  logger.info('Trinket payout complete', {
    players: playerPayouts.length,
    fill: fillPayouts.length,
  });

  return { playerPayouts, fillPayouts };
}

module.exports = {
  getPlayer,
  savePlayer,
  addTrinkets,
  claimDaily,
  getLeaderboard,
  payoutQueue,
  streakReward,
};
