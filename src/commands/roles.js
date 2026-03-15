const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { ACTIVE_ROLES } = require('../utils/roleMap');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-roles')
    .setDescription('(Admin) Post the reaction role embed in #roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

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

    // ── Count existing role holders ──────────────────────────────────
    // Populate cache with a 5s timeout; fall back to existing cache on timeout
    try {
      await Promise.race([
        interaction.guild.members.fetch(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
    } catch (err) {
      logger.warn('th-roles: members.fetch() timed out or failed, using cache', { error: err.message });
    }
    const mappingLines = ACTIVE_ROLES.map(e => {
      const serverRole = interaction.guild.roles.cache.find(r => r.name === e.role);
      const count = serverRole ? serverRole.members.size : 0;
      const suffix = count > 0 ? ` *(${count})*` : '';
      return `${e.emoji}  **${e.label}** → ${e.role}${suffix}`;
    });

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Role Selection')
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
    for (const { emoji } of ACTIVE_ROLES) {
      try {
        await msg.react(emoji);
      } catch (err) {
        logger.warn('th-roles: failed to add reaction', { emoji, error: err.message });
      }
    }

    // ── Persist so reaction handlers survive restarts ─────────────────
    storage.saveRolesData({ messageId: msg.id, channelId: rolesChannel.id });
    logger.info('Reaction role embed posted', { messageId: msg.id, channelId: rolesChannel.id });

    await interaction.editReply({
      content: `✅ Reaction role embed posted in ${rolesChannel}. All ${ACTIVE_ROLES.length} reactions added.`,
    });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
  },
};
