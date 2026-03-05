const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayer, streakReward } = require('../utils/trinkets');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-trinkets')
    .setDescription('Check your Trinket balance and daily streak'),

  async execute(interaction) {
    const player = getPlayer(interaction.user.id);
    const streak = player.streak ?? 0;
    const nextReward = streakReward(streak + 1);

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Your Trinkets')
      .addFields(
        { name: '💰 Balance', value: `**${(player.balance ?? 0).toLocaleString()} 🪙**`, inline: true },
        { name: '🔥 Daily Streak', value: `**${streak} day${streak !== 1 ? 's' : ''}**`, inline: true },
      );

    if (streak > 0) {
      embed.addFields({
        name: 'Next Daily',
        value: streak >= 5
          ? `Keep your streak going for **300 🪙** per day (max).`
          : `Claim tomorrow for **${nextReward} 🪙** (Day ${streak + 1}).`,
      });
    }

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
