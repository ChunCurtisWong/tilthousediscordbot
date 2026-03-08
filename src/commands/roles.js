const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { EMOJI_ROLES } = require('../utils/roleMap');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-roles')
    .setDescription('(Admin) Post the reaction role embed in #roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // ── Find the #roles channel ───────────────────────────────────────
    const rolesChannel = interaction.guild.channels.cache.find(
      c => c.name === 'roles' && c.isTextBased()
    );
    if (!rolesChannel) {
      return interaction.editReply({ content: '❌ Could not find a text channel named **#roles**.' });
    }

    // ── Delete old embed if one exists ───────────────────────────────
    const existing = storage.getRolesData();
    if (existing.messageId && existing.channelId) {
      try {
        const oldChannel = interaction.guild.channels.cache.get(existing.channelId);
        const oldMsg = await oldChannel?.messages.fetch(existing.messageId);
        if (oldMsg) await oldMsg.delete();
      } catch {
        // Message already gone — continue
      }
    }

    // ── Build the embed ───────────────────────────────────────────────
    const mappingLines = EMOJI_ROLES.map(e => `${e.emoji}  **${e.label}** → ${e.role}`);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎮 Game Role Selection')
      .setDescription(
        'React to assign yourself a game notification role.\n' +
        'Click the reaction again to remove it.\n\n' +
        mappingLines.join('\n')
      )
      .setFooter({ text: 'Roles are self-assigned — no admin action required' });

    // ── Post the embed (no role/user pings) ───────────────────────────
    const msg = await rolesChannel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });

    // ── Add all reactions in order ────────────────────────────────────
    for (const { emoji } of EMOJI_ROLES) {
      try {
        await msg.react(emoji);
      } catch (err) {
        logger.warn('th-roles: failed to add reaction', { emoji, error: err.message });
      }
    }

    // ── Persist so reaction handlers survive restarts ─────────────────
    storage.saveRolesData({ messageId: msg.id, channelId: rolesChannel.id });
    logger.info('Reaction role embed posted', { messageId: msg.id, channelId: rolesChannel.id });

    return interaction.editReply({
      content: `✅ Reaction role embed posted in ${rolesChannel}. All ${EMOJI_ROLES.length} reactions added.`,
    });
  },
};
