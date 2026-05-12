const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fishCmd = require('./fish');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-icebox')
    .setDescription("View your current fishing session's catch log"),

  async execute(interaction) {
    const userId   = interaction.user.id;
    const username = interaction.user.username;
    const session  = fishCmd.getSession(userId);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(`🧊 ${username}'s Icebox`);

    if (!session || session.fishLog.size === 0) {
      embed.setDescription('🧊 Your icebox is empty!\nStart a fishing session with `/th-fish`');
      return interaction.reply({ embeds: [embed] });
    }

    let totalEarned = 0;
    let totalLost   = 0;
    const lines = [];

    for (const [name, entry] of session.fishLog) {
      const rewardStr = entry.totalReward > 0
        ? `(+${entry.totalReward} 🪙)`
        : entry.totalReward < 0
          ? `(${entry.totalReward} 🪙)`
          : `(+0 🪙)`;

      lines.push(`${entry.emoji} **${name}** ×${entry.count}  ${rewardStr}`);

      if (entry.totalReward > 0) totalEarned += entry.totalReward;
      else                       totalLost   += entry.totalReward;
    }

    const net    = totalEarned + totalLost;
    const netStr = net >= 0 ? `+${net} 🪙` : `${net} 🪙`;
    const div    = '─'.repeat(32);

    embed.setDescription(
      lines.join('\n') + `\n${div}\n` +
      `Total earned: **${totalEarned} 🪙**\n` +
      `Total lost:   **${totalLost} 🪙**\n` +
      `Net:          **${netStr}**`
    );

    return interaction.reply({ embeds: [embed] });
  },
};
