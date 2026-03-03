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
