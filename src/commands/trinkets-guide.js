const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-trinkets-guide')
    .setDescription('Learn how the Trinkets system works'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🪙 Trinkets Guide')
      .addFields(
        {
          name: '💰 What are Trinkets?',
          value:
            'Trinkets are the server currency for Tilthouse Bot. ' +
            'Earn them by playing games and showing up, then flex your wealth on the leaderboard — or gamble it all away. Your call.',
        },
        {
          name: '📈 How to Earn Trinkets',
          value: [
            '**`/th-daily` — Daily Claim**',
            'Claim once per day. Streak bonuses apply:',
            '> Day 1: **100 🪙**',
            '> Day 2: **150 🪙**',
            '> Day 3: **200 🪙**',
            '> Day 4: **250 🪙**',
            '> Day 5+: **300 🪙** (max)',
            'Missing a day resets your streak to 0. Resets daily at **7pm EST**.',
            '',
            '**🎮 Queue Participation**',
            'Earn **20 🪙** when a queue you joined naturally closes.',
            'Fill list players earn **5 🪙** on close.',
            'Queue Trinkets can only be earned once per day, resetting at **7pm EST**.',
          ].join('\n'),
        },
        {
          name: '🎰 How to Spend Trinkets',
          value: [
            '**`/th-coinflip amount`** — Bet Trinkets on a coin flip. Minimum bet: **10 🪙**.',
            '**`/th-bet @user amount`** — Challenge someone to a direct Trinket duel. Minimum bet: **10 🪙**.',
            '',
            '*More ways to spend Trinkets coming soon!*',
          ].join('\n'),
        },
        {
          name: '🔧 Useful Commands',
          value: [
            '`/th-trinkets` — Check your balance and streak',
            '`/th-leaderboard` — See the top 3 Trinket holders',
            '`/th-daily` — Claim your daily Trinkets',
          ].join('\n'),
        },
      )
      .setFooter({ text: 'Only visible to you' });

    return interaction.reply({ embeds: [embed], flags: 64 });
  },
};
