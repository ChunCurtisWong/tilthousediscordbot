const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { claimDaily, streakReward } = require('../utils/trinkets');
const logger = require('../utils/logger');


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
      await interaction.reply({ embeds: [embed], flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    logger.info('Daily claimed', { userId, username, streak: result.newStreak, reward: result.reward });

    const streakLabel = result.newStreak >= 5
      ? `Day ${result.newStreak} 🔥 (max)`
      : `Day ${result.newStreak} 🔥`;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Daily Claimed!')
      .setDescription(`<@${userId}> has claimed their daily Trinkets!`)
      .addFields(
        { name: 'Trinkets Earned', value: `+${result.reward} Trinkets`, inline: true },
        { name: 'Streak', value: streakLabel, inline: true },
      );

    await interaction.deferReply({ flags: 64 });
    await interaction.deleteReply();

    const msg = await interaction.channel.send({ embeds: [embed] });
    setTimeout(() => msg.delete().catch(() => {}), 5 * 60 * 1000);
  },
};
