const logger = require('../utils/logger');

// Shared error-reply helper for interaction handlers
async function safeError(interaction, err, label) {
  logger.error(label, {
    customId: interaction.customId,
    error: err.message,
    stack: err.stack,
    userId: interaction.user.id,
  });
  const msg = { content: '❌ An error occurred.', flags: 64 };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(msg).catch(() => {});
  } else {
    await interaction.reply(msg).catch(() => {});
  }
}

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
        return interaction.reply({ content: '❌ Unknown command.', flags: 64 });
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
        const errorMsg = { content: '❌ An error occurred while executing this command.', flags: 64 };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errorMsg).catch(() => {});
        } else {
          await interaction.reply(errorMsg).catch(() => {});
        }
      }
      return;
    }

    // ── Buttons ──────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { customId } = interaction;

      try {
        // Queue buttons
        if (customId.startsWith('q:')) {
          const queueCmd = interaction.client.commands.get('th-queue');
          if (customId.startsWith('q:join_fill:')) {
            const game = customId.slice('q:join_fill:'.length);
            logger.info('Button: queue join fill', { game, userId: interaction.user.id });
            await queueCmd.handleButtonJoinFill(interaction, game);
          } else if (customId.startsWith('q:join:')) {
            const game = customId.slice('q:join:'.length);
            logger.info('Button: queue join', { game, userId: interaction.user.id });
            await queueCmd.handleButtonJoin(interaction, game);
          } else if (customId.startsWith('q:leave:')) {
            const game = customId.slice('q:leave:'.length);
            logger.info('Button: queue leave', { game, userId: interaction.user.id });
            await queueCmd.handleButtonLeave(interaction, game);
          } else if (customId.startsWith('q:edit:')) {
            const game = customId.slice('q:edit:'.length);
            logger.info('Button: queue edit', { game, userId: interaction.user.id });
            await queueCmd.handleButtonEdit(interaction, game);
          } else if (customId.startsWith('q:ready:')) {
            const game = customId.slice('q:ready:'.length);
            logger.info('Button: queue ready', { game, userId: interaction.user.id });
            await queueCmd.handleButtonReady(interaction, game);
          } else if (customId.startsWith('q:unready:')) {
            const game = customId.slice('q:unready:'.length);
            logger.info('Button: queue unready', { game, userId: interaction.user.id });
            await queueCmd.handleButtonUnready(interaction, game);
          } else if (customId.startsWith('q:session_yes:')) {
            const game = customId.slice('q:session_yes:'.length);
            logger.info('Button: session yes', { game, userId: interaction.user.id });
            await queueCmd.handleSessionYes(interaction, game);
          } else if (customId.startsWith('q:session_no:')) {
            const game = customId.slice('q:session_no:'.length);
            logger.info('Button: session no', { game, userId: interaction.user.id });
            await queueCmd.handleSessionNo(interaction, game);
          } else if (customId.startsWith('q:clear_all:')) {
            logger.info('Button: queue clear-all confirm', { customId, userId: interaction.user.id });
            await queueCmd.handleClearAllButton(interaction);
          } else if (customId.startsWith('q:host_fulfilled:')) {
            const game = customId.slice('q:host_fulfilled:'.length);
            logger.info('Button: host fulfilled', { game, userId: interaction.user.id });
            await queueCmd.handleHostFulfilled(interaction, game);
          } else if (customId.startsWith('q:host_extend:')) {
            const game = customId.slice('q:host_extend:'.length);
            logger.info('Button: host extend', { game, userId: interaction.user.id });
            await queueCmd.handleHostExtend(interaction, game);
          } else if (customId.startsWith('q:host_clear:')) {
            const game = customId.slice('q:host_clear:'.length);
            logger.info('Button: host clear', { game, userId: interaction.user.id });
            await queueCmd.handleHostClear(interaction, game);
          } else if (customId.startsWith('q:session_fill:')) {
            const game = customId.slice('q:session_fill:'.length);
            logger.info('Button: session fill', { game, userId: interaction.user.id });
            await queueCmd.handleSessionFill(interaction, game);
          } else if (customId.startsWith('q:sno_extend:')) {
            const game = customId.slice('q:sno_extend:'.length);
            logger.info('Button: session no extend', { game, userId: interaction.user.id });
            await queueCmd.handleSessionNoExtend(interaction, game);
          } else if (customId.startsWith('q:sno_newtime:')) {
            const game = customId.slice('q:sno_newtime:'.length);
            logger.info('Button: session no new time', { game, userId: interaction.user.id });
            await queueCmd.handleSessionNoNewTime(interaction, game);
          } else if (customId.startsWith('q:sno_close:')) {
            const game = customId.slice('q:sno_close:'.length);
            logger.info('Button: session no close', { game, userId: interaction.user.id });
            await queueCmd.handleSessionNoClose(interaction, game);
          }

        // Gambling buttons
        } else if (customId.startsWith('gam:')) {
          const betCmd = interaction.client.commands.get('th-bet');
          if (customId.startsWith('gam:accept:')) {
            const betId = customId.slice('gam:accept:'.length);
            logger.info('Button: bet accept', { betId, userId: interaction.user.id });
            await betCmd.handleAccept(interaction, betId);
          } else if (customId.startsWith('gam:decline:')) {
            const betId = customId.slice('gam:decline:'.length);
            logger.info('Button: bet decline', { betId, userId: interaction.user.id });
            await betCmd.handleDecline(interaction, betId);
          }

        // Restore buttons
        } else if (customId.startsWith('restore:')) {
          const restoreCmd = interaction.client.commands.get('th-restore');
          if (customId.startsWith('restore:yes:')) {
            const key = customId.slice('restore:yes:'.length);
            logger.info('Button: restore confirm', { key, userId: interaction.user.id });
            await restoreCmd.handleConfirmYes(interaction, key);
          } else if (customId === 'restore:no') {
            logger.info('Button: restore cancel', { userId: interaction.user.id });
            await restoreCmd.handleConfirmNo(interaction);
          }

        // List buttons
        } else if (customId.startsWith('l:')) {
          const listCmd = interaction.client.commands.get('th-list');
          if (customId === 'l:join') {
            logger.info('Button: list join', { userId: interaction.user.id });
            await listCmd.handleJoin(interaction);
          } else if (customId === 'l:leave') {
            logger.info('Button: list leave', { userId: interaction.user.id });
            await listCmd.handleLeave(interaction);
          } else if (customId === 'l:clear:yes') {
            logger.info('Button: list clear confirm', { userId: interaction.user.id });
            await listCmd.handleClearConfirm(interaction);
          } else if (customId === 'l:clear:no') {
            logger.info('Button: list clear cancel', { userId: interaction.user.id });
            await listCmd.handleClearCancel(interaction);
          } else if (customId.startsWith('l:rnd:rm:')) {
            const pickedUserId = customId.slice('l:rnd:rm:'.length);
            logger.info('Button: random remove', { pickedUserId, userId: interaction.user.id });
            const randomCmd = interaction.client.commands.get('th-random');
            await randomCmd.handleRemove(interaction, pickedUserId);
          } else if (customId === 'l:rnd:keep') {
            logger.info('Button: random keep', { userId: interaction.user.id });
            const randomCmd = interaction.client.commands.get('th-random');
            await randomCmd.handleKeep(interaction);
          }
        }
      } catch (err) {
        await safeError(interaction, err, 'Button interaction error');
      }
      return;
    }

    // ── Select menus ─────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      const { customId } = interaction;
      let handler = null;
      let logLabel = null;
      let cmd = null;

      // Queue select menus
      if (customId === 'q:join_select') {
        cmd = interaction.client.commands.get('th-queue');
        handler = cmd?.handleJoinSelect;
        logLabel = 'Select: queue join';
      } else if (customId === 'q:leave_select') {
        cmd = interaction.client.commands.get('th-queue');
        handler = cmd?.handleLeaveSelect;
        logLabel = 'Select: queue leave';
      } else if (customId === 'q:status_select') {
        cmd = interaction.client.commands.get('th-queue');
        handler = cmd?.handleStatusSelect;
        logLabel = 'Select: queue status';
      } else if (customId === 'q:clear_select') {
        cmd = interaction.client.commands.get('th-queue');
        handler = cmd?.handleClearSelect;
        logLabel = 'Select: queue clear';
      // Teams select menus
      } else if (customId === 't:split_select') {
        cmd = interaction.client.commands.get('th-teams');
        handler = cmd?.handleSplitSelect;
        logLabel = 'Select: teams split method';
      // Restore select menu
      } else if (customId === 'restore:select') {
        cmd = interaction.client.commands.get('th-restore');
        handler = cmd?.handleSelect;
        logLabel = 'Select: restore backup';
      }

      if (handler) {
        try {
          logger.info(logLabel, { customId, userId: interaction.user.id });
          await handler.call(cmd, interaction);
        } catch (err) {
          await safeError(interaction, err, 'Select interaction error');
        }
      }
      return;
    }

    // ── Modal submits ─────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const { customId } = interaction;
      try {
        if (customId === 't:size_modal') {
          logger.info('Modal: teams size', { userId: interaction.user.id });
          await interaction.client.commands.get('th-teams').handleSizeModal(interaction);
        } else if (customId === 't:count_modal') {
          logger.info('Modal: teams count', { userId: interaction.user.id });
          await interaction.client.commands.get('th-teams').handleCountModal(interaction);
        } else if (customId === 't:custom_modal') {
          logger.info('Modal: teams custom', { userId: interaction.user.id });
          await interaction.client.commands.get('th-teams').handleCustomModal(interaction);
        } else if (customId.startsWith('q:edit_modal:')) {
          const game = customId.slice('q:edit_modal:'.length);
          logger.info('Modal: queue edit', { game, userId: interaction.user.id });
          await interaction.client.commands.get('th-queue').handleEditModalSubmit(interaction, game);
        } else if (customId.startsWith('q:sno_modal:')) {
          const game = customId.slice('q:sno_modal:'.length);
          logger.info('Modal: session no new time', { game, userId: interaction.user.id });
          await interaction.client.commands.get('th-queue').handleSessionNoNewTimeSubmit(interaction, game);
        }
      } catch (err) {
        await safeError(interaction, err, 'Modal interaction error');
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
