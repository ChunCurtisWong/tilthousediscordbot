const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const storage = require('../utils/storage');
const logger = require('../utils/logger');

// ─── Embed / component builders ──────────────────────────────────────────────

function buildListEmbed(listData) {
  const count = listData.players?.length ?? 0;
  const embed = new EmbedBuilder()
    .setColor('#00B0F4')
    .setTitle('📋 Active Player List')
    .setTimestamp();

  if (count === 0) {
    embed.setDescription('No players yet. Click **Join List** to add yourself!');
  } else {
    embed.setDescription(listData.players.map((p, i) => `${i + 1}. <@${p.userId}>`).join('\n'));
    embed.setFooter({ text: `${count} player${count !== 1 ? 's' : ''}` });
  }

  return embed;
}

function buildListComponents() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('l:join')
      .setLabel('Join List')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId('l:leave')
      .setLabel('Leave List')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );
}

/**
 * Refreshes the public list embed in the channel.
 * Used by external modules (random.js) to update the embed
 * without holding an interaction — only needs the client.
 */
async function refreshPublicEmbed(client, listData) {
  if (!listData?.messageId || !listData?.channelId) return;
  try {
    const ch = await client.channels.fetch(listData.channelId);
    const msg = await ch.messages.fetch(listData.messageId);
    await msg.edit({ embeds: [buildListEmbed(listData)], components: [buildListComponents()] });
  } catch {
    // Embed was deleted or channel inaccessible — safe to ignore
  }
}

/**
 * Sends or edits the list embed from an interaction context.
 * Button interactions use editReply (edits the message the button is on).
 * All other interactions (slash commands) use the stored messageId,
 * or send a new message to the channel if none exists.
 */
async function refreshListEmbed(interaction, listData) {
  const embed = buildListEmbed(listData);
  const components = [buildListComponents()];

  if (interaction.isButton()) {
    await interaction.editReply({ embeds: [embed], components });
    return;
  }

  if (listData.messageId && listData.channelId) {
    try {
      const ch = await interaction.client.channels.fetch(listData.channelId);
      const msg = await ch.messages.fetch(listData.messageId);
      await msg.edit({ embeds: [embed], components });
      return;
    } catch {
      // Stored message gone — fall through to send new
    }
  }

  const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);
  const msg = await channel.send({ embeds: [embed], components });
  listData.messageId = msg.id;
  listData.channelId = channel.id;
}

// ─── Command definition ──────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-list')
    .setDescription('Manage the active player list')
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription('Create a new player list')
        .addUserOption(opt => opt.setName('user1').setDescription('Pre-add a player').setRequired(false))
        .addUserOption(opt => opt.setName('user2').setDescription('Pre-add a player').setRequired(false))
        .addUserOption(opt => opt.setName('user3').setDescription('Pre-add a player').setRequired(false))
        .addUserOption(opt => opt.setName('user4').setDescription('Pre-add a player').setRequired(false))
        .addUserOption(opt => opt.setName('user5').setDescription('Pre-add a player').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add a user to the active list')
        .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('clear')
        .setDescription('Clear the active list (host or moderator only)')
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Show the current active list')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.username;

    logger.info(`Command: /th-list ${sub}`, { userId, username });

    // ── /th-list create ──────────────────────────────────────────────
    if (sub === 'create') {
      const existing = storage.getList();
      if (existing) {
        return interaction.reply({
          content: `❌ There is already an active list (created by <@${existing.hostId}>). Use \`/th-list clear\` to remove it first.`,
          flags: 64,
        });
      }

      // Collect optional pre-populated users (skip bots and duplicates)
      const players = [];
      for (let i = 1; i <= 5; i++) {
        const user = interaction.options.getUser(`user${i}`);
        if (user && !user.bot && !players.find(p => p.userId === user.id)) {
          players.push({ userId: user.id, username: user.username, joinedAt: Date.now() });
        }
      }

      const listData = { players, hostId: userId, messageId: null, channelId: null };
      storage.saveList(listData);

      await interaction.deferReply({ flags: 64 });
      await refreshListEmbed(interaction, listData);
      storage.saveList(listData); // persist messageId + channelId

      const added = players.length;
      return interaction.editReply({
        content: `✅ List created!${added > 0 ? ` Added ${added} player${added !== 1 ? 's' : ''}.` : ''}`,
      });
    }

    // ── /th-list add ─────────────────────────────────────────────────
    if (sub === 'add') {
      const listData = storage.getList();
      if (!listData) {
        return interaction.reply({
          content: '❌ No active list. Use `/th-list create` to start one.',
          flags: 64,
        });
      }

      const user = interaction.options.getUser('user');
      if (user.bot) {
        return interaction.reply({ content: '❌ Cannot add bots to the list.', flags: 64 });
      }
      if (listData.players.find(p => p.userId === user.id)) {
        return interaction.reply({ content: `❌ <@${user.id}> is already in the list.`, flags: 64 });
      }

      listData.players.push({ userId: user.id, username: user.username, joinedAt: Date.now() });
      storage.saveList(listData);

      await interaction.deferReply({ flags: 64 });
      await refreshListEmbed(interaction, listData);
      return interaction.editReply({ content: `✅ Added <@${user.id}> to the list.` });
    }

    // ── /th-list clear ────────────────────────────────────────────────
    if (sub === 'clear') {
      const listData = storage.getList();
      if (!listData) {
        return interaction.reply({ content: '❌ No active list to clear.', flags: 64 });
      }

      const isHost = listData.hostId === userId;
      const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
      if (!isHost && !isMod) {
        return interaction.reply({
          content: '❌ Only the list host or a moderator can clear the list.',
          flags: 64,
        });
      }

      const n = listData.players.length;
      return interaction.reply({
        content: `⚠️ Are you sure you want to clear the active list (${n} player${n !== 1 ? 's' : ''})?`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('l:clear:yes')
            .setLabel('Yes, clear it')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️'),
          new ButtonBuilder()
            .setCustomId('l:clear:no')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('✖️'),
        )],
        flags: 64,
      });
    }

    // ── /th-list status ───────────────────────────────────────────────
    if (sub === 'status') {
      const listData = storage.getList();
      if (!listData) {
        return interaction.reply({ content: '❌ There is no active list at the moment.', flags: 64 });
      }
      return interaction.reply({
        embeds: [buildListEmbed(listData)],
        components: [buildListComponents()],
        flags: 64,
      });
    }
  },

  // ── Button: Join List ─────────────────────────────────────────────────────
  async handleJoin(interaction) {
    await interaction.deferUpdate();
    const { id: userId, username } = interaction.user;
    const listData = storage.getList();

    if (!listData) {
      return interaction.followUp({ content: '❌ No active list.', flags: 64 });
    }
    if (listData.players.find(p => p.userId === userId)) {
      return interaction.followUp({ content: '❌ You are already in the list.', flags: 64 });
    }

    listData.players.push({ userId, username, joinedAt: Date.now() });
    storage.saveList(listData);

    // editReply on a deferUpdate-ed button interaction edits the button's own message (the list embed)
    await interaction.editReply({ embeds: [buildListEmbed(listData)], components: [buildListComponents()] });
    return interaction.followUp({ content: '✅ You joined the list!', flags: 64 });
  },

  // ── Button: Leave List ────────────────────────────────────────────────────
  async handleLeave(interaction) {
    await interaction.deferUpdate();
    const { id: userId } = interaction.user;
    const listData = storage.getList();

    if (!listData) {
      return interaction.followUp({ content: '❌ No active list.', flags: 64 });
    }
    const idx = listData.players.findIndex(p => p.userId === userId);
    if (idx === -1) {
      return interaction.followUp({ content: '❌ You are not in the list.', flags: 64 });
    }

    listData.players.splice(idx, 1);
    storage.saveList(listData);
    await interaction.editReply({ embeds: [buildListEmbed(listData)], components: [buildListComponents()] });
    return interaction.followUp({ content: '✅ You left the list.', flags: 64 });
  },

  // ── Button: Confirm clear ─────────────────────────────────────────────────
  async handleClearConfirm(interaction) {
    await interaction.deferUpdate();
    const listData = storage.getList();

    // Edit the public list embed to show a cleared state
    if (listData?.messageId && listData?.channelId) {
      try {
        const ch = await interaction.client.channels.fetch(listData.channelId);
        const msg = await ch.messages.fetch(listData.messageId);
        await msg.edit({
          embeds: [
            new EmbedBuilder()
              .setColor('#FF6B6B')
              .setTitle('🚫 List Cleared')
              .setDescription(`The player list was cleared by <@${interaction.user.id}>.`)
              .setTimestamp(),
          ],
          components: [],
        });
      } catch { /* embed gone — ignore */ }
    }

    storage.deleteList();
    logger.info('List cleared', { userId: interaction.user.id });
    return interaction.editReply({ content: '✅ The list has been cleared.', components: [] });
  },

  // ── Button: Cancel clear ──────────────────────────────────────────────────
  async handleClearCancel(interaction) {
    return interaction.update({ content: '❌ Cancelled.', components: [] });
  },

  // Exported for use by random.js to update the embed without an interaction
  refreshPublicEmbed,
};
