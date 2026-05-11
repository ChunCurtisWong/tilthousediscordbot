const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

const BJ_COOLDOWN_MS = 5_000;
const MIN_BET  = 10;
const MAX_BET  = 500;
const TIMEOUT_MS = 5 * 60 * 1000;

const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const FACE  = { A: 11, J: 10, Q: 10, K: 10 };

// In-memory game state — cleared on bot restart (intentional)
const activeGames = new Map(); // userId → game

// ─── Card helpers ─────────────────────────────────────────────────────────────

function drawCard() {
  const rank  = RANKS[Math.floor(Math.random() * RANKS.length)];
  const suit  = SUITS[Math.floor(Math.random() * SUITS.length)];
  const value = FACE[rank] ?? parseInt(rank, 10);
  return { rank, suit, value };
}

function handValue(hand) {
  let total = hand.reduce((s, c) => s + c.value, 0);
  let aces  = hand.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function showHand(hand) {
  return hand.map(c => `${c.rank}${c.suit}`).join(' ');
}

// ─── Embed / button builders ──────────────────────────────────────────────────

function buildButtons(userId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj:hit:${userId}`)
      .setLabel('Hit')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`bj:stand:${userId}`)
      .setLabel('Stand')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

function buildGameEmbed(game) {
  const pv = handValue(game.playerHand);
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🃏 Blackjack')
    .setDescription(
      `**Dealer:** ${showHand([game.dealerHand[0]])} ❓\n` +
      `**Your Hand:** ${showHand(game.playerHand)} **(${pv})**\n\n` +
      `Bet: **${game.bet} 🪙**`
    )
    .setFooter({ text: 'Session expires after 5 minutes of inactivity.' });
}

function buildFinalEmbed(game, result) {
  const pv = handValue(game.playerHand);
  const dv = handValue(game.dealerHand);

  let color, title, outcomeLines;
  if (result === 'blackjack') {
    const payout = Math.floor(game.bet * 1.5);
    color = '#FFD700'; title = '🃏 Blackjack!';
    outcomeLines = `Bet: **${game.bet} 🪙**\nWon: **+${payout} 🪙**`;
  } else if (result === 'win') {
    const payout = Math.floor(game.bet * 0.8);
    color = '#00CC66'; title = '🎉 You Win!';
    outcomeLines = `Bet: **${game.bet} 🪙**\nWon: **+${payout} 🪙**`;
  } else if (result === 'bust') {
    color = '#FF4444'; title = '💀 Bust!';
    outcomeLines = `Bet: **${game.bet} 🪙**\nLost: **-${game.bet} 🪙**`;
  } else if (result === 'lose') {
    color = '#FF4444'; title = '💀 Dealer Wins';
    outcomeLines = `Bet: **${game.bet} 🪙**\nLost: **-${game.bet} 🪙**`;
  } else {
    color = '#5865F2'; title = '🤝 Push!';
    outcomeLines = `Bet: **${game.bet} 🪙**\nReturned: **${game.bet} 🪙**`;
  }

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(
      `**Dealer:** ${showHand(game.dealerHand)} **(${dv})**\n` +
      `**Your Hand:** ${showHand(game.playerHand)} **(${pv})**\n\n` +
      outcomeLines
    );
}

// ─── Game logic ───────────────────────────────────────────────────────────────

async function resolveGame(game, result, interaction) {
  clearTimeout(game.timeout);
  activeGames.delete(game.userId);

  let netChange = 0;
  if (result === 'blackjack')               netChange =  Math.floor(game.bet * 1.5);
  else if (result === 'win')                netChange =  Math.floor(game.bet * 0.8);
  else if (result === 'bust' || result === 'lose') netChange = -game.bet;

  if (netChange !== 0) await addTrinkets(game.userId, netChange, game.username);
  await setCooldown(game.userId, 'blackjack');

  logger.info('Blackjack resolved', {
    userId: game.userId, bet: game.bet, result, netChange,
    playerValue: handValue(game.playerHand),
    dealerValue: handValue(game.dealerHand),
  });

  await interaction.editReply({ embeds: [buildFinalEmbed(game, result)], components: [] });
}

async function runDealerAndResolve(game, interaction) {
  while (handValue(game.dealerHand) < 17) game.dealerHand.push(drawCard());

  const pv = handValue(game.playerHand);
  const dv = handValue(game.dealerHand);

  let result;
  if (dv > 21 || pv > dv) result = 'win';
  else if (pv === dv)      result = 'tie';
  else                     result = 'lose';

  await resolveGame(game, result, interaction);
}

// ─── Command module ───────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-blackjack')
    .setDescription('Play a game of blackjack and bet Trinkets!')
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
    const remaining = checkCooldown(userId, 'blackjack', BJ_COOLDOWN_MS);
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      await interaction.reply({ content: `⏳ Wait **${secs}s** before starting a new game.`, flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // One game at a time
    if (activeGames.has(userId)) {
      await interaction.reply({
        content: '❌ You already have an active blackjack game. Finish it first!',
        flags: 64,
      });
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

    // Deal initial hands
    const playerHand = [drawCard(), drawCard()];
    const dealerHand = [drawCard(), drawCard()];

    // Natural blackjack — resolve immediately (no buttons)
    if (handValue(playerHand) === 21) {
      const payout = Math.floor(bet * 1.5);
      await addTrinkets(userId, payout, username);
      await setCooldown(userId, 'blackjack');
      logger.info('Blackjack — natural blackjack', { userId, bet, payout });
      const quickGame = { userId, username, bet, playerHand, dealerHand };
      await interaction.reply({ embeds: [buildFinalEmbed(quickGame, 'blackjack')], components: [] });
      return;
    }

    // Start game
    const game = { userId, username, bet, playerHand, dealerHand, timeout: null, message: null };
    activeGames.set(userId, game);

    await interaction.reply({ embeds: [buildGameEmbed(game)], components: [buildButtons(userId)] });
    game.message = await interaction.fetchReply();

    // 5-minute idle timeout — returns bet, disables buttons
    game.timeout = setTimeout(async () => {
      if (!activeGames.has(userId)) return;
      activeGames.delete(userId);
      logger.info('Blackjack timeout — bet returned', { userId, bet });
      try {
        await game.message.edit({
          embeds: [buildGameEmbed(game)],
          components: [buildButtons(userId, true)],
        });
        const expMsg = await game.message.channel.send(
          `⏰ <@${userId}>'s blackjack session expired — bet returned.`
        );
        setTimeout(() => expMsg.delete().catch(() => {}), 15_000);
      } catch (err) {
        logger.error('Blackjack timeout cleanup failed', { userId, error: err.message });
      }
    }, TIMEOUT_MS);
  },

  // ─── Button: Hit ───────────────────────────────────────────────────

  async handleHit(interaction, userId) {
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ This is not your game.', flags: 64 });
    }

    const game = activeGames.get(userId);
    if (!game) {
      return interaction.reply({ content: '❌ This game has already ended.', flags: 64 });
    }

    await interaction.deferUpdate();

    game.playerHand.push(drawCard());
    const pv = handValue(game.playerHand);

    if (pv > 21) {
      await resolveGame(game, 'bust', interaction);
      return;
    }
    if (pv === 21) {
      await runDealerAndResolve(game, interaction);
      return;
    }

    await interaction.editReply({ embeds: [buildGameEmbed(game)], components: [buildButtons(userId)] });
  },

  // ─── Button: Stand ─────────────────────────────────────────────────

  async handleStand(interaction, userId) {
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ This is not your game.', flags: 64 });
    }

    const game = activeGames.get(userId);
    if (!game) {
      return interaction.reply({ content: '❌ This game has already ended.', flags: 64 });
    }

    await interaction.deferUpdate();
    await runDealerAndResolve(game, interaction);
  },
};
