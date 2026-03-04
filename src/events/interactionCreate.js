const logger = require('../utils/logger');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    // ── Slash commands ──────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn('Unknown command received', {
          commandName: interaction.commandName,
          userId: interaction.user.id,
          guildId: interaction.guildId,
        });
        return interaction.reply({ content: '❌ Unknown command.', ephemeral: true });
      }

      logger.info(`Command: /${interaction.commandName}`, {
        subcommand: interaction.options.getSubcommand?.(false) ?? null,
        userId: interaction.user.id,
        username: interaction.user.username,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });

      try {
        await command.execute(interaction);
      } catch (err) {
        logger.error(`Error in command /${interaction.commandName}`, {
          error: err.message,
          stack: err.stack,
          userId: interaction.user.id,
          guildId: interaction.guildId,
        });

        const errorMsg = { content: '❌ An error occurred while executing this command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errorMsg).catch(() => {});
        } else {
          await interaction.reply(errorMsg).catch(() => {});
        }
      }
      return;
    }

    // ── Queue buttons (q:join:<game> / q:leave:<game>) ──────────────
    if (interaction.isButton()) {
      const { customId } = interaction;
      const queueCmd = interaction.client.commands.get('th-queue');
      try {
        if (customId.startsWith('q:join:') && queueCmd?.handleButtonJoin) {
          const game = customId.slice('q:join:'.length);
          logger.info('Button: queue join', { game, userId: interaction.user.id });
          await queueCmd.handleButtonJoin(interaction, game);
        } else if (customId.startsWith('q:leave:') && queueCmd?.handleButtonLeave) {
          const game = customId.slice('q:leave:'.length);
          logger.info('Button: queue leave', { game, userId: interaction.user.id });
          await queueCmd.handleButtonLeave(interaction, game);
        }
      } catch (err) {
        logger.error('Button interaction error', {
          customId,
          error: err.message,
          stack: err.stack,
          userId: interaction.user.id,
        });
        const errorMsg = { content: '❌ An error occurred.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errorMsg).catch(() => {});
        } else {
          await interaction.reply(errorMsg).catch(() => {});
        }
      }
      return;
    }

    // ── Autocomplete ────────────────────────────────────────────────
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command?.autocomplete) return;

      try {
        await command.autocomplete(interaction);
      } catch (err) {
        logger.error(`Autocomplete error in /${interaction.commandName}`, {
          error: err.message,
          stack: err.stack,
        });
      }
    }
  },
};
