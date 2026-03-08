const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { findRoleEntry } = require('../utils/roleMap');

module.exports = {
  name: 'messageReactionRemove',
  async execute(reaction, user) {
    if (user.bot) return;

    logger.debug('messageReactionRemove: received', {
      userId: user.id,
      username: user.username,
      emoji: reaction.emoji.name,
      messageId: reaction.message.id,
      partial: reaction.partial,
    });

    // Fetch partial structures (reactions on messages sent before bot started)
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
        logger.debug('messageReactionRemove: fetched partial reaction');
      } catch (err) {
        logger.error('messageReactionRemove: failed to fetch partial reaction', { error: err.message });
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
        logger.debug('messageReactionRemove: fetched partial message');
      } catch (err) {
        logger.error('messageReactionRemove: failed to fetch partial message', { error: err.message });
        return;
      }
    }

    // Only handle the stored reaction role message
    const { messageId } = storage.getRolesData();
    logger.debug('messageReactionRemove: stored messageId', { stored: messageId, received: reaction.message.id });
    if (!messageId || reaction.message.id !== messageId) {
      logger.debug('messageReactionRemove: message ID mismatch — ignoring');
      return;
    }

    const entry = findRoleEntry(reaction.emoji.name);
    logger.debug('messageReactionRemove: role entry lookup', { emoji: reaction.emoji.name, entry: entry ?? null });
    if (!entry) {
      logger.warn('messageReactionRemove: no role entry for emoji', { emoji: reaction.emoji.name });
      return;
    }

    const guild = reaction.message.guild;
    const role = guild.roles.cache.find(r => r.name === entry.role);
    if (!role) {
      const available = guild.roles.cache.map(r => r.name).join(', ');
      logger.warn('messageReactionRemove: role not found in server', {
        wanted: entry.role,
        available,
      });
      return;
    }
    logger.debug('messageReactionRemove: found role', { roleId: role.id, roleName: role.name });

    try {
      const member = await guild.members.fetch(user.id);
      logger.debug('messageReactionRemove: fetched member', { memberId: member.id, tag: member.user.tag });

      await member.roles.remove(role);
      logger.info('Reaction role removed', { userId: user.id, username: user.username, role: entry.role });
    } catch (err) {
      logger.error('messageReactionRemove: failed to remove role', {
        userId: user.id,
        role: entry.role,
        error: err.message,
        code: err.code,
      });
    }
  },
};
