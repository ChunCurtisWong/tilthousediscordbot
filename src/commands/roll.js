const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-roll')
    .setDescription('Roll a dice')
    .addIntegerOption(opt =>
      opt
        .setName('sides')
        .setDescription('Number of sides on the dice (default: 6)')
        .setMinValue(2)
        .setMaxValue(1000)
        .setRequired(false)
    ),

  async execute(interaction) {
    const sides = interaction.options.getInteger('sides') ?? 6;
    const result = Math.floor(Math.random() * sides) + 1;

    const isCrit  = result === sides;
    const isFail  = result === 1;

    let color = '#5865F2';
    let title = `🎲 d${sides} — Rolled a ${result}`;
    let description = `You rolled a **${result}** out of ${sides}.`;

    if (isCrit) {
      color = '#FFD700';
      title = `🎲 d${sides} — Rolled a ${result} 🎉`;
      description = `You rolled a **${result}** out of ${sides}.\n\n✨ **NATURAL ${sides}! PERFECT ROLL!** ✨`;
    } else if (isFail) {
      color = '#FF6B6B';
      title = `🎲 d${sides} — Rolled a ${result} 💀`;
      description = `You rolled a **${result}** out of ${sides}.\n\n💀 **CRITICAL FAIL!** The dice gods are not pleased.`;
    }

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description);

    return interaction.reply({ embeds: [embed] });
  },
};
