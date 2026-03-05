const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-coinflip')
    .setDescription('Bet Trinkets on a coin flip')
    .addStringOption(opt =>
      opt
        .setName('amount')
        .setDescription('Amount to bet (number or "all")')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt
        .setName('choice')
        .setDescription('Pick a side (optional)')
        .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })
    ),

  async execute(interaction) {
    const userId   = interaction.user.id;
    const username = interaction.user.username;

    // ── Cooldown check ────────────────────────────────────────────────
    const remaining = checkCooldown(userId, 'coinflip');
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      return interaction.reply({
        content: `⏳ Wait **${secs}s** before flipping again.`,
        ephemeral: true,
      });
    }

    const player  = getPlayer(userId);
    const balance = player.balance ?? 0;

    // ── Parse amount ──────────────────────────────────────────────────
    const amountStr = interaction.options.getString('amount');
    let bet;
    if (amountStr.toLowerCase() === 'all') {
      bet = balance;
    } else {
      bet = parseInt(amountStr, 10);
      if (isNaN(bet) || bet <= 0) {
        return interaction.reply({ content: '❌ Enter a valid positive number or `all`.', ephemeral: true });
      }
    }

    if (bet < 10) {
      return interaction.reply({ content: '❌ Minimum bet is **10 🪙**.', ephemeral: true });
    }
    if (bet > balance) {
      return interaction.reply({
        content: `❌ You only have **${balance} 🪙** — you can't bet **${bet} 🪙**.`,
        ephemeral: true,
      });
    }

    // ── Flip ──────────────────────────────────────────────────────────
    const choice = interaction.options.getString('choice'); // 'heads' | 'tails' | null
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const won    = choice !== null ? result === choice : result === 'heads';

    // ── Apply result ──────────────────────────────────────────────────
    const newBalance = addTrinkets(userId, won ? bet : -bet, username);
    setCooldown(userId, 'coinflip');

    logger.info('Coinflip result', { userId, bet, choice, result, won, newBalance });

    const coinEmoji   = result === 'heads' ? '🪙' : '🌑';
    const resultLabel = result === 'heads' ? 'Heads' : 'Tails';

    let description = `${coinEmoji} The coin landed on **${resultLabel}**!\n\n`;
    if (choice) {
      description += `You picked **${choice === 'heads' ? 'Heads' : 'Tails'}** — `;
    }
    description += won
      ? `**You won ${bet} 🪙!**`
      : `**You lost ${bet} 🪙!**`;
    description += `\n\nNew balance: **${newBalance} 🪙**`;

    const embed = new EmbedBuilder()
      .setColor(won ? '#FFD700' : '#FF4444')
      .setTitle(won ? '🎉 Winner!' : '💀 Better luck next time!')
      .setDescription(description)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },
};
