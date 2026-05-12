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

    if (!session) {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🎣 ${username}'s Fishing Log`)
        .setDescription('🧊 Your icebox is empty!\nStart a fishing session with `/th-fish`');
      return interaction.reply({ embeds: [embed] });
    }

    const embed = fishCmd.buildSummaryEmbed(session);

    await interaction.reply({ embeds: [embed], components: [fishCmd.iceboxButtons(userId)] });
    const msg = await interaction.fetchReply();
    session.iceboxMessages.push(msg);
  },
};
