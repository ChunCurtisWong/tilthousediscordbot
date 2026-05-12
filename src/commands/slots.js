const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

const SLOTS_COOLDOWN_MS  = 5_000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_BET = 10;
const MAX_BET = 500;

const SYMBOLS = [
  { emoji: '🍒', name: 'Cherry',  weight: 40, payout:  2 },
  { emoji: '🍋', name: 'Lemon',   weight: 25, payout:  4 },
  { emoji: '🍊', name: 'Orange',  weight: 15, payout:  6 },
  { emoji: '🍇', name: 'Grape',   weight: 10, payout:  8 },
  { emoji: '⭐', name: 'Star',    weight:  6, payout: 15 },
  { emoji: '💎', name: 'Diamond', weight:  3, payout: 35 },
  { emoji: '7️⃣', name: 'Seven',   weight:  1, payout: 50 },
];

const TOTAL_WEIGHT = SYMBOLS.reduce((s, sym) => s + sym.weight, 0);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// userId → { bet, roundsPlayed, spent, earned, net, timeout, message }
const activeSessions = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function spinReel() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const sym of SYMBOLS) {
    r -= sym.weight;
    if (r <= 0) return sym;
  }
  return SYMBOLS[SYMBOLS.length - 1];
}

function analyzeResult([r1, r2, r3]) {
  if (r1.emoji === r2.emoji && r2.emoji === r3.emoji) return { type: 'three', symbol: r1 };
  if (r1.emoji === r2.emoji) return { type: 'two', symbol: r1 };
  if (r2.emoji === r3.emoji) return { type: 'two', symbol: r2 };
  if (r1.emoji === r3.emoji) return { type: 'two', symbol: r1 };
  return { type: 'none' };
}

function reelStr(reels, revealed) {
  return reels.map((r, i) => (i < revealed ? r.emoji : '🎲')).join(' | ');
}

function spinningEmbed(reels, revealed, bet) {
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎰 Spinning...')
    .setDescription(`[ ${reelStr(reels, revealed)} ]\n\nBet: **${bet} 🪙**`);
}

function buildResultEmbed(reels, result, bet) {
  let color, title, outcomeLines;
  if (result.type === 'three') {
    const payout = result.symbol.payout * bet;
    color = '#FFD700';
    title = result.symbol.payout >= 50 ? '🎰 JACKPOT!'
          : result.symbol.payout >= 10 ? '🎉 Big Win!'
          : '🎉 Winner!';
    outcomeLines = `Three ${result.symbol.name}s!\nBet: **${bet} 🪙**\nWon: **+${payout} 🪙**`;
  } else if (result.type === 'two') {
    const returned = bet - Math.round(bet * 0.1);
    color = '#5865F2';
    title = '🔵 Almost!';
    outcomeLines = `Two ${result.symbol.name}s!\nBet: **${bet} 🪙**\nReturned: **${returned} 🪙**`;
  } else {
    color = '#FF4444';
    title = '💀 No Match!';
    outcomeLines = `No match!\nBet: **${bet} 🪙**\nLost: **-${bet} 🪙**`;
  }
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`[ ${reelStr(reels, 3)} ]\n\n${outcomeLines}`);
}

function gameButtons(userId, playAgainDisabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sl:again:${userId}`)
      .setLabel('Play Again')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(playAgainDisabled),
    new ButtonBuilder()
      .setCustomId(`sl:changebet:${userId}`)
      .setLabel('Change Bet')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sl:stop:${userId}`)
      .setLabel('Stop Playing')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildSummaryEmbed(session) {
  const { roundsPlayed, spent, earned, net } = session;
  const color  = net > 0 ? '#00CC66' : net < 0 ? '#FF4444' : '#808080';
  const netStr = net > 0 ? `+${net}` : `${net}`;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle('🎰 Session Summary')
    .setDescription(
      `Rounds played: **${roundsPlayed}**\n` +
      `Trinkets spent: **${spent} 🪙**\n` +
      `Trinkets earned: **${earned} 🪙**\n` +
      `Net: **${netStr} 🪙**`
    );
}

function startSessionTimeout(session, userId) {
  clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    if (!activeSessions.has(userId)) return;
    activeSessions.delete(userId);
    try { await session.message.edit({ embeds: [buildSummaryEmbed(session)], components: [] }); }
    catch { /* ignore — message may be deleted */ }
  }, SESSION_TIMEOUT_MS);
}

// ─── Shared spin logic ────────────────────────────────────────────────────────

async function runSpin({ userId, username, bet, message }) {
  const reels  = [spinReel(), spinReel(), spinReel()];
  const result = analyzeResult(reels);

  let netChange;
  if (result.type === 'three')    netChange = result.symbol.payout * bet;
  else if (result.type === 'two') netChange = -Math.round(bet * 0.1);
  else                            netChange = -bet;

  await message.edit({ embeds: [spinningEmbed(reels, 0, bet)], components: [] });

  const newBalance = await addTrinkets(userId, netChange, username);
  await setCooldown(userId, 'slots');
  logger.info('Slots result', { userId, bet, type: result.type, netChange, newBalance });

  await delay(1500);
  await message.edit({ embeds: [spinningEmbed(reels, 1, bet)], components: [] });

  await delay(1000);
  await message.edit({ embeds: [spinningEmbed(reels, 2, bet)], components: [] });

  await delay(1000);
  await message.edit({ embeds: [buildResultEmbed(reels, result, bet)], components: [gameButtons(userId)] });

  return netChange;
}

// ─── Command ──────────────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-slots')
    .setDescription('Spin the slot machine and bet Trinkets!')
    .addIntegerOption(opt =>
      opt
        .setName('amount')
        .setDescription(`Trinkets to bet (${MIN_BET}–${MAX_BET})`)
        .setRequired(true)
        .setMinValue(MIN_BET)
        .setMaxValue(MAX_BET)
    ),

  async execute(interaction) {
    const userId   = interaction.user.id;
    const username = interaction.user.username;
    const bet      = interaction.options.getInteger('amount');

    // Cooldown
    const remaining = checkCooldown(userId, 'slots', SLOTS_COOLDOWN_MS);
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      await interaction.reply({ content: `⏳ Wait **${secs}s** before spinning again.`, flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // Balance check
    const balance = getPlayer(userId).balance ?? 0;
    if (balance < bet) {
      await interaction.reply({
        content: `❌ You don't have enough Trinkets to place that bet.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // End any existing session cleanly
    const prev = activeSessions.get(userId);
    if (prev) {
      clearTimeout(prev.timeout);
      activeSessions.delete(userId);
      try { await prev.message.edit({ embeds: [buildSummaryEmbed(prev)], components: [] }); } catch { /* ignore */ }
    }

    await interaction.reply({ embeds: [spinningEmbed([], 0, bet)], components: [] });
    const message = await interaction.fetchReply();

    const session = { bet, roundsPlayed: 0, spent: 0, earned: 0, net: 0, timeout: null, message };
    activeSessions.set(userId, session);

    const netChange = await runSpin({ userId, username, bet, message });
    session.roundsPlayed++;
    session.spent += bet;
    session.earned += Math.max(0, bet + netChange);
    session.net    += netChange;

    startSessionTimeout(session, userId);
  },

  // ─── Button: Play Again ────────────────────────────────────────────────────

  async handlePlayAgain(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    const { bet, message } = session;
    const username = interaction.user.username;

    // Cooldown — leave buttons enabled so they can retry
    const remaining = checkCooldown(userId, 'slots', SLOTS_COOLDOWN_MS);
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      await interaction.reply({ content: `⏳ Wait **${secs}s** before spinning again.`, flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // Balance — disable Play Again, keep Stop Playing
    const balance = getPlayer(userId).balance ?? 0;
    if (balance < bet) {
      await interaction.update({ embeds: message.embeds, components: [gameButtons(userId, true)] });
      const msg = await interaction.followUp({
        content: `❌ You don't have enough Trinkets to place that bet.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => msg.delete().catch(() => {}), 15_000);
      return;
    }

    await interaction.deferUpdate();
    startSessionTimeout(session, userId);

    const netChange = await runSpin({ userId, username, bet, message });
    session.roundsPlayed++;
    session.spent += bet;
    session.earned += Math.max(0, bet + netChange);
    session.net    += netChange;
  },

  // ─── Button: Stop Playing ──────────────────────────────────────────────────

  async handleStop(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    clearTimeout(session.timeout);
    activeSessions.delete(userId);

    await interaction.update({ embeds: [buildSummaryEmbed(session)], components: [] });
  },

  // ─── Button: Change Bet ────────────────────────────────────────────────────

  async handleChangeBet(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    const modal = new ModalBuilder()
      .setCustomId('sl:bet_modal')
      .setTitle('Change Bet');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('bet_amount')
          .setLabel(`New bet amount (${MIN_BET}–${MAX_BET} Trinkets)`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`Current bet: ${session.bet}`)
          .setRequired(true)
      )
    );

    await interaction.showModal(modal);
  },

  // ─── Modal: Bet amount submit ──────────────────────────────────────────────

  async handleBetModal(interaction) {
    const userId  = interaction.user.id;
    const session = activeSessions.get(userId);

    if (!session) {
      await interaction.reply({ content: '❌ No active slots session found.', flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    const input  = interaction.fields.getTextInputValue('bet_amount').trim();
    const newBet = parseInt(input, 10);

    if (isNaN(newBet) || newBet < MIN_BET || newBet > MAX_BET) {
      await interaction.reply({
        content: `❌ Invalid bet. Must be between **${MIN_BET}** and **${MAX_BET} 🪙**.`,
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    const balance = getPlayer(userId).balance ?? 0;
    if (balance < newBet) {
      await interaction.reply({
        content: `❌ You don't have enough Trinkets for that bet.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    session.bet = newBet;

    await interaction.reply({ content: `✅ Bet updated to **${newBet} 🪙**!`, flags: 64 });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
  },
};
