const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { addTrinkets } = require('../utils/trinkets');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-give')
    .setDescription('(Admin) Give Trinkets to a user')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User to give Trinkets to').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt
        .setName('amount')
        .setDescription('Number of Trinkets to give')
        .setMinValue(1)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '❌ Only administrators can use this command.',
        ephemeral: true,
      });
    }

    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');

    if (target.bot) {
      return interaction.reply({ content: '❌ Cannot give Trinkets to a bot.', ephemeral: true });
    }

    const newBalance = await addTrinkets(target.id, amount, target.username);
    logger.info('Trinkets given by admin', {
      givenBy: interaction.user.id,
      targetId: target.id,
      amount,
      newBalance,
    });

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Trinkets Given')
      .setDescription(
        `<@${interaction.user.id}> gave **${amount.toLocaleString()} 🪙** to <@${target.id}>.\n` +
        `Their new balance is **${newBalance.toLocaleString()} 🪙**.`
      );

    return interaction.reply({ embeds: [embed] });
  },
};
