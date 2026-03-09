const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const storage = require('../utils/storage');
const { refreshPublicEmbed } = require('./list');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-random')
    .setDescription('Pick a random player from the active list and ping them'),

  async execute(interaction) {
    const listData = storage.getList();

    if (!listData || listData.players.length === 0) {
      return interaction.reply({
        content: '❌ The active list is empty or there is no active list.',
        flags: 64,
      });
    }

    const idx = Math.floor(Math.random() * listData.players.length);
    const picked = listData.players[idx];

    logger.info('Random player picked', { userId: picked.userId, username: picked.username });

    // Public announcement in the channel
    await interaction.reply({
      content: `🎲 <@${picked.userId}> was randomly selected from the list!`,
    });

    // Ephemeral prompt to the command runner: remove or keep
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`l:rnd:rm:${picked.userId}`)
        .setLabel('Remove from list')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️'),
      new ButtonBuilder()
        .setCustomId('l:rnd:keep')
        .setLabel('Keep in list')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✅'),
    );

    await interaction.followUp({
      content: `Remove **${picked.username}** from the list?`,
      components: [row],
      flags: 64,
    });
  },

  // ── Button: Remove the picked player ─────────────────────────────────────
  async handleRemove(interaction, pickedUserId) {
    await interaction.deferUpdate();
    const listData = storage.getList();

    if (!listData) {
      return interaction.editReply({ content: '❌ No active list.', components: [] });
    }

    const idx = listData.players.findIndex(p => p.userId === pickedUserId);
    if (idx === -1) {
      return interaction.editReply({ content: '❌ That player is no longer in the list.', components: [] });
    }

    const removed = listData.players.splice(idx, 1)[0];
    storage.saveList(listData);

    // Update the public list embed to reflect the removal
    await refreshPublicEmbed(interaction.client, listData);

    logger.info('Random pick removed from list', { userId: removed.userId });
    return interaction.editReply({
      content: `✅ Removed <@${removed.userId}> from the list.`,
      components: [],
    });
  },

  // ── Button: Keep the picked player ───────────────────────────────────────
  async handleKeep(interaction) {
    return interaction.update({ content: '✅ Player kept in the list.', components: [] });
  },
};
