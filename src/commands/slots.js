const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

const SLOTS_COOLDOWN_MS = 10_000;
const MIN_BET = 10;
const MAX_BET = 500;

const SYMBOLS = [
  { emoji: '🍒', name: 'Cherry',  weight: 40, payout:  2 },
  { emoji: '🍋', name: 'Lemon',   weight: 25, payout:  3 },
  { emoji: '🍊', name: 'Orange',  weight: 15, payout:  4 },
  { emoji: '🍇', name: 'Grape',   weight: 10, payout:  5 },
  { emoji: '⭐', name: 'Star',    weight:  6, payout: 10 },
  { emoji: '💎', name: 'Diamond', weight:  3, payout: 25 },
  { emoji: '7️⃣', name: 'Seven',   weight:  1, payout: 50 },
];

const TOTAL_WEIGHT = SYMBOLS.reduce((s, sym) => s + sym.weight, 0);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function spinReel() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const sym of SYMBOLS) {
    r -= sym.weight;
    if (r <= 0) return sym;
  }
  return SYMBOLS[SYMBOLS.length - 1];
}

function analyzeResult([r1, r2, r3]) {
  if (r1.emoji === r2.emoji && r2.emoji === r3.emoji) {
    return { type: 'three', symbol: r1 };
  }
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
      return interaction.reply({
        content: `⏳ Wait **${secs}s** before spinning again.`,
        flags: 64,
      });
    }

    // Balance check
    const player  = getPlayer(userId);
    const balance = player.balance ?? 0;
    if (balance < bet) {
      await interaction.reply({
        content: `❌ You don't have enough Trinkets to place that bet.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // Spin and evaluate
    const reels  = [spinReel(), spinReel(), spinReel()];
    const result = analyzeResult(reels);

    let netChange;
    if (result.type === 'three') {
      netChange = result.symbol.payout * bet;
    } else if (result.type === 'two') {
      netChange = -Math.ceil(bet / 2);
    } else {
      netChange = -bet;
    }

    // Phase 1 — send initial spinning embed immediately
    await interaction.reply({ embeds: [spinningEmbed(reels, 0, bet)] });

    // Commit transaction right after the reply is sent
    const newBalance = await addTrinkets(userId, netChange, username);
    await setCooldown(userId, 'slots');
    logger.info('Slots result', { userId, bet, type: result.type, netChange, newBalance });

    // Phase 2 — reveal reel 1
    await delay(1500);
    await interaction.editReply({ embeds: [spinningEmbed(reels, 1, bet)] });

    // Phase 3 — reveal reel 2
    await delay(1000);
    await interaction.editReply({ embeds: [spinningEmbed(reels, 2, bet)] });

    // Phase 4 — final result
    await delay(1000);

    let color, title, outcomeText;
    if (result.type === 'three') {
      const payout = result.symbol.payout * bet;
      color = '#FFD700';
      title = result.symbol.payout >= 50 ? '🎰 JACKPOT!'
            : result.symbol.payout >= 10 ? '🎉 Big Win!'
            : '🎉 Winner!';
      outcomeText = `Three ${result.symbol.name}s! **+${payout} 🪙**`;
    } else if (result.type === 'two') {
      const returned = Math.floor(bet / 2);
      color = '#5865F2';
      title = '🔵 Almost!';
      outcomeText = `Two ${result.symbol.name}s! **+${returned} 🪙 returned**`;
    } else {
      color = '#FF4444';
      title = '💀 No Match';
      outcomeText = `No match. **-${bet} 🪙**`;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setTitle(title)
          .setDescription(
            `[ ${reelStr(reels, 3)} ]\n\n${outcomeText}\nBalance: **${newBalance.toLocaleString()} 🪙**`
          ),
      ],
    });
  },
};
