const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const storage = require('../utils/storage');
const logger = require('../utils/logger');

// ─── Team colors — one square emoji per team, cycling if >8 teams ─────────────

const TEAM_COLORS = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Fisher-Yates shuffle (returns a new array). */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Returns an array of team sizes that sum to `total`, distributed as evenly
 * as possible across `numTeams` teams.
 * e.g. evenSizes(13, 3) → [5, 4, 4]
 */
function evenSizes(total, numTeams) {
  const base = Math.floor(total / numTeams);
  const extra = total % numTeams;
  return Array.from({ length: numTeams }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Shuffle players and split them into teams of the given sizes. */
function assignTeams(players, sizes) {
  const shuffled = shuffle(players);
  const teams = [];
  let i = 0;
  for (const size of sizes) {
    teams.push(shuffled.slice(i, i + size));
    i += size;
  }
  return teams;
}

function buildTeamsEmbed(teams) {
  const total = teams.reduce((sum, t) => sum + t.length, 0);
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('⚔️ Teams')
    .setFooter({ text: `${total} players · ${teams.length} teams · Randomly assigned` })
    .setTimestamp();

  for (let i = 0; i < teams.length; i++) {
    const emoji = TEAM_COLORS[i % TEAM_COLORS.length];
    const team = teams[i];
    embed.addFields({
      name: `${emoji} Team ${i + 1} — ${team.length} player${team.length !== 1 ? 's' : ''}`,
      value: team.map((p, j) => `${j + 1}. <@${p.userId}>`).join('\n'),
      inline: false,
    });
  }

  return embed;
}

/** Validate and parse a custom sizes string like "2,5,3". Returns the array or null. */
function parseCustomSizes(raw) {
  const parts = raw.split(',').map(s => s.trim());
  const sizes = parts.map(Number);
  if (sizes.some(n => !Number.isInteger(n) || n < 1)) return null;
  return sizes;
}

/**
 * Core logic: build teams from the active list given an array of team sizes.
 * Posts the teams embed publicly. Used by all code paths (slash opts + modals).
 */
async function doTeams(interaction, sizes, isDeferred) {
  const listData = storage.getList();
  if (!listData || listData.players.length === 0) {
    const errPayload = { content: '❌ The active list is now empty.', flags: 64 };
    return isDeferred ? interaction.editReply(errPayload) : interaction.reply(errPayload);
  }

  const total = listData.players.length;
  const sum = sizes.reduce((a, b) => a + b, 0);

  if (sum !== total) {
    const errPayload = {
      content: `❌ Team sizes sum to **${sum}** but the list has **${total}** player${total !== 1 ? 's' : ''}. Adjust the numbers so they total ${total}.`,
      flags: 64,
    };
    return isDeferred ? interaction.editReply(errPayload) : interaction.reply(errPayload);
  }

  const teams = assignTeams(listData.players, sizes);
  const embed = buildTeamsEmbed(teams);
  logger.info('Teams assigned', { sizes, total, numTeams: teams.length });

  return isDeferred
    ? interaction.editReply({ embeds: [embed], components: [] })
    : interaction.reply({ embeds: [embed] });
}

// ─── Modals for the dropdown → modal path ────────────────────────────────────

function sizeModal() {
  return new ModalBuilder()
    .setCustomId('t:size_modal')
    .setTitle('Split by Team Size')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Players per team')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 5')
        .setRequired(true)
        .setMaxLength(3),
    ));
}

function countModal() {
  return new ModalBuilder()
    .setCustomId('t:count_modal')
    .setTitle('Split by Number of Teams')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Number of teams')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 3')
        .setRequired(true)
        .setMaxLength(3),
    ));
}

function customModal() {
  return new ModalBuilder()
    .setCustomId('t:custom_modal')
    .setTitle('Custom Team Sizes')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel('Team sizes (comma-separated)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 4,4,2')
        .setRequired(true)
        .setMaxLength(100),
    ));
}

// ─── Command definition ──────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-teams')
    .setDescription('Split the active list into randomized teams')
    .addIntegerOption(opt =>
      opt
        .setName('size')
        .setDescription('Players per team — bot calculates team count and distributes evenly')
        .setMinValue(1)
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt
        .setName('count')
        .setDescription('Number of teams — bot distributes players as evenly as possible')
        .setMinValue(2)
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt
        .setName('custom')
        .setDescription('Comma-separated team sizes, e.g. 2,5,3')
        .setRequired(false)
    ),

  async execute(interaction) {
    const listData = storage.getList();
    if (!listData || listData.players.length === 0) {
      return interaction.reply({
        content: '❌ The active list is empty or there is no active list.',
        flags: 64,
      });
    }

    const players = listData.players;
    const total = players.length;
    const sizeOpt   = interaction.options.getInteger('size');
    const countOpt  = interaction.options.getInteger('count');
    const customOpt = interaction.options.getString('custom');

    // ── custom ───────────────────────────────────────────────────────
    if (customOpt !== null) {
      const sizes = parseCustomSizes(customOpt);
      if (!sizes) {
        return interaction.reply({
          content: '❌ Custom sizes must be positive integers separated by commas (e.g. `2,5,3`).',
          flags: 64,
        });
      }
      return doTeams(interaction, sizes, false);
    }

    // ── by size ──────────────────────────────────────────────────────
    if (sizeOpt !== null) {
      const numTeams = Math.ceil(total / sizeOpt);
      return doTeams(interaction, evenSizes(total, numTeams), false);
    }

    // ── by count ─────────────────────────────────────────────────────
    if (countOpt !== null) {
      const numTeams = Math.min(countOpt, total); // cap: can't have more teams than players
      return doTeams(interaction, evenSizes(total, numTeams), false);
    }

    // ── no option: show split method dropdown ─────────────────────────
    const select = new StringSelectMenuBuilder()
      .setCustomId('t:split_select')
      .setPlaceholder('Choose how to split…')
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel('By team size')
          .setValue('size')
          .setDescription('Set how many players per team'),
        new StringSelectMenuOptionBuilder()
          .setLabel('By number of teams')
          .setValue('count')
          .setDescription('Set how many teams to create'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Custom')
          .setValue('custom')
          .setDescription('Manually define each team\'s size'),
      ]);

    return interaction.reply({
      content: `📋 **${total} player${total !== 1 ? 's' : ''}** in the list. How would you like to split them?`,
      components: [new ActionRowBuilder().addComponents(select)],
      flags: 64,
    });
  },

  // ── Split method dropdown → show the appropriate modal ────────────────────
  async handleSplitSelect(interaction) {
    const method = interaction.values[0];
    if (method === 'size')   return interaction.showModal(sizeModal());
    if (method === 'count')  return interaction.showModal(countModal());
    if (method === 'custom') return interaction.showModal(customModal());
  },

  // ── Size modal submitted ──────────────────────────────────────────────────
  async handleSizeModal(interaction) {
    const raw = interaction.fields.getTextInputValue('value').trim();
    const size = parseInt(raw, 10);
    if (isNaN(size) || size < 1) {
      return interaction.reply({ content: '❌ Players per team must be a positive number.', flags: 64 });
    }
    const listData = storage.getList();
    if (!listData || listData.players.length === 0) {
      return interaction.reply({ content: '❌ The active list is now empty.', flags: 64 });
    }
    const total = listData.players.length;
    const numTeams = Math.ceil(total / size);
    await interaction.deferReply();
    return doTeams(interaction, evenSizes(total, numTeams), true);
  },

  // ── Count modal submitted ─────────────────────────────────────────────────
  async handleCountModal(interaction) {
    const raw = interaction.fields.getTextInputValue('value').trim();
    const count = parseInt(raw, 10);
    if (isNaN(count) || count < 2) {
      return interaction.reply({ content: '❌ Number of teams must be at least 2.', flags: 64 });
    }
    const listData = storage.getList();
    if (!listData || listData.players.length === 0) {
      return interaction.reply({ content: '❌ The active list is now empty.', flags: 64 });
    }
    const total = listData.players.length;
    const numTeams = Math.min(count, total);
    await interaction.deferReply();
    return doTeams(interaction, evenSizes(total, numTeams), true);
  },

  // ── Custom modal submitted ────────────────────────────────────────────────
  async handleCustomModal(interaction) {
    const raw = interaction.fields.getTextInputValue('value').trim();
    const sizes = parseCustomSizes(raw);
    if (!sizes) {
      return interaction.reply({
        content: '❌ Custom sizes must be positive integers separated by commas (e.g. `2,5,3`).',
        flags: 64,
      });
    }
    await interaction.deferReply();
    return doTeams(interaction, sizes, true);
  },
};
