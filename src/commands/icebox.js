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
        .setTitle(`🧊 ${username}'s Icebox`)
        .setDescription('🧊 Your icebox is empty!\nStart a fishing session with `/th-fish`');
      return interaction.reply({ embeds: [embed] });
    }

    const embed = fishCmd.buildSummaryEmbed(session)
      .setTitle(`🧊 ${username}'s Icebox`);

    await interaction.reply({ embeds: [embed] });
    const msg = await interaction.fetchReply();
    session.iceboxMessages.push(msg);
  },
};
