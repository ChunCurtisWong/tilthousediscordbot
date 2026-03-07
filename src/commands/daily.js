const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { claimDaily, streakReward } = require('../utils/trinkets');
const logger = require('../utils/logger');

const STREAK_BARS = ['▱▱▱▱▱', '▰▱▱▱▱', '▰▰▱▱▱', '▰▰▰▱▱', '▰▰▰▰▱', '▰▰▰▰▰'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-daily')
    .setDescription('Claim your daily Trinket bonus'),

  async execute(interaction) {
    const { id: userId, username } = interaction.user;
    const result = await claimDaily(userId, username);

    if (!result.ok) {
      const resetTs = Math.floor(result.nextResetTs / 1000);
      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle('🪙 Daily Already Claimed')
        .setDescription(
          `You already claimed your daily reward.\n` +
          `Come back <t:${resetTs}:R> (resets at **7pm ET** daily).`
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    logger.info('Daily claimed', { userId, username, streak: result.newStreak, reward: result.reward });

    const streakIdx = Math.min(result.newStreak, 5);
    const bar       = STREAK_BARS[streakIdx];
    const isMax     = result.newStreak >= 5;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Daily Reward Claimed!')
      .addFields(
        { name: '💰 Reward', value: `**+${result.reward} Trinkets**`, inline: true },
        { name: '🏦 New Balance', value: `**${result.newBalance.toLocaleString()} 🪙**`, inline: true },
        {
          name: `🔥 Streak — Day ${result.newStreak} ${bar}`,
          value: isMax
            ? '**Maximum streak reached!** (+300 🪙 per day)'
            : `Day ${result.newStreak + 1} reward: **${result.nextReward} 🪙** — come back after 7pm ET to keep your streak!`,
        },
      )
      .setFooter({ text: 'Resets daily at 7pm ET. Miss a window and your streak resets.' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
