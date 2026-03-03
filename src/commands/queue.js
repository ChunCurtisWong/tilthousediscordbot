const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');
const { buildQueueEmbed } = require('../utils/embeds');

const DEFAULT_THRESHOLD = () => parseInt(process.env.QUEUE_PLAYER_THRESHOLD, 10) || 5;

/**
 * Fetches and edits the live queue message, or posts a new one if not found.
 * Returns the sent/edited message.
 */
async function upsertQueueMessage(interaction, game, queueData) {
  const embed = buildQueueEmbed(game, queueData);

  if (queueData.messageId && queueData.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(queueData.channelId);
      const msg = await ch.messages.fetch(queueData.messageId);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch {
      // Message was deleted or channel changed — fall through to posting new
    }
  }

  const msg = await interaction.channel.send({ embeds: [embed] });
  queueData.messageId = msg.id;
  queueData.channelId = interaction.channel.id;
  return msg;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Manage game queues')
    .addSubcommand(sub =>
      sub
        .setName('join')
        .setDescription('Join a game queue')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game name to queue for').setRequired(true)
        )
        .addIntegerOption(opt =>
          opt
            .setName('threshold')
            .setDescription('Players needed to fill the queue (default from config)')
            .setMinValue(2)
            .setMaxValue(20)
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('leave')
        .setDescription('Leave a game queue')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game name to leave').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show the current queue status for a game')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game name to check').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('clear')
        .setDescription('Clear a game queue (host or moderator only)')
        .addStringOption(opt =>
          opt.setName('game').setDescription('Game queue to clear').setRequired(true)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const game = interaction.options.getString('game').trim();
    const userId = interaction.user.id;
    const username = interaction.user.username;

    logger.info(`Command: /queue ${sub}`, { userId, username, game });

    // ── /queue join ─────────────────────────────────────────────────
    if (sub === 'join') {
      const threshold = interaction.options.getInteger('threshold') || DEFAULT_THRESHOLD();
      const queueData = storage.getQueue(game);

      if (queueData.players.find(p => p.userId === userId)) {
        return interaction.reply({
          content: `❌ You are already in the **${game}** queue.`,
          ephemeral: true,
        });
      }

      // Keep the threshold that was set when the queue was first created
      if (!queueData.threshold) queueData.threshold = threshold;
      queueData.players.push({ userId, username, joinedAt: Date.now() });

      await upsertQueueMessage(interaction, game, queueData);
      storage.saveQueue(game, queueData);

      const filled = queueData.players.length;
      const cap = queueData.threshold;

      logger.info('Player joined queue', { userId, game, filled, cap });

      await interaction.reply({
        content: `✅ You joined the **${game}** queue! (${filled}/${cap})`,
        ephemeral: true,
      });

      // ── Threshold reached — ping everyone and prompt host ─────────
      if (filled >= cap) {
        logger.info('Queue threshold reached', { game, filled, cap });

        const pingList = queueData.players.map(p => `<@${p.userId}>`).join(' ');
        const fullEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(`🎉 Queue Full: ${game}`)
          .setDescription(
            `The **${game}** queue is now full with **${filled}** players!\n\n` +
              `**Players:** ${pingList}\n\n` +
              `The host can now schedule a session:\n` +
              `\`/schedule ${game} <ISO time or Unix timestamp>\``
          )
          .setTimestamp();

        await interaction.channel.send({
          content: `${pingList}\n🎮 The **${game}** queue is full — time to play!`,
          embeds: [fullEmbed],
        });
      }
      return;
    }

    // ── /queue leave ────────────────────────────────────────────────
    if (sub === 'leave') {
      const queueData = storage.getQueue(game);
      const idx = queueData.players.findIndex(p => p.userId === userId);

      if (idx === -1) {
        return interaction.reply({
          content: `❌ You are not in the **${game}** queue.`,
          ephemeral: true,
        });
      }

      queueData.players.splice(idx, 1);
      await upsertQueueMessage(interaction, game, queueData);
      storage.saveQueue(game, queueData);

      logger.info('Player left queue', { userId, game, remaining: queueData.players.length });
      return interaction.reply({
        content: `✅ You left the **${game}** queue.`,
        ephemeral: true,
      });
    }

    // ── /queue status ───────────────────────────────────────────────
    if (sub === 'status') {
      const queueData = storage.getQueue(game);
      const embed = buildQueueEmbed(game, queueData);
      return interaction.reply({ embeds: [embed] });
    }

    // ── /queue clear ────────────────────────────────────────────────
    if (sub === 'clear') {
      const queueData = storage.getQueue(game);
      const isHost =
        queueData.players.length > 0 && queueData.players[0].userId === userId;
      const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      if (!isHost && !isMod) {
        return interaction.reply({
          content: '❌ Only the queue host or a moderator can clear the queue.',
          ephemeral: true,
        });
      }

      // Mark the live embed as cleared
      if (queueData.messageId && queueData.channelId) {
        try {
          const ch = await interaction.client.channels.fetch(queueData.channelId);
          const msg = await ch.messages.fetch(queueData.messageId);
          const clearedEmbed = new EmbedBuilder()
            .setColor('#FF6B6B')
            .setTitle(`🚫 Queue Cleared: ${game}`)
            .setDescription(`The **${game}** queue was cleared by <@${userId}>.`)
            .setTimestamp();
          await msg.edit({ embeds: [clearedEmbed] });
        } catch (err) {
          logger.warn('/queue clear: could not edit old queue embed', { error: err.message });
        }
      }

      storage.deleteQueue(game);
      logger.info('Queue cleared', { userId, game });

      return interaction.reply({
        content: `✅ The **${game}** queue has been cleared.`,
      });
    }
  },
};
