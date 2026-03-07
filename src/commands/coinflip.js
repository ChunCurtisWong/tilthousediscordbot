const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-coinflip')
    .setDescription('Flip a coin — optionally bet Trinkets on the result')
    .addStringOption(opt =>
      opt
        .setName('amount')
        .setDescription('Amount to bet (number or "all") — leave blank for a free flip')
    )
    .addStringOption(opt =>
      opt
        .setName('choice')
        .setDescription('Pick a side (optional, only applies when betting)')
        .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })
    ),

  async execute(interaction) {
    const userId   = interaction.user.id;
    const username = interaction.user.username;
    const amountStr = interaction.options.getString('amount');
    const choice    = interaction.options.getString('choice'); // 'heads' | 'tails' | null
    const betting   = amountStr !== null;

    // ── Flip the coin ─────────────────────────────────────────────────
    const result  = Math.random() < 0.5 ? 'heads' : 'tails';
    const isHeads = result === 'heads';
    const coinEmoji   = isHeads ? '🪙' : '🌑';
    const resultLabel = isHeads ? 'Heads' : 'Tails';

    // ── Free flip (no bet) ────────────────────────────────────────────
    if (!betting) {
      const embed = new EmbedBuilder()
        .setColor(isHeads ? '#FFD700' : '#C0C0C0')
        .setTitle(`${coinEmoji} ${resultLabel}!`)
        .setDescription(`The coin landed on **${resultLabel}**.`)
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ── Betting flow ──────────────────────────────────────────────────

    // Cooldown check
    const remaining = checkCooldown(userId, 'coinflip');
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      return interaction.reply({
        content: `⏳ Wait **${secs}s** before placing another bet.`,
        ephemeral: true,
      });
    }

    const player  = getPlayer(userId);
    const balance = player.balance ?? 0;

    // Parse and validate bet
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

    // Determine win/loss: with choice → match wins; without → heads wins
    const won = choice !== null ? result === choice : isHeads;

    // Apply and set cooldown
    const newBalance = await addTrinkets(userId, won ? bet : -bet, username);
    await setCooldown(userId, 'coinflip');

    logger.info('Coinflip bet result', { userId, bet, choice, result, won, newBalance });

    // Public embed — result and win/loss, no balance
    let description = `${coinEmoji} The coin landed on **${resultLabel}**!\n\n`;
    if (choice) {
      description += `You picked **${choice === 'heads' ? 'Heads' : 'Tails'}** — `;
    }
    description += won ? `**<@${userId}> won ${bet} 🪙!**` : `**<@${userId}> lost ${bet} 🪙!**`;

    const resultEmbed = new EmbedBuilder()
      .setColor(won ? '#FFD700' : '#FF4444')
      .setTitle(won ? '🎉 Winner!' : '💀 Better luck next time!')
      .setDescription(description)
      .setTimestamp();

    await interaction.reply({ embeds: [resultEmbed] });

    // Ephemeral balance reveal — only visible to the player
    await interaction.followUp({
      content: `Your new balance: **${newBalance} 🪙**`,
      ephemeral: true,
    });
  },
};
