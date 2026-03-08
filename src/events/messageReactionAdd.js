const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { findRoleEntry } = require('../utils/roleMap');

module.exports = {
  name: 'messageReactionAdd',
  async execute(reaction, user) {
    if (user.bot) return;

    logger.debug('messageReactionAdd: received', {
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
        logger.debug('messageReactionAdd: fetched partial reaction');
      } catch (err) {
        logger.error('messageReactionAdd: failed to fetch partial reaction', { error: err.message });
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
        logger.debug('messageReactionAdd: fetched partial message');
      } catch (err) {
        logger.error('messageReactionAdd: failed to fetch partial message', { error: err.message });
        return;
      }
    }

    // Only handle the stored reaction role message
    const { messageId } = storage.getRolesData();
    logger.debug('messageReactionAdd: stored messageId', { stored: messageId, received: reaction.message.id });
    if (!messageId || reaction.message.id !== messageId) {
      logger.debug('messageReactionAdd: message ID mismatch — ignoring');
      return;
    }

    const entry = findRoleEntry(reaction.emoji.name);
    logger.debug('messageReactionAdd: role entry lookup', { emoji: reaction.emoji.name, entry: entry ?? null });
    if (!entry) {
      logger.warn('messageReactionAdd: no role entry for emoji', { emoji: reaction.emoji.name });
      return;
    }

    const guild = reaction.message.guild;
    const role = guild.roles.cache.find(r => r.name === entry.role);
    if (!role) {
      const available = guild.roles.cache.map(r => r.name).join(', ');
      logger.warn('messageReactionAdd: role not found in server', {
        wanted: entry.role,
        available,
      });
      return;
    }
    logger.debug('messageReactionAdd: found role', { roleId: role.id, roleName: role.name });

    try {
      const member = await guild.members.fetch(user.id);
      logger.debug('messageReactionAdd: fetched member', { memberId: member.id, tag: member.user.tag });

      // Check bot's top role vs target role for hierarchy
      const botMember = await guild.members.fetchMe();
      const botHighest = botMember.roles.highest.position;
      if (role.position >= botHighest) {
        logger.warn('messageReactionAdd: role hierarchy issue — bot role must be above target role', {
          botHighestPosition: botHighest,
          targetRolePosition: role.position,
          targetRoleName: role.name,
        });
      }

      await member.roles.add(role);
      logger.info('Reaction role added', { userId: user.id, username: user.username, role: entry.role });
    } catch (err) {
      logger.error('messageReactionAdd: failed to add role', {
        userId: user.id,
        role: entry.role,
        error: err.message,
        code: err.code,
      });
    }
  },
};
