const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getLeaderboard } = require('../utils/trinkets');

const MEDALS = ['🥇', '🥈', '🥉'];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-leaderboard')
    .setDescription('Show the top 3 Trinket holders'),

  async execute(interaction) {
    const top = getLeaderboard(3);

    if (top.length === 0) {
      return interaction.reply({
        content: '❌ No Trinket data yet. Claim your `/th-daily` to get started!',
        ephemeral: true,
      });
    }

    const lines = top.map(
      (entry, i) =>
        `${MEDALS[i]} **${entry.username}** — ${entry.balance.toLocaleString()} 🪙`
    );

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Trinket Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Top 3 players by Trinket balance' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
