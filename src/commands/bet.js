const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const {
  getPlayer,
  addTrinkets,
  checkCooldown,
  setCooldown,
  getPendingBet,
  savePendingBet,
  deletePendingBet,
} = require('../utils/trinkets');
const logger = require('../utils/logger');

const BET_EXPIRY_MS = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateBetId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function parseBet(amountStr, balance) {
  if (amountStr.toLowerCase() === 'all') return balance;
  const n = parseInt(amountStr, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

function buildChallengeEmbed(betData) {
  return new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('⚔️ Trinket Duel Challenge!')
    .setDescription(
      `<@${betData.challengerId}> has challenged <@${betData.targetId}> to a duel!\n\n` +
        `**Prize pool:** ${betData.amount * 2} 🪙 (${betData.amount} 🪙 each)\n\n` +
        `<@${betData.targetId}>, do you accept?`
    )
    .setFooter({ text: `Challenge expires in 60 seconds` })
    .setTimestamp();
}

function buildResultEmbed(winnerId, loserId, amount) {
  return new EmbedBuilder()
    .setColor('#00CC66')
    .setTitle('🏆 Duel Resolved!')
    .setDescription(
      `<@${winnerId}> won the duel against <@${loserId}>!\n\n` +
        `<@${winnerId}> gained **+${amount} 🪙**\n` +
        `<@${loserId}> lost **-${amount} 🪙**`
    )
    .setTimestamp();
}

function buildDeclinedEmbed(challengerId, targetId) {
  return new EmbedBuilder()
    .setColor('#888888')
    .setTitle('❌ Challenge Declined')
    .setDescription(`<@${targetId}> declined the duel with <@${challengerId}>. No Trinkets lost.`)
    .setTimestamp();
}

function buildExpiredEmbed(challengerId, targetId) {
  return new EmbedBuilder()
    .setColor('#555555')
    .setTitle('⏰ Challenge Expired')
    .setDescription(
      `<@${targetId}> did not respond in time. The challenge from <@${challengerId}> has expired. No Trinkets lost.`
    )
    .setTimestamp();
}

function buildButtons(betId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gam:accept:${betId}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`gam:decline:${betId}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}

// ─── Slash command ────────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-bet')
    .setDescription('Challenge another player to a Trinket duel')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The player to challenge').setRequired(true)
    )
    .addStringOption(opt =>
      opt
        .setName('amount')
        .setDescription('Amount to bet (number or "all")')
        .setRequired(true)
    ),

  async execute(interaction) {
    const challenger = interaction.user;
    const target     = interaction.options.getUser('user');

    // ── Basic guards ──────────────────────────────────────────────────
    if (target.id === challenger.id) {
      return interaction.reply({ content: "❌ You can't challenge yourself.", ephemeral: true });
    }
    if (target.bot) {
      return interaction.reply({ content: "❌ You can't challenge a bot.", ephemeral: true });
    }

    // ── Cooldown ──────────────────────────────────────────────────────
    const remaining = checkCooldown(challenger.id, 'bet');
    if (remaining !== null) {
      const secs = Math.ceil(remaining / 1000);
      return interaction.reply({
        content: `⏳ Wait **${secs}s** before issuing another challenge.`,
        ephemeral: true,
      });
    }

    // ── Validate amount ───────────────────────────────────────────────
    const challengerPlayer = getPlayer(challenger.id);
    const challengerBal    = challengerPlayer.balance ?? 0;
    const amountStr        = interaction.options.getString('amount');
    const amount           = parseBet(amountStr, challengerBal);

    if (amount === null) {
      return interaction.reply({ content: '❌ Enter a valid positive number or `all`.', ephemeral: true });
    }
    if (amount < 10) {
      return interaction.reply({ content: '❌ Minimum bet is **10 🪙**.', ephemeral: true });
    }
    if (amount > challengerBal) {
      return interaction.reply({
        content: `❌ You only have **${challengerBal} 🪙** — you can't bet **${amount} 🪙**.`,
        ephemeral: true,
      });
    }

    // ── Store pending bet and post challenge ──────────────────────────
    const betId = generateBetId();
    const betData = {
      challengerId:   challenger.id,
      challengerName: challenger.username,
      targetId:       target.id,
      targetName:     target.username,
      amount,
      createdAt: Date.now(),
    };
    await savePendingBet(betId, betData);
    await setCooldown(challenger.id, 'bet');

    logger.info('Bet challenge posted', { betId, challengerId: challenger.id, targetId: target.id, amount });

    await interaction.reply({
      embeds: [buildChallengeEmbed(betData)],
      components: [buildButtons(betId)],
    });

    // ── 60-second expiry ──────────────────────────────────────────────
    setTimeout(async () => {
      const stillPending = getPendingBet(betId);
      if (!stillPending) return; // Already resolved
      await deletePendingBet(betId);
      logger.info('Bet expired', { betId });
      try {
        const msg = await interaction.fetchReply();
        await msg.edit({
          embeds: [buildExpiredEmbed(betData.challengerId, betData.targetId)],
          components: [buildButtons(betId, true)],
        });
      } catch (err) {
        logger.error('Failed to edit expired bet message', { betId, error: err.message });
      }
    }, BET_EXPIRY_MS);
  },

  // ─── Button: Accept ─────────────────────────────────────────────────

  async handleAccept(interaction, betId) {
    await interaction.deferUpdate();

    const betData = getPendingBet(betId);
    if (!betData) {
      return interaction.followUp({ content: '❌ This challenge no longer exists.', ephemeral: true });
    }

    // Only the target can accept
    if (interaction.user.id !== betData.targetId) {
      return interaction.followUp({ content: '❌ Only the challenged player can accept.', ephemeral: true });
    }

    // Expiry guard (belt-and-suspenders in case setTimeout hasn't fired yet)
    if (Date.now() - betData.createdAt > BET_EXPIRY_MS) {
      await deletePendingBet(betId);
      return interaction.editReply({
        embeds: [buildExpiredEmbed(betData.challengerId, betData.targetId)],
        components: [buildButtons(betId, true)],
      });
    }

    // Validate both players still have enough
    const challengerBal = getPlayer(betData.challengerId).balance ?? 0;
    const targetBal     = getPlayer(betData.targetId).balance ?? 0;

    if (challengerBal < betData.amount) {
      await deletePendingBet(betId);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor('#FF4444')
            .setTitle('❌ Challenge Cancelled')
            .setDescription(
              `<@${betData.challengerId}> no longer has enough 🪙 to cover the bet. Challenge cancelled.`
            ),
        ],
        components: [],
      });
    }
    if (targetBal < betData.amount) {
      return interaction.followUp({
        content: `❌ You need at least **${betData.amount} 🪙** to accept this challenge. You have **${targetBal} 🪙**.`,
        ephemeral: true,
      });
    }

    // ── Resolve the duel ──────────────────────────────────────────────
    await deletePendingBet(betId);

    const challengerWins = Math.random() < 0.5;
    const [winnerId, winnerName, loserId, loserName] = challengerWins
      ? [betData.challengerId, betData.challengerName, betData.targetId, betData.targetName]
      : [betData.targetId, betData.targetName, betData.challengerId, betData.challengerName];

    const winnerNewBal = await addTrinkets(winnerId, betData.amount, winnerName);
    const loserNewBal  = await addTrinkets(loserId, -betData.amount, loserName);

    logger.info('Bet resolved', { betId, winnerId, loserId, amount: betData.amount });

    // Public embed — shows outcome but not running balances
    await interaction.editReply({
      embeds: [buildResultEmbed(winnerId, loserId, betData.amount)],
      components: [buildButtons(betId, true)],
    });

    // Ephemeral balance reveal — only visible to the accepter (button interactor)
    const accepterNewBal = interaction.user.id === winnerId ? winnerNewBal : loserNewBal;
    await interaction.followUp({
      content: `Your new balance: **${accepterNewBal} 🪙**`,
      ephemeral: true,
    });
  },

  // ─── Button: Decline ────────────────────────────────────────────────

  async handleDecline(interaction, betId) {
    await interaction.deferUpdate();

    const betData = getPendingBet(betId);
    if (!betData) {
      return interaction.followUp({ content: '❌ This challenge no longer exists.', ephemeral: true });
    }

    if (interaction.user.id !== betData.targetId) {
      return interaction.followUp({ content: '❌ Only the challenged player can decline.', ephemeral: true });
    }

    await deletePendingBet(betId);
    logger.info('Bet declined', { betId, targetId: interaction.user.id });

    await interaction.editReply({
      embeds: [buildDeclinedEmbed(betData.challengerId, betData.targetId)],
      components: [buildButtons(betId, true)],
    });
  },
};
