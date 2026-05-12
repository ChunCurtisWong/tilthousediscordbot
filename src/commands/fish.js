const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

const FISH_COOLDOWN_MS   = 5_000;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// userId → session object (exported for /th-icebox)
const activeSessions = new Map();

// ─── Data tables ──────────────────────────────────────────────────────────────

const CASTS = {
  standard: {
    tier: 'Standard',
    cost: 20,
    lossChance: 0.05,
    items: [
      { emoji: '🪱', name: 'Bait', cost:  5 },
      { emoji: '🪝', name: 'Hook', cost: 10 },
      { emoji: '🎣', name: 'Rod',  cost: 25 },
    ],
    fish: [
      { emoji: '🐟', name: 'Common Fish',   weight: 56, reward:   10 },
      { emoji: '🐠', name: 'Tropical Fish', weight: 20, reward:   25 },
      { emoji: '🐡', name: 'Puffer Fish',   weight: 10, reward:   50 },
      { emoji: '🦈', name: 'Shark',         weight:  5, reward:  150 },
      { emoji: '🦑', name: 'Squid',         weight:  1, reward:  600 },
      { emoji: '🧦', name: 'Old Boot',      weight:  5, reward:    0 },
      { emoji: '💀', name: 'Skeleton Fish', weight:  3, reward:  -50 },
    ],
  },
  enhanced: {
    tier: 'Enhanced',
    cost: 40,
    lossChance: 0.08,
    items: [
      { emoji: '🪱', name: 'Bait', cost: 10 },
      { emoji: '🪝', name: 'Hook', cost: 20 },
      { emoji: '🎣', name: 'Rod',  cost: 50 },
    ],
    fish: [
      { emoji: '🐟', name: 'Common Fish',   weight: 33, reward:   10 },
      { emoji: '🐠', name: 'Tropical Fish', weight: 25, reward:   25 },
      { emoji: '🐡', name: 'Puffer Fish',   weight: 20, reward:   50 },
      { emoji: '🦈', name: 'Shark',         weight: 12, reward:  150 },
      { emoji: '🦑', name: 'Squid',         weight:  3, reward:  600 },
      { emoji: '🧦', name: 'Old Boot',      weight:  4, reward:    0 },
      { emoji: '💀', name: 'Skeleton Fish', weight:  3, reward:  -50 },
    ],
  },
  premium: {
    tier: 'Premium',
    cost: 65,
    lossChance: 0.12,
    items: [
      { emoji: '🪱', name: 'Bait', cost:  25 },
      { emoji: '🪝', name: 'Hook', cost:  50 },
      { emoji: '🎣', name: 'Rod',  cost: 150 },
    ],
    fish: [
      { emoji: '🐟', name: 'Common Fish',   weight: 15, reward:   10 },
      { emoji: '🐠', name: 'Tropical Fish', weight: 18, reward:   25 },
      { emoji: '🐡', name: 'Puffer Fish',   weight: 25, reward:   50 },
      { emoji: '🦈', name: 'Shark',         weight: 18, reward:  150 },
      { emoji: '🦑', name: 'Squid',         weight:  8, reward:  600 },
      { emoji: '🧦', name: 'Old Boot',      weight:  6, reward:    0 },
      { emoji: '💀', name: 'Skeleton Fish', weight: 10, reward:  -50 },
    ],
  },
};

const ITEM_MESSAGES = {
  Rod: [
    'Your rod snapped!',
    'A seagull took your rod 😭',
    'bro dropped their rod in the water 💀',
    'The current was too strong...lost the rod!',
    'Rod broke :(',
  ],
  Hook: [
    "Your line got tangled with another player's!",
    'The fish snatched your hook 😭',
    'A crab snipped your line and now you have no hook. 🦀',
    "You hooked bro's hoodie 💀",
    'The hook bent out of shape!',
    'Your hook got caught in between two rocks!',
  ],
  Bait: [
    'You reel up only seaweed but your bait is gone.',
    'You watched your bait fly off your hook as you casted.',
    'A seagull ate your bait!',
    'Bait stolen 😭',
    'Bait washed away.',
  ],
};

const CAST_ORDER = ['standard', 'enhanced', 'premium'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rollWeighted(table) {
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) return entry;
  }
  return table[table.length - 1];
}

// ─── Embed builders ───────────────────────────────────────────────────────────

const WAVE     = '🌊≋≋≋≋≋≋≋≋≋≋';
const ROD_DEEP = `🎣\n┃\n┃\n┃\n${WAVE}`;
const ROD_NEAR = `🎣\n┃\n${WAVE}`;

function phaseEmbed(phase, username, cast) {
  let desc;
  if (phase === 1)      desc = `🎣\n${WAVE}\n🎣 Casting line...`;
  else if (phase === 2) desc = `${ROD_NEAR}\n🎣 Line is in the water...`;
  else                  desc = `${ROD_DEEP}\n🪝\n💦\n🎣 Something's biting...`;
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`${username}'s Cast (${cast.tier})`)
    .setDescription(desc);
}

function buildResultEmbed(cast, result, username) {
  const title    = `${username}'s Cast (${cast.tier})`;
  const castLine = `Cast: **-${cast.cost} 🪙**`;

  if (result.type === 'loss') {
    return new EmbedBuilder()
      .setColor('#FF4444')
      .setTitle(title)
      .setDescription(`${ROD_NEAR}\n❌`)
      .addFields({ name: castLine, value: `${result.msg}\nReplacement: **-${result.item.cost} 🪙**` });
  }

  const { fish } = result;

  if (fish.name === 'Old Boot') {
    return new EmbedBuilder()
      .setColor('#808080')
      .setTitle(title)
      .setDescription(`${ROD_DEEP}\n🪝\n🧦`)
      .addFields({ name: castLine, value: 'Just an old boot...\nEarned: **+0 🪙**' });
  }

  let color;
  if (fish.name === 'Shark' || fish.name === 'Squid') color = '#FFD700';
  else if (fish.reward > 0)                           color = '#00CC66';
  else                                                color = '#FF4444';

  const rewardLine = fish.reward > 0
    ? `You caught a ${fish.name}!\nEarned: **+${fish.reward} 🪙**`
    : `You caught a ${fish.name}!\nLost: **${fish.reward} 🪙**`;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`${ROD_DEEP}\n🪝\n${fish.emoji}`)
    .addFields({ name: castLine, value: rewardLine });
}

function gameButtons(userId, recastDisabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`fc:recast:${userId}`)
      .setLabel('Recast')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(recastDisabled),
    new ButtonBuilder()
      .setCustomId(`fc:changebait:${userId}`)
      .setLabel('Change Bait')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`fc:home:${userId}`)
      .setLabel('Go Home')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildSummaryEmbed(session) {
  const { castsByType, itemLosses, fishLog, spent, earned } = session;
  const net    = earned - spent;
  const color  = net > 0 ? '#00CC66' : net < 0 ? '#FF4444' : '#808080';
  const netStr = net > 0 ? `+${net}` : `${net}`;

  const castLines = [];
  for (const key of CAST_ORDER) {
    const count = castsByType[key] ?? 0;
    if (count > 0) {
      const totalCost = count * CASTS[key].cost;
      castLines.push(`• ${CASTS[key].tier} ×${count} (-${totalCost} 🪙)`);
    }
  }

  const fishLines = [];
  for (const [name, entry] of fishLog) {
    fishLines.push(`${entry.emoji} ${name} ×${entry.count}`);
  }

  let desc = '';
  if (castLines.length > 0) desc += `**Casts by type:**\n${castLines.join('\n')}\n\n`;
  if (itemLosses.length > 0) {
    const lossLines = itemLosses.map(l => `• ${l.emoji} ${l.msg} — **-${l.cost} 🪙**`);
    desc += `**Item Losses:**\n${lossLines.join('\n')}\n\n`;
  }
  if (fishLines.length > 0) desc += `**Fish caught:**\n${fishLines.join('\n')}\n\n`;
  desc += `Trinkets spent: **${spent} 🪙**\nTrinkets earned: **${earned} 🪙**\nNet: **${netStr} 🪙**`;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle('🎣 Session Summary')
    .setDescription(desc);
}

function startSessionTimeout(session, userId) {
  clearTimeout(session.timeout);
  session.timeout = setTimeout(async () => {
    if (!activeSessions.has(userId)) return;
    activeSessions.delete(userId);
    cleanupIceboxMessages(session);
    try { await session.message.edit({ embeds: [buildSummaryEmbed(session)], components: [] }); }
    catch { /* ignore */ }
  }, SESSION_TIMEOUT_MS);
}

function newSession(cast, castKey, message) {
  return {
    cast,
    castKey,
    castsByType: { standard: 0, enhanced: 0, premium: 0 },
    fishLog: new Map(),    // fishName → { emoji, count, totalReward }
    itemLosses: [],        // { emoji, msg, cost }
    iceboxMessages: [],    // Message refs to delete when session ends
    spent: 0,
    earned: 0,
    timeout: null,
    message,
  };
}

function cleanupIceboxMessages(session) {
  for (const msg of session.iceboxMessages) {
    msg.delete().catch(() => {});
  }
}

// ─── Shared cast logic ────────────────────────────────────────────────────────

async function runCast({ userId, username, cast, castKey, message, session }) {
  // Phase 1
  await message.edit({ embeds: [phaseEmbed(1, username, cast)], components: [] });

  // Deduct cost, set cooldown, update session spend
  await addTrinkets(userId, -cast.cost, username);
  await setCooldown(userId, 'fish');
  session.castsByType[castKey] = (session.castsByType[castKey] ?? 0) + 1;
  session.spent += cast.cost;

  // Determine outcome
  let result;
  if (Math.random() < cast.lossChance) {
    const item = pick(cast.items);
    const msg  = pick(ITEM_MESSAGES[item.name]);
    await addTrinkets(userId, -item.cost);
    session.spent += item.cost;
    session.itemLosses.push({ emoji: item.emoji, msg, cost: item.cost });
    result = { type: 'loss', item, msg };
  } else {
    const fish = rollWeighted(cast.fish);
    if (fish.reward !== 0) await addTrinkets(userId, fish.reward);

    // Update fish log
    if (!session.fishLog.has(fish.name)) {
      session.fishLog.set(fish.name, { emoji: fish.emoji, count: 0, totalReward: 0 });
    }
    const entry = session.fishLog.get(fish.name);
    entry.count++;
    entry.totalReward += fish.reward;

    if (fish.reward > 0)      session.earned += fish.reward;
    else if (fish.reward < 0) session.spent  += Math.abs(fish.reward);

    result = { type: 'catch', fish };
  }

  logger.info('Fish result', {
    userId,
    cast: castKey,
    type: result.type,
    name: result.type === 'loss' ? result.item.name : result.fish.name,
    reward: result.type === 'loss' ? -result.item.cost : result.fish.reward,
  });

  // Phases 2 → 3 → result
  await delay(1500);
  await message.edit({ embeds: [phaseEmbed(2, username, cast)], components: [] });

  await delay(1500);
  await message.edit({ embeds: [phaseEmbed(3, username, cast)], components: [] });

  await delay(1000);
  await message.edit({ embeds: [buildResultEmbed(cast, result, username)], components: [gameButtons(userId)] });
}

// ─── Command ──────────────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-fish')
    .setDescription('Cast your line and try your luck fishing for Trinkets!')
    .addStringOption(opt =>
      opt
        .setName('cast')
        .setDescription('Choose your cast type')
        .setRequired(true)
        .addChoices(
          { name: 'Standard Cast (-20 Trinkets)', value: 'standard' },
          { name: 'Enhanced Cast (-40 Trinkets)', value: 'enhanced' },
          { name: 'Premium Cast (-65 Trinkets)',  value: 'premium'  }
        )
    ),

  async execute(interaction) {
    const userId   = interaction.user.id;
    const username = interaction.user.username;
    const castKey  = interaction.options.getString('cast');
    const cast     = CASTS[castKey];

    // Cooldown
    const remaining = checkCooldown(userId, 'fish', FISH_COOLDOWN_MS);
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      await interaction.reply({ content: `⏳ Wait **${secs}s** before casting again.`, flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // Balance check
    const balance = getPlayer(userId).balance ?? 0;
    if (balance < cast.cost) {
      await interaction.reply({
        content: `❌ You don't have enough Trinkets to cast.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // End any existing session cleanly
    const prev = activeSessions.get(userId);
    if (prev) {
      clearTimeout(prev.timeout);
      activeSessions.delete(userId);
      cleanupIceboxMessages(prev);
      try { await prev.message.edit({ embeds: [buildSummaryEmbed(prev)], components: [] }); } catch { /* ignore */ }
    }

    await interaction.reply({ embeds: [phaseEmbed(1, username, cast)], components: [] });
    const message = await interaction.fetchReply();

    const session = newSession(cast, castKey, message);
    activeSessions.set(userId, session);

    await runCast({ userId, username, cast, castKey, message, session });
    startSessionTimeout(session, userId);
  },

  // ─── Button: Recast ────────────────────────────────────────────────────────

  async handleRecast(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    const { cast, castKey, message } = session;
    const username = interaction.user.username;

    // Cooldown — leave buttons enabled
    const remaining = checkCooldown(userId, 'fish', FISH_COOLDOWN_MS);
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      await interaction.reply({ content: `⏳ Wait **${secs}s** before casting again.`, flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // Balance — disable Recast, keep Go Home
    const balance = getPlayer(userId).balance ?? 0;
    if (balance < cast.cost) {
      await interaction.update({ embeds: message.embeds, components: [gameButtons(userId, true)] });
      const msg = await interaction.followUp({
        content: `❌ You don't have enough Trinkets to cast.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => msg.delete().catch(() => {}), 15_000);
      return;
    }

    await interaction.deferUpdate();
    startSessionTimeout(session, userId);

    await runCast({ userId, username, cast, castKey, message, session });
  },

  // ─── Button: Go Home ───────────────────────────────────────────────────────

  async handleGoHome(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    clearTimeout(session.timeout);
    activeSessions.delete(userId);
    cleanupIceboxMessages(session);

    await interaction.update({ embeds: [buildSummaryEmbed(session)], components: [] });
  },

  // ─── Button: Change Bait ───────────────────────────────────────────────────

  async handleChangeBait(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = activeSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    const select = new StringSelectMenuBuilder()
      .setCustomId('fc:bait_select')
      .setPlaceholder('Choose a cast type')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('Standard Cast (-20 Trinkets)')
          .setValue('standard')
          .setDefault(session.castKey === 'standard'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Enhanced Cast (-40 Trinkets)')
          .setValue('enhanced')
          .setDefault(session.castKey === 'enhanced'),
        new StringSelectMenuOptionBuilder()
          .setLabel('Premium Cast (-65 Trinkets)')
          .setValue('premium')
          .setDefault(session.castKey === 'premium'),
      );

    await interaction.reply({
      content: 'Select a cast type for your next cast:',
      components: [new ActionRowBuilder().addComponents(select)],
      flags: 64,
    });
  },

  // ─── Select: Bait select ───────────────────────────────────────────────────

  async handleBaitSelect(interaction) {
    const userId  = interaction.user.id;
    const session = activeSessions.get(userId);

    if (!session) {
      await interaction.reply({ content: '❌ No active fishing session found.', flags: 64 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    const newCastKey = interaction.values[0];
    const newCast    = CASTS[newCastKey];

    const balance = getPlayer(userId).balance ?? 0;
    if (balance < newCast.cost) {
      await interaction.update({
        content: `❌ You don't have enough Trinkets for a ${newCast.tier} Cast.\nYour balance: **${balance} 🪙**`,
        components: [],
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    session.cast    = newCast;
    session.castKey = newCastKey;

    await interaction.update({ content: `✅ Bait changed to **${newCast.tier} Cast** (-${newCast.cost} 🪙)!`, components: [] });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
  },

  // Exported for /th-icebox
  buildSummaryEmbed,
  getSession: userId => activeSessions.get(userId),
};
