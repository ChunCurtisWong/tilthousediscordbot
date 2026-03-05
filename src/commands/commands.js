const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-commands')
    .setDescription('Show all available TiltHouse bot commands'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('TiltHouse Bot — Commands')
      .addFields(
        {
          name: '🎮 Queue Commands',
          value: [
            '`/th-queue create` — Create a new game queue',
            '`/th-queue join` — Join an existing active queue',
            '`/th-queue leave` — Leave a queue or fill list',
            '`/th-queue status` — View the status of a queue',
            '`/th-queue clear` — Clear a specific queue (host or mod)',
            '`/th-queue clear-all` — Clear all active queues (mod only)',
          ].join('\n'),
        },
        {
          name: '📋 List Commands',
          value: [
            '`/th-list create` — Create a new player list',
            '`/th-list add @user` — Add a user to the active list',
            '`/th-list clear` — Clear the active list (host or mod)',
            '`/th-list status` — View the current active list',
          ].join('\n'),
        },
        {
          name: '🎲 Random & Teams',
          value: [
            '`/th-random` — Pick a random player from the active list',
            '`/th-teams` — Split the active list into randomized teams',
          ].join('\n'),
        },
        {
          name: '🕐 Timezone',
          value: '`/th-timezone set` — Register your timezone for scheduled queue times',
        },
        {
          name: '🎲 Fun',
          value: [
            '`/th-roll` — Roll a dice (default 6 sides, up to 1000)',
          ].join('\n'),
        },
        {
          name: '🪙 Trinkets',
          value: [
            '`/th-daily` — Claim your daily Trinkets reward (streak bonuses!)',
            '`/th-trinkets` — View your Trinkets balance and streak',
            '`/th-leaderboard` — View the top 3 Trinket holders',
            '`/th-give @user amount` — (Admin) Give Trinkets to a user',
            '`/th-coinflip` — Flip a coin, optional bet amount and choice',
            '`/th-bet @user amount` — Challenge a user to a Trinket duel',
          ].join('\n'),
        },
      )
      .setFooter({ text: 'Only visible to you' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
