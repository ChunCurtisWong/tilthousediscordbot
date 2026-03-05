const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-flip')
    .setDescription('Flip a coin'),

  async execute(interaction) {
    const heads = Math.random() < 0.5;
    const embed = new EmbedBuilder()
      .setColor(heads ? '#FFD700' : '#C0C0C0')
      .setTitle(heads ? '🪙 Heads!' : '🪙 Tails!')
      .setDescription(heads ? 'The coin landed on **Heads**.' : 'The coin landed on **Tails**.');

    return interaction.reply({ embeds: [embed] });
  },
};
