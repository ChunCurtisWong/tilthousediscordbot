const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR         = path.join(process.cwd(), 'data');
const FILE             = path.join(DATA_DIR, 'trinkets.json');
const LATEST_BACKUP    = path.join(DATA_DIR, 'trinkets-latest-backup.json');
const PRE_RESTORE_FILE = path.join(DATA_DIR, 'trinkets-pre-restore.json');
const BACKUPS_DIR      = path.join(DATA_DIR, 'backups');

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ─── Async write queue ────────────────────────────────────────────────────────
// All read/write operations are serialised through this queue so concurrent
// async callers never interleave and corrupt the JSON file.

let _queue = Promise.resolve();

function withLock(fn) {
  const p = _queue.then(() => fn());
  _queue = p.catch(() => {}); // don't let failures break the chain
  return p;
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

function read() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    logger.error('Failed to read trinkets.json', { error: err.message });
    return {};
  }
}

/**
 * Writes `data` to trinkets.json.
 * Before overwriting, copies the current file to trinkets-latest-backup.json
 * so it always holds the state just before the most recent transaction.
 */
function write(data) {
  try {
    if (fs.existsSync(FILE)) {
      fs.copyFileSync(FILE, LATEST_BACKUP);
    }
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
  return withLock(() => {
    const data = read();
    data[userId] = playerData;
    write(data);
  });
}

/**
 * Adds `amount` Trinkets to a player's balance (use negative to subtract).
 * Returns a Promise resolving to the new balance.
 */
function addTrinkets(userId, amount, username = null) {
  return withLock(() => {
    const data   = read();
    const player = data[userId] ?? { username: null, balance: 0, streak: 0, lastDaily: null };
    player.balance = (player.balance ?? 0) + amount;
    if (username) player.username = username;
    data[userId] = player;
    write(data);
    return player.balance;
  });
}

// ─── 7pm Eastern Time reset helpers ──────────────────────────────────────────

function getEasternMsEquivalent(utcMs) {
  const d     = new Date(utcMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d).reduce((acc, { type, value }) => { acc[type] = value; return acc; }, {});
  const hour = String(parseInt(parts.hour, 10) % 24).padStart(2, '0');
  const iso  = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}Z`;
  return new Date(iso).getTime();
}

function getLastDailyReset(referenceMs = Date.now()) {
  const etFakeMs  = getEasternMsEquivalent(referenceMs);
  const etDate    = new Date(etFakeMs);
  const todayAt7pm = Date.UTC(etDate.getUTCFullYear(), etDate.getUTCMonth(), etDate.getUTCDate(), 19, 0, 0, 0);
  const lastResetFake = etFakeMs >= todayAt7pm ? todayAt7pm : todayAt7pm - 86_400_000;
  const etOffset  = referenceMs - etFakeMs;
  return lastResetFake + etOffset;
}

function getNextDailyReset() {
  return getLastDailyReset() + 86_400_000;
}

// ─── Daily reward ─────────────────────────────────────────────────────────────

const STREAK_REWARDS = [0, 100, 150, 200, 250, 300];

function streakReward(streak) {
  return STREAK_REWARDS[Math.min(streak, 5)];
}

function claimDaily(userId, username) {
  return withLock(() => {
    const data   = read();
    const player = data[userId] ?? { username: null, balance: 0, streak: 0, lastDaily: null };
    const now    = Date.now();

    const currentWindowStart = getLastDailyReset(now);
    const prevWindowStart    = currentWindowStart - 86_400_000;

    if (player.lastDaily !== null && player.lastDaily >= currentWindowStart) {
      return { ok: false, nextResetTs: currentWindowStart + 86_400_000 };
    }

    if (player.lastDaily === null || player.lastDaily < prevWindowStart) {
      player.streak = 0;
    }

    player.streak    = (player.streak ?? 0) + 1;
    const reward     = streakReward(player.streak);
    player.balance   = (player.balance ?? 0) + reward;
    player.lastDaily = now;
    if (username) player.username = username;

    data[userId] = player;
    write(data);

    return {
      ok: true,
      reward,
      newStreak:  player.streak,
      newBalance: player.balance,
      nextReward: streakReward(player.streak + 1),
    };
  });
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

function checkCooldown(userId, command) {
  const cooldowns = read()._cooldowns ?? {};
  const lastUsed  = cooldowns[command]?.[userId] ?? 0;
  const remaining = lastUsed + COOLDOWN_MS - Date.now();
  return remaining > 0 ? remaining : null;
}

function setCooldown(userId, command) {
  return withLock(() => {
    const data = read();
    if (!data._cooldowns) data._cooldowns = {};
    if (!data._cooldowns[command]) data._cooldowns[command] = {};
    data._cooldowns[command][userId] = Date.now();
    write(data);
  });
}

// ─── Pending bets ─────────────────────────────────────────────────────────────

function getPendingBet(betId) {
  return read()._pendingBets?.[betId] ?? null;
}

function savePendingBet(betId, betData) {
  return withLock(() => {
    const data = read();
    if (!data._pendingBets) data._pendingBets = {};
    data._pendingBets[betId] = betData;
    write(data);
  });
}

function deletePendingBet(betId) {
  return withLock(() => {
    const data = read();
    if (!data._pendingBets?.[betId]) return;
    delete data._pendingBets[betId];
    write(data);
  });
}

// ─── Queue payout ─────────────────────────────────────────────────────────────

function payoutQueue(queueData) {
  return withLock(() => {
    const players = queueData.players ?? [];
    const fill    = queueData.fill    ?? [];
    const min     = queueData.min;

    if (players.length < 2) {
      return { ok: false, reason: 'insufficient_players', count: players.length };
    }
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
  });
}

// ─── Backup helpers ───────────────────────────────────────────────────────────

function hourlyTimestamp() {
  const d  = new Date();
  const y  = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(d.getUTCDate()).padStart(2, '0');
  const h  = String(d.getUTCHours()).padStart(2, '0');
  return `${y}-${mo}-${dy}-${h}`;
}

function cleanupOldBackups(keep) {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => /^trinkets-\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // lexicographic = chronological for YYYY-MM-DD-HH
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, file)); } catch {}
  }
}

/**
 * Returns a list of available backups for the /th-restore dropdown.
 * Each entry: { key, label, description }
 */
function getBackupList() {
  const list = [];

  if (fs.existsSync(LATEST_BACKUP)) {
    const stat = fs.statSync(LATEST_BACKUP);
    const d    = new Date(stat.mtimeMs);
    list.push({
      key:         'latest',
      label:       'Latest backup (before last transaction)',
      description: `Saved ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    });
  }

  if (fs.existsSync(BACKUPS_DIR)) {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => /^trinkets-\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse()
      .slice(0, 24);
    for (const file of files) {
      const ts    = file.replace('trinkets-', '').replace('.json', '');
      const parts = ts.split('-');
      const label = `${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:00 UTC`;
      list.push({ key: ts, label: `Hourly: ${label}`, description: `Snapshot at ${label}` });
    }
  }

  return list;
}

/**
 * Restores trinkets.json from the named backup.
 * Saves the current state to trinkets-pre-restore.json first.
 */
function restoreBackup(key) {
  return withLock(() => {
    const sourceFile = key === 'latest'
      ? LATEST_BACKUP
      : path.join(BACKUPS_DIR, `trinkets-${key}.json`);

    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Backup not found: ${path.basename(sourceFile)}`);
    }

    if (fs.existsSync(FILE)) {
      fs.copyFileSync(FILE, PRE_RESTORE_FILE);
    }
    // Copy directly — don't call write() so we don't overwrite the latest backup
    fs.copyFileSync(sourceFile, FILE);
    logger.info('Trinkets restored from backup', { key });
  });
}

// ─── Hourly backup scheduler ──────────────────────────────────────────────────

function startTrinketBackups() {
  logger.info('Trinkets: backup system started (hourly interval)');
  setInterval(() => {
    withLock(() => {
      if (!fs.existsSync(FILE)) return;
      const ts   = hourlyTimestamp();
      const dest = path.join(BACKUPS_DIR, `trinkets-${ts}.json`);
      fs.copyFileSync(FILE, dest);
      cleanupOldBackups(24);
      logger.info('Trinkets: hourly backup saved', { file: `trinkets-${ts}.json` });
    });
  }, 3_600_000);
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
  getBackupList,
  restoreBackup,
  startTrinketBackups,
};
