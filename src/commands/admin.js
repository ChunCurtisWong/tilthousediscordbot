const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-admin')
    .setDescription('Show all Tilthouse bot commands including admin-only commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Tilthouse Bot — All Commands')
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
            '`/th-coinflip` — Flip a coin, optional bet amount and choice',
          ].join('\n'),
        },
        {
          name: '🌐 Server',
          value: '`/th-roles` — React to assign yourself a game role',
        },
        {
          name: '🪙 Trinkets',
          value: [
            '`/th-daily` — Claim your daily Trinkets reward (streak bonuses!)',
            '`/th-trinkets` — View your Trinkets balance and streak',
            '`/th-leaderboard` — View the top 3 Trinket holders',
            '`/th-bet @user amount` — Challenge a user to a Trinket duel',
            '`/th-trinkets-guide` — Learn about the Trinkets system',
          ].join('\n'),
        },
        {
          name: '🔒 Admin Only',
          value: [
            '`/th-give @user amount` — Give Trinkets to a user',
            '`/th-restore` — Restore Trinket data from a backup',
            '`/th-health` — Run a full system health check',
            '`/th-roles` — Post the reaction role embed in #roles',
            '`/th-admin` — View all commands including admin commands',
          ].join('\n'),
        },
      )
      .setFooter({ text: 'Only visible to you' });

    return interaction.reply({ embeds: [embed], flags: 64 });
  },
};
