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
 * Adds `amount` Trinkets to a player's balance (use negative to subtract).
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

// ─── 7pm Eastern Time reset helpers ──────────────────────────────────────────

/**
 * Returns the Eastern-local time components of `utcMs` as if they were UTC.
 * This lets us do date arithmetic in Eastern time using UTC Date methods.
 */
function getEasternMsEquivalent(utcMs) {
  const d = new Date(utcMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d).reduce((acc, { type, value }) => { acc[type] = value; return acc; }, {});
  // Clamp hour 24 → 0 (some environments emit "24" for midnight)
  const hour = String(parseInt(parts.hour, 10) % 24).padStart(2, '0');
  const iso = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}Z`;
  return new Date(iso).getTime();
}

/**
 * Returns the UTC timestamp (ms) of the most recent 7pm Eastern reset
 * relative to `referenceMs` (defaults to now).
 */
function getLastDailyReset(referenceMs = Date.now()) {
  const etFakeMs = getEasternMsEquivalent(referenceMs);
  const etDate   = new Date(etFakeMs);

  // Build "today at 19:00" in fake-UTC Eastern space
  const todayAt7pm = Date.UTC(
    etDate.getUTCFullYear(),
    etDate.getUTCMonth(),
    etDate.getUTCDate(),
    19, 0, 0, 0
  );

  // If Eastern local time hasn't reached 7pm yet, last reset was yesterday at 7pm
  const lastResetFake = etFakeMs >= todayAt7pm ? todayAt7pm : todayAt7pm - 86_400_000;

  // Convert fake-UTC Eastern time back to real UTC
  const etOffset = referenceMs - etFakeMs; // ms Eastern is behind UTC
  return lastResetFake + etOffset;
}

/** Returns the UTC timestamp (ms) of the next 7pm Eastern reset. */
function getNextDailyReset() {
  return getLastDailyReset() + 86_400_000;
}

// ─── Daily reward ─────────────────────────────────────────────────────────────

const STREAK_REWARDS = [0, 100, 150, 200, 250, 300]; // index = streak day (capped at 5)

function streakReward(streak) {
  return STREAK_REWARDS[Math.min(streak, 5)];
}

/**
 * Attempts to claim the daily reward for a user.
 * The claim window resets at 7pm Eastern time every day.
 * Returns { ok: false, nextResetTs } if already claimed this window,
 * or { ok: true, reward, newStreak, newBalance, nextReward } on success.
 */
function claimDaily(userId, username) {
  const data   = read();
  const player = data[userId] ?? { username: null, balance: 0, streak: 0, lastDaily: null };
  const now    = Date.now();

  const currentWindowStart = getLastDailyReset(now);
  const prevWindowStart    = currentWindowStart - 86_400_000;

  // Already claimed in the current window?
  if (player.lastDaily !== null && player.lastDaily >= currentWindowStart) {
    return { ok: false, nextResetTs: currentWindowStart + 86_400_000 };
  }

  // Determine streak continuity
  if (player.lastDaily === null || player.lastDaily < prevWindowStart) {
    // Never claimed, or missed a day — reset streak
    player.streak = 0;
  }
  // Otherwise: claimed in the previous window — consecutive, keep and increment

  player.streak  = (player.streak ?? 0) + 1;
  const reward   = streakReward(player.streak);
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
    .filter(([key]) => !key.startsWith('_'))
    .map(([userId, p]) => ({ userId, username: p.username ?? 'Unknown User', balance: p.balance ?? 0 }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

// ─── Cooldowns ────────────────────────────────────────────────────────────────

const COOLDOWN_MS = 30_000;

/**
 * Returns milliseconds remaining on cooldown, or null if not on cooldown.
 */
function checkCooldown(userId, command) {
  const cooldowns = read()._cooldowns ?? {};
  const lastUsed  = cooldowns[command]?.[userId] ?? 0;
  const remaining = lastUsed + COOLDOWN_MS - Date.now();
  return remaining > 0 ? remaining : null;
}

function setCooldown(userId, command) {
  const data = read();
  if (!data._cooldowns) data._cooldowns = {};
  if (!data._cooldowns[command]) data._cooldowns[command] = {};
  data._cooldowns[command][userId] = Date.now();
  write(data);
}

// ─── Pending bets ─────────────────────────────────────────────────────────────

function getPendingBet(betId) {
  return read()._pendingBets?.[betId] ?? null;
}

function savePendingBet(betId, betData) {
  const data = read();
  if (!data._pendingBets) data._pendingBets = {};
  data._pendingBets[betId] = betData;
  write(data);
}

function deletePendingBet(betId) {
  const data = read();
  if (!data._pendingBets?.[betId]) return;
  delete data._pendingBets[betId];
  write(data);
}

// ─── Queue payout ─────────────────────────────────────────────────────────────

/**
 * Awards Trinkets for a naturally-closed queue.
 *
 * Payout requirements (returns { ok: false, reason, ... } if not met):
 *  - At least 2 players must be in the main queue.
 *  - If a minimum was set, it must be met.
 *
 * For eligible players the daily 7pm ET limit is enforced.
 * Returns { ok: true, playerPayouts, fillPayouts, ineligible } on success.
 * playerPayouts / fillPayouts: [{ userId, username, amount }]
 * ineligible:                  [{ userId, username }]  (daily limit already hit)
 */
function payoutQueue(queueData) {
  const players = queueData.players ?? [];
  const fill    = queueData.fill    ?? [];
  const min     = queueData.min;

  // Require at least 2 players in the main queue
  if (players.length < 2) {
    return { ok: false, reason: 'insufficient_players', count: players.length };
  }

  // If a minimum was set it must be met
  if (min !== null && players.length < min) {
    return { ok: false, reason: 'min_not_met', required: min, count: players.length };
  }

  const resetTs = getLastDailyReset();
  const now     = Date.now();
  const data    = read();

  const playerPayouts = [];
  const fillPayouts   = [];
  const ineligible    = [];

  function processPlayer(p, amount, payoutArr) {
    const player = data[p.userId] ?? { balance: 0, streak: 0, lastDaily: null };
    if (p.username) player.username = p.username;

    const lastPayout = player.lastQueuePayout ?? 0;
    if (lastPayout >= resetTs) {
      ineligible.push({ userId: p.userId, username: p.username });
      return;
    }

    player.balance         = (player.balance ?? 0) + amount;
    player.lastQueuePayout = now;
    data[p.userId]         = player;
    payoutArr.push({ userId: p.userId, username: p.username, amount });
  }

  for (const p of players) processPlayer(p, 20, playerPayouts);
  for (const p of fill)    processPlayer(p,  5, fillPayouts);

  write(data);

  logger.info('Trinket payout complete', {
    eligible:   playerPayouts.length + fillPayouts.length,
    ineligible: ineligible.length,
  });

  return { ok: true, playerPayouts, fillPayouts, ineligible };
}

module.exports = {
  getPlayer,
  savePlayer,
  addTrinkets,
  claimDaily,
  getLeaderboard,
  payoutQueue,
  streakReward,
  getLastDailyReset,
  getNextDailyReset,
  checkCooldown,
  setCooldown,
  getPendingBet,
  savePendingBet,
  deletePendingBet,
};
