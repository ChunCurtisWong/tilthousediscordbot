const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const storage = require('../utils/storage');

const DATA_DIR = path.join(process.cwd(), 'data');

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkDataFile(filename) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(filepath)) return { ok: false, msg: 'File not found' };
    JSON.parse(fs.readFileSync(filepath, 'utf8'));
    return { ok: true };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

function checkBackupsDir() {
  const dirPath = path.join(DATA_DIR, 'backups');
  try {
    return { ok: fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory() };
  } catch {
    return { ok: false };
  }
}

function getLastError() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(process.cwd(), 'logs', `debug-${today}.log`);
    if (!fs.existsSync(logFile)) return null;

    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('[ERROR]'));
    if (lines.length === 0) return null;

    const last = lines[lines.length - 1];
    const match = last.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[ERROR\s*\] (.+?)(?:\s*\|.*)?$/);
    return match
      ? { timestamp: match[1], message: match[2].trim() }
      : { timestamp: 'unknown', message: last.slice(0, 200) };
  } catch {
    return null;
  }
}

async function checkYouTubeAPI() {
  const { YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID } = process.env;
  if (!YOUTUBE_API_KEY) return { ok: false, msg: 'YOUTUBE_API_KEY not set' };

  // Use configured channel ID, or fall back to a known public channel to validate the key
  const testChannelId = YOUTUBE_CHANNEL_ID || 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { key: YOUTUBE_API_KEY, part: 'id', id: testChannelId, maxResults: 1 },
      timeout: 5000,
    });
    return { ok: resp.status === 200 };
  } catch (err) {
    const status = err.response?.status;
    if (status === 400 || status === 403) {
      return { ok: false, msg: `Key invalid or quota exceeded (HTTP ${status})` };
    }
    return { ok: false, msg: err.message };
  }
}

// ── Command ───────────────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-health')
    .setDescription('(Admin) Run a full system health check')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply();

    const checks = [];

    // 1. Bot latency
    const ping = interaction.client.ws.ping;
    const pingIcon = ping < 0 ? '⚠️' : ping < 200 ? '✅' : ping < 500 ? '⚠️' : '❌';
    checks.push(`${pingIcon} **Bot Latency:** ${ping < 0 ? 'measuring…' : `${ping}ms`}`);

    // 2. Discord API connection (ws status 0 = READY)
    const wsStatus = interaction.client.ws.status;
    checks.push(
      wsStatus === 0
        ? '✅ **Discord API:** Connected'
        : `❌ **Discord API:** Not ready (status ${wsStatus})`
    );

    // 3. Commands loaded vs expected files
    const commandFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.js'));
    const loaded = interaction.client.commands.size;
    const expected = commandFiles.length;
    const cmdIcon = loaded === expected ? '✅' : loaded > 0 ? '⚠️' : '❌';
    checks.push(`${cmdIcon} **Commands Loaded:** ${loaded}/${expected}`);

    // 4. YouTube API
    const yt = await checkYouTubeAPI();
    checks.push(yt.ok ? '✅ **YouTube API:** Connected' : `❌ **YouTube API:** ${yt.msg}`);

    // 5. Data files
    for (const file of ['trinkets.json', 'queues.json']) {
      const res = checkDataFile(file);
      checks.push(res.ok ? `✅ **${file}:** OK` : `❌ **${file}:** ${res.msg}`);
    }

    const backups = checkBackupsDir();
    checks.push(backups.ok ? '✅ **data/backups/:** Exists' : '❌ **data/backups/:** Missing');

    const latestBackup = checkDataFile('trinkets-latest-backup.json');
    checks.push(
      latestBackup.ok
        ? '✅ **trinkets-latest-backup.json:** OK'
        : `⚠️ **trinkets-latest-backup.json:** ${latestBackup.msg}`
    );

    // 6. Active queues
    const activeCount = Object.keys(storage.getQueues()).length;
    checks.push(`✅ **Active Queues:** ${activeCount}`);

    // 7. Bot uptime
    const uptimeSec = Math.floor(process.uptime());
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    checks.push(`✅ **Bot Uptime:** ${uptimeStr}`);

    // 8. Last error from today's log
    const lastErr = getLastError();
    checks.push(
      lastErr
        ? `⚠️ **Last Error:** \`${lastErr.message.slice(0, 120)}\` *(${lastErr.timestamp})*`
        : "✅ **Last Error:** None in today's log"
    );

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🩺 System Health Check')
      .setDescription(checks.join('\n'))
      .setTimestamp()
      .setFooter({ text: 'Health check' });

    return interaction.editReply({ embeds: [embed] });
  },
};
