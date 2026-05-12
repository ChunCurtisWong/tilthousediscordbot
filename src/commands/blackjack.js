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

const BJ_COOLDOWN_MS     = 5_000;
const MIN_BET            = 10;
const MAX_BET            = 500;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const FACE  = { A: 11, J: 10, Q: 10, K: 10 };

// In-memory state — cleared on bot restart (intentional)
const activeGames    = new Map(); // userId → game
const activeSessions = new Map(); // userId → session

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

function gameButtons(userId, playAgainDisabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj:again:${userId}`)
      .setLabel('Play Again')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(playAgainDisabled),
    new ButtonBuilder()
      .setCustomId(`bj:changebet:${userId}`)
      .setLabel('Change Bet')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bj:refresh:${userId}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`bj:stop:${userId}`)
      .setLabel('Stop Playing')
      .setStyle(ButtonStyle.Secondary)
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

function buildSummaryEmbed(session) {
  const { gamesPlayed, spent, earned } = session;
  const net    = earned - spent;
  const color  = net > 0 ? '#00CC66' : net < 0 ? '#FF4444' : '#808080';
  const netStr = net > 0 ? `+${net}` : `${net}`;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle('🃏 Session Summary')
    .setDescription(
      `Games played: **${gamesPlayed}**\n` +
      `Trinkets spent: **${spent} 🪙**\n` +
      `Trinkets earned: **${earned} 🪙**\n` +
      `Net: **${netStr} 🪙**`
    );
}

// ─── Session timeout ──────────────────────────────────────────────────────────

function startSessionTimeout(session, userId) {
  clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    if (!activeSessions.has(userId)) return;
    activeSessions.delete(userId);
    activeGames.delete(userId); // cancel any in-progress game (bet never deducted)
    try { await session.message.edit({ embeds: [buildSummaryEmbed(session)], components: [] }); }
    catch { /* ignore */ }
  }, SESSION_TIMEOUT_MS);
}

// ─── Game logic ───────────────────────────────────────────────────────────────

async function resolveGame(game, result, interaction) {
  activeGames.delete(game.userId);

  let netChange = 0;
  if (result === 'blackjack')                      netChange =  Math.floor(game.bet * 1.5);
  else if (result === 'win')                       netChange =  Math.floor(game.bet * 0.8);
  else if (result === 'bust' || result === 'lose') netChange = -game.bet;

  if (netChange !== 0) await addTrinkets(game.userId, netChange, game.username);
  await setCooldown(game.userId, 'blackjack');

  const session = activeSessions.get(game.userId);
  if (session) {
    session.gamesPlayed++;
    session.spent  += game.bet;
    session.earned += Math.max(0, game.bet + netChange);
  }

  logger.info('Blackjack resolved', {
    userId: game.userId, bet: game.bet, result, netChange,
    playerValue: handValue(game.playerHand),
    dealerValue: handValue(game.dealerHand),
  });

  await interaction.editReply({
    embeds: [buildFinalEmbed(game, result)],
    components: session ? [gameButtons(game.userId)] : [],
  });
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

// Starts a new game on the session message.
// sendGame(opts) → Promise<Message> handles the first message send.
async function beginGame(userId, username, bet, session, sendGame) {
  const playerHand = [drawCard(), drawCard()];
  const dealerHand = [drawCard(), drawCard()];

  if (handValue(playerHand) === 21) {
    const payout = Math.floor(bet * 1.5);
    await addTrinkets(userId, payout, username);
    await setCooldown(userId, 'blackjack');
    logger.info('Blackjack — natural blackjack', { userId, bet, payout });

    session.gamesPlayed++;
    session.spent  += bet;
    session.earned += bet + payout;

    const quickGame = { userId, username, bet, playerHand, dealerHand };
    await sendGame({ embeds: [buildFinalEmbed(quickGame, 'blackjack')], components: [gameButtons(userId)] });
    return;
  }

  const game = { userId, username, bet, playerHand, dealerHand };
  activeGames.set(userId, game);

  await sendGame({ embeds: [buildGameEmbed(game)], components: [buildButtons(userId)] });
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

    // Block if session already active
    if (activeSessions.has(userId)) {
      await interaction.reply({
        content: '❌ You already have an active blackjack session. Stop it before starting a new one.',
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    const session = { bet, gamesPlayed: 0, spent: 0, earned: 0, net: 0, timeout: null, message: null };
    activeSessions.set(userId, session);

    await beginGame(userId, username, bet, session, async opts => {
      await interaction.reply(opts);
      session.message = await interaction.fetchReply();
    });

    startSessionTimeout(session, userId);
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

    const session = activeSessions.get(userId);
    if (session) startSessionTimeout(session, userId);

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

    const session = activeSessions.get(userId);
    if (session) startSessionTimeout(session, userId);

    await runDealerAndResolve(game, interaction);
  },

  // ─── Button: Play Again ────────────────────────────────────────────

  async handlePlayAgain(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    if (activeGames.has(userId)) return interaction.deferUpdate();

    const { bet, message } = session;
    const username = interaction.user.username;

    // Cooldown — leave buttons enabled
    const remaining = checkCooldown(userId, 'blackjack', BJ_COOLDOWN_MS);
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      await interaction.reply({ content: `⏳ Wait **${secs}s** before starting a new game.`, flags: 64 });
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

    await beginGame(userId, username, bet, session, opts => message.edit(opts));
  },

  // ─── Button: Stop Playing ──────────────────────────────────────────

  async handleStop(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    clearTimeout(session.timeout);
    activeSessions.delete(userId);
    activeGames.delete(userId); // cancel any in-progress game

    await interaction.update({ embeds: [buildSummaryEmbed(session)], components: [] });
  },

  // ─── Button: Refresh ──────────────────────────────────────────────

  async handleRefresh(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    if (activeGames.has(userId)) return interaction.deferUpdate();

    await interaction.deferUpdate();

    const embeds = session.message.embeds;
    try { await session.message.delete(); } catch { /* ignore */ }

    session.message = await interaction.channel.send({
      embeds,
      components: [gameButtons(userId)],
    });
  },

  // ─── Button: Change Bet ────────────────────────────────────────────

  async handleChangeBet(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    if (activeGames.has(userId)) return interaction.deferUpdate();

    const modal = new ModalBuilder()
      .setCustomId('bj:bet_modal')
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

  // ─── Modal: Bet amount submit ──────────────────────────────────────

  async handleBetModal(interaction) {
    const userId  = interaction.user.id;
    const session = activeSessions.get(userId);

    if (!session) {
      await interaction.reply({ content: '❌ No active blackjack session found.', flags: 64 });
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
