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
    const result = claimDaily(userId, username);

    if (!result.ok) {
      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle('🪙 Daily Already Claimed')
        .setDescription(
          `You already claimed your daily reward today.\n` +
          `Come back in **${result.hoursLeft}h ${result.minutesLeft}m**.`
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    logger.info('Daily claimed', { userId, username, streak: result.newStreak, reward: result.reward });

    const streakIdx = Math.min(result.newStreak, 5);
    const bar = STREAK_BARS[streakIdx];
    const isMax = result.newStreak >= 5;
    const nextDay = result.newStreak + 1;

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
            : `Day ${nextDay} reward: **${result.nextReward} 🪙** — come back tomorrow to keep your streak!`,
        },
      )
      .setFooter({ text: 'Miss a day and your streak resets.' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
