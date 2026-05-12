const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { getPlayer, addTrinkets, checkCooldown, setCooldown } = require('../utils/trinkets');
const logger = require('../utils/logger');

const FLIP_AGAIN_TIMEOUT_MS = 5 * 60 * 1000;

// In-memory state — cleared on bot restart (intentional)
// bet: number | null (null = free flip), choice: 'heads' | 'tails' | null
const flipAgainSessions = new Map(); // userId → { bet, choice, timeout, message }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function flipAgainRow(userId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cf:again:${userId}`)
      .setLabel('Flip Again')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

function setupSession(userId, bet, choice, message) {
  const prev = flipAgainSessions.get(userId);
  if (prev) clearTimeout(prev.timeout);

  const timeout = setTimeout(async () => {
    if (!flipAgainSessions.has(userId)) return;
    flipAgainSessions.delete(userId);
    try { await message.edit({ components: [flipAgainRow(userId, true)] }); } catch { /* ignore */ }
  }, FLIP_AGAIN_TIMEOUT_MS);

  flipAgainSessions.set(userId, { bet, choice, timeout, message });
}

function buildFlipEmbed(userId, bet, choice, isHeads, won) {
  const coinEmoji   = isHeads ? '🪙' : '🌑';
  const resultLabel = isHeads ? 'Heads' : 'Tails';

  if (bet === null) {
    return new EmbedBuilder()
      .setColor(isHeads ? '#FFD700' : '#C0C0C0')
      .setTitle(`${coinEmoji} ${resultLabel}!`)
      .setDescription(`The coin landed on **${resultLabel}**.`)
      .setTimestamp();
  }

  let description = `${coinEmoji} The coin landed on **${resultLabel}**!\n\n`;
  if (choice) description += `You picked **${choice === 'heads' ? 'Heads' : 'Tails'}** — `;
  description += won ? `**<@${userId}> won ${bet} 🪙!**` : `**<@${userId}> lost ${bet} 🪙!**`;

  return new EmbedBuilder()
    .setColor(won ? '#FFD700' : '#FF4444')
    .setTitle(won ? '🎉 Winner!' : '💀 Better luck next time!')
    .setDescription(description)
    .setTimestamp();
}

// ─── Command ──────────────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-coinflip')
    .setDescription('Flip a coin — optionally bet Trinkets on the result')
    .addStringOption(opt =>
      opt
        .setName('amount')
        .setDescription('Amount to bet (number or "all") — leave blank for a free flip')
    )
    .addStringOption(opt =>
      opt
        .setName('choice')
        .setDescription('Pick a side (optional, only applies when betting)')
        .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })
    ),

  async execute(interaction) {
    const userId    = interaction.user.id;
    const username  = interaction.user.username;
    const amountStr = interaction.options.getString('amount');
    const choice    = interaction.options.getString('choice');
    const betting   = amountStr !== null;

    const result  = Math.random() < 0.5 ? 'heads' : 'tails';
    const isHeads = result === 'heads';

    // ── Free flip ─────────────────────────────────────────────────────────────
    if (!betting) {
      const embed = buildFlipEmbed(userId, null, null, isHeads, null);
      await interaction.reply({ embeds: [embed], components: [flipAgainRow(userId)] });
      const message = await interaction.fetchReply();
      setupSession(userId, null, null, message);
      return;
    }

    // ── Betting flow ──────────────────────────────────────────────────────────

    // Cooldown
    const remaining = checkCooldown(userId, 'coinflip', 5_000);
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      return interaction.reply({
        content: `⏳ Wait **${secs}s** before placing another bet.`,
        flags: 64,
      });
    }

    const balance = getPlayer(userId).balance ?? 0;

    // Parse and validate bet
    let bet;
    if (amountStr.toLowerCase() === 'all') {
      bet = balance;
    } else {
      bet = parseInt(amountStr, 10);
      if (isNaN(bet) || bet <= 0) {
        return interaction.reply({ content: '❌ Enter a valid positive number or `all`.', flags: 64 });
      }
    }

    if (bet < 10) {
      return interaction.reply({ content: '❌ Minimum bet is **10 🪙**.', flags: 64 });
    }
    if (bet > balance) {
      await interaction.reply({
        content: `❌ You don't have enough Trinkets to place that bet.\nYour balance: **${balance} 🪙**`,
        flags: 64,
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
      return;
    }

    const won = choice !== null ? result === choice : isHeads;

    const newBalance = await addTrinkets(userId, won ? bet : -bet, username);
    await setCooldown(userId, 'coinflip');
    logger.info('Coinflip bet result', { userId, bet, choice, result, won, newBalance });

    const embed = buildFlipEmbed(userId, bet, choice, isHeads, won);
    await interaction.reply({ embeds: [embed], components: [flipAgainRow(userId)] });
    const message = await interaction.fetchReply();
    setupSession(userId, bet, choice, message);

    // Ephemeral balance reveal — auto-deletes after 15s
    const balMsg = await interaction.followUp({ content: `Your new balance: **${newBalance} 🪙**`, flags: 64 });
    setTimeout(() => balMsg.delete().catch(() => {}), 15_000);
  },

  // ─── Button: Flip Again ────────────────────────────────────────────────────

  async handleFlipAgain(interaction, userId) {
    if (interaction.user.id !== userId) return interaction.deferUpdate();

    const session = flipAgainSessions.get(userId);
    if (!session) return interaction.deferUpdate();

    const { bet, choice } = session;
    const username = interaction.user.username;

    // Betting-only checks
    if (bet !== null) {
      // Cooldown — leave old button enabled
      const remaining = checkCooldown(userId, 'coinflip', 5_000);
      if (remaining !== null) {
        const secs = Math.ceil(remaining / 1000);
        await interaction.reply({ content: `⏳ Wait **${secs}s** before placing another bet.`, flags: 64 });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);
        return;
      }

      // Balance — disable button and show error
      const balance = getPlayer(userId).balance ?? 0;
      if (balance < bet) {
        await interaction.update({ embeds: interaction.message.embeds, components: [flipAgainRow(userId, true)] });
        const msg = await interaction.followUp({
          content: `❌ You don't have enough Trinkets to place that bet.\nYour balance: **${balance} 🪙**`,
          flags: 64,
        });
        setTimeout(() => msg.delete().catch(() => {}), 15_000);
        return;
      }
    }

    // Disable Flip Again on old message, post result as new message
    await interaction.update({ embeds: interaction.message.embeds, components: [flipAgainRow(userId, true)] });

    const result  = Math.random() < 0.5 ? 'heads' : 'tails';
    const isHeads = result === 'heads';

    let newMsg;
    if (bet === null) {
      // Free flip
      newMsg = await interaction.followUp({
        embeds: [buildFlipEmbed(userId, null, null, isHeads, null)],
        components: [flipAgainRow(userId)],
      });
    } else {
      // Betting flip
      const won = choice !== null ? result === choice : isHeads;
      const newBalance = await addTrinkets(userId, won ? bet : -bet, username);
      await setCooldown(userId, 'coinflip');
      logger.info('Coinflip bet result (flip again)', { userId, bet, choice, result, won, newBalance });

      newMsg = await interaction.followUp({
        embeds: [buildFlipEmbed(userId, bet, choice, isHeads, won)],
        components: [flipAgainRow(userId)],
      });

      // Ephemeral balance reveal — auto-deletes after 15s
      const balMsg = await interaction.followUp({ content: `Your new balance: **${newBalance} 🪙**`, flags: 64 });
      setTimeout(() => balMsg.delete().catch(() => {}), 15_000);
    }

    setupSession(userId, bet, choice, newMsg);
  },
};
