const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { findRoleEntry } = require('../utils/roleMap');

module.exports = {
  name: 'messageReactionAdd',
  async execute(reaction, user) {
    if (user.bot) return;

    // Fetch partial structures (reactions on messages sent before bot started)
    if (reaction.partial) {
      try { reaction = await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    // Only handle the stored reaction role message
    const { messageId } = storage.getRolesData();
    if (!messageId || reaction.message.id !== messageId) return;

    const entry = findRoleEntry(reaction.emoji.name);
    if (!entry) return;

    const guild = reaction.message.guild;
    const role = guild.roles.cache.find(r => r.name === entry.role);
    if (!role) {
      logger.warn('Reaction roles: role not found in server', { roleName: entry.role });
      return;
    }

    try {
      const member = await guild.members.fetch(user.id);
      await member.roles.add(role);
      logger.info('Reaction role added', { userId: user.id, username: user.username, role: entry.role });
    } catch (err) {
      logger.error('Reaction roles: failed to add role', {
        userId: user.id,
        role: entry.role,
        error: err.message,
      });
    }
  },
};
