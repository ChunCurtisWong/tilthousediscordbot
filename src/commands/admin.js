const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('th-admin')
    .setDescription('(Admin) View all bot commands including admin commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Tilthouse Bot — All Commands')
      .setDescription(
        '**🎮 Queue Commands**\n' +
        '`/th-queue create` — Create a new game queue\n' +
        '`/th-queue join` — Join an existing active queue\n' +
        '`/th-queue leave` — Leave a queue or fill list\n' +
        '`/th-queue status` — View the status of a queue\n' +
        '`/th-queue clear` — Clear a specific queue\n' +
        '`/th-queue clear-all` — Clear all active queues\n\n' +
        '**📋 List Commands**\n' +
        '`/th-list create` — Create a new player list\n' +
        '`/th-list add @user` — Add a user to the active list\n' +
        '`/th-list clear` — Clear the active list\n' +
        '`/th-list status` — View the current active list\n\n' +
        '**🎲 Random & Teams**\n' +
        '`/th-random` — Pick a random player from the active list\n' +
        '`/th-teams` — Split the active list into randomized teams\n\n' +
        '**🕐 Timezone**\n' +
        '`/th-timezone set` — Register your timezone\n\n' +
        '**🎉 Fun**\n' +
        '`/th-coinflip` — Flip a coin, optional bet amount and choice\n' +
        '`/th-roll` — Roll a dice (default 6 sides)\n' +
        '`/th-slots amount` — Spin the slot machine, bet 10–500 Trinkets\n\n' +
        '**🌐 Server**\n' +
        '`/th-roles` — React to assign yourself a game role\n\n' +
        '**🪙 Trinkets**\n' +
        '`/th-daily` — Claim your daily Trinkets reward\n' +
        '`/th-trinkets` — View your Trinkets balance and streak\n' +
        '`/th-leaderboard` — View the top 3 Trinket holders\n' +
        '`/th-bet @user amount` — Challenge a user to a Trinket duel\n\n' +
        '**🔒 Admin Only**\n' +
        '`/th-give @user amount` — Give Trinkets to a user\n' +
        '`/th-restore` — Restore Trinket data from a backup\n' +
        '`/th-health` — Run a full system health check\n' +
        '`/th-roles` — Post the reaction role embed in #roles\n' +
        '`/th-admin` — View all commands including admin commands'
      );

    return interaction.reply({ embeds: [embed], flags: 64 });
  },
};