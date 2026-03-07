const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { getBackupList, restoreBackup } = require('../utils/trinkets');
const logger = require('../utils/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-restore')
    .setDescription('(Admin) Restore Trinket data from a backup')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Only administrators can use this command.', ephemeral: true });
    }

    const backups = getBackupList();
    if (backups.length === 0) {
      return interaction.reply({ content: '❌ No backups are available yet.', ephemeral: true });
    }

    const options = backups.slice(0, 25).map(b =>
      new StringSelectMenuOptionBuilder()
        .setLabel(b.label.slice(0, 100))
        .setValue(b.key)
        .setDescription(b.description.slice(0, 100))
    );

    const select = new StringSelectMenuBuilder()
      .setCustomId('restore:select')
      .setPlaceholder('Choose a backup to restore…')
      .addOptions(options);

    return interaction.reply({
      content: '📂 Select a backup to restore from:',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  },

  // ── Select: user picked a backup ──────────────────────────────────

  async handleSelect(interaction) {
    const key     = interaction.values[0];
    const backups = getBackupList();
    const backup  = backups.find(b => b.key === key);

    if (!backup) {
      return interaction.update({ content: '❌ Backup not found.', components: [], embeds: [] });
    }

    const embed = new EmbedBuilder()
      .setColor('#FF6B6B')
      .setTitle('⚠️ Confirm Restore')
      .setDescription(
        `You are about to restore from:\n**${backup.label}**\n${backup.description}\n\n` +
          `The current Trinket data will be saved to \`trinkets-pre-restore.json\` before overwriting, ` +
          `so nothing is permanently lost.\n\n**This cannot be undone. Continue?**`
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`restore:yes:${key}`)
        .setLabel('Restore')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('restore:no')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    return interaction.update({ content: null, embeds: [embed], components: [row] });
  },

  // ── Button: confirmed restore ──────────────────────────────────────

  async handleConfirmYes(interaction, key) {
    await interaction.deferUpdate();
    try {
      await restoreBackup(key);
      logger.info('Trinkets restored by admin', { key, userId: interaction.user.id });
      return interaction.editReply({
        content:    '✅ Trinket data restored successfully. The previous state was saved to `trinkets-pre-restore.json`.',
        embeds:     [],
        components: [],
      });
    } catch (err) {
      logger.error('Trinket restore failed', { key, error: err.message });
      return interaction.editReply({
        content:    `❌ Restore failed: ${err.message}`,
        embeds:     [],
        components: [],
      });
    }
  },

  // ── Button: cancelled ─────────────────────────────────────────────

  async handleConfirmNo(interaction) {
    return interaction.update({ content: '❌ Restore cancelled.', embeds: [], components: [] });
  },
};
