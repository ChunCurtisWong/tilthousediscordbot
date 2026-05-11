const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

const FISH_COOLDOWN_MS = 10_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
      { emoji: '🐟', name: 'Common Fish',   weight: 43, reward:    5 },
      { emoji: '🐠', name: 'Tropical Fish', weight: 24, reward:   15 },
      { emoji: '🐡', name: 'Puffer Fish',   weight: 14, reward:   30 },
      { emoji: '🦈', name: 'Shark',         weight:  7, reward:   75 },
      { emoji: '🦑', name: 'Squid',         weight:  4, reward:  150 },
      { emoji: '🧦', name: 'Old Boot',      weight:  3, reward:    0 },
      { emoji: '💀', name: 'Skeleton Fish', weight:  5, reward:  -15 },
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
      { emoji: '🐟', name: 'Common Fish',   weight: 33, reward:    8 },
      { emoji: '🐠', name: 'Tropical Fish', weight: 24, reward:   23 },
      { emoji: '🐡', name: 'Puffer Fish',   weight: 19, reward:   45 },
      { emoji: '🦈', name: 'Shark',         weight: 12, reward:  113 },
      { emoji: '🦑', name: 'Squid',         weight:  5, reward:  225 },
      { emoji: '🧦', name: 'Old Boot',      weight:  3, reward:    0 },
      { emoji: '💀', name: 'Skeleton Fish', weight:  4, reward:  -30 },
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
      { emoji: '🐟', name: 'Common Fish',   weight: 15, reward:   15 },
      { emoji: '🐠', name: 'Tropical Fish', weight: 23, reward:   45 },
      { emoji: '🐡', name: 'Puffer Fish',   weight: 25, reward:   90 },
      { emoji: '🦈', name: 'Shark',         weight: 13, reward:  225 },
      { emoji: '🦑', name: 'Squid',         weight:  6, reward:  450 },
      { emoji: '🧦', name: 'Old Boot',      weight:  5, reward:    0 },
      { emoji: '💀', name: 'Skeleton Fish', weight: 13, reward: -100 },
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

const WAVE      = '🌊≋≋≋≋≋≋≋≋≋≋';
const ROD_DEEP  = `🎣\n┃\n┃\n┃\n${WAVE}`;
const ROD_NEAR  = `🎣\n┃\n${WAVE}`;

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
  const title = `${username}'s Cast (${cast.tier})`;
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
  else if (fish.reward > 0) color = '#00CC66';
  else                      color = '#FF4444';

  const rewardLine = fish.reward > 0
    ? `You caught a ${fish.name}!\nEarned: **+${fish.reward} 🪙**`
    : `You caught a ${fish.name}!\nLost: **${fish.reward} 🪙**`;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`${ROD_DEEP}\n🪝\n${fish.emoji}`)
    .addFields({ name: castLine, value: rewardLine });
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

    // Balance check (cast cost only)
    const balance = getPlayer(userId).balance ?? 0;
    if (balance < cast.cost) {
      await interaction.reply({
        content: `❌ You don't have enough Trinkets to cast.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    // Phase 1 — send immediately
    await interaction.reply({ embeds: [phaseEmbed(1, username, cast)] });

    // Deduct cast cost and set cooldown right away
    await addTrinkets(userId, -cast.cost, username);
    await setCooldown(userId, 'fish');

    // Determine outcome
    let result;
    if (Math.random() < cast.lossChance) {
      const item = pick(cast.items);
      const msg  = pick(ITEM_MESSAGES[item.name]);
      await addTrinkets(userId, -item.cost);
      result = { type: 'loss', item, msg };
    } else {
      const fish = rollWeighted(cast.fish);
      if (fish.reward !== 0) await addTrinkets(userId, fish.reward);
      result = { type: 'catch', fish };
    }

    logger.info('Fish result', {
      userId,
      cast: castKey,
      type: result.type,
      name: result.type === 'loss' ? result.item.name : result.fish.name,
      reward: result.type === 'loss' ? -result.item.cost : result.fish.reward,
    });

    // Phase 2
    await delay(1500);
    await interaction.editReply({ embeds: [phaseEmbed(2, username, cast)] });

    // Phase 3
    await delay(1500);
    await interaction.editReply({ embeds: [phaseEmbed(3, username, cast)] });

    // Final result
    await delay(1000);
    await interaction.editReply({ embeds: [buildResultEmbed(cast, result, username)] });
  },
};
