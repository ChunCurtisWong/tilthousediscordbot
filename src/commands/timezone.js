const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const storage = require('../utils/storage');

// Intl.supportedValuesOf is available in Node 18+; fall back to empty array
const ALL_TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

function validateTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('timezone')
    .setDescription('Manage your timezone settings')
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription('Set your timezone for schedule conversions')
        .addStringOption(opt =>
          opt
            .setName('timezone')
            .setDescription('IANA timezone name, e.g. America/New_York, Europe/London, Asia/Tokyo')
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('view')
        .setDescription('View your currently registered timezone')
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = ALL_TIMEZONES.filter(tz => tz.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(tz => ({ name: tz, value: tz }));
    await interaction.respond(choices);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.username;

    logger.info(`Command: /timezone ${sub}`, { userId, username });

    // ── /timezone set ───────────────────────────────────────────────
    if (sub === 'set') {
      const tz = interaction.options.getString('timezone');

      if (!validateTimezone(tz)) {
        logger.warn('Invalid timezone supplied', { userId, tz });
        return interaction.reply({
          content:
            `❌ \`${tz}\` is not a valid IANA timezone.\n` +
            'Try values like `America/New_York`, `Europe/London`, or `Asia/Tokyo`.',
          ephemeral: true,
        });
      }

      storage.setUserTimezone(userId, tz);
      logger.info('Timezone updated', { userId, tz });

      const localTime = new Date().toLocaleString('en-US', {
        timeZone: tz,
        dateStyle: 'full',
        timeStyle: 'short',
      });

      const embed = new EmbedBuilder()
        .setColor('#00FF7F')
        .setTitle('✅ Timezone Saved')
        .addFields(
          { name: 'Timezone', value: `\`${tz}\``, inline: true },
          { name: 'Your Current Time', value: localTime, inline: true }
        )
        .setFooter({ text: `Saved for ${username}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /timezone view ──────────────────────────────────────────────
    if (sub === 'view') {
      const tz = storage.getUserTimezone(userId);

      if (!tz) {
        return interaction.reply({
          content:
            "❌ You haven't set a timezone yet.\n" +
            'Use `/timezone set [timezone]` to register one.',
          ephemeral: true,
        });
      }

      const localTime = new Date().toLocaleString('en-US', {
        timeZone: tz,
        dateStyle: 'full',
        timeStyle: 'short',
      });

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🕐 Your Timezone')
        .addFields(
          { name: 'Timezone', value: `\`${tz}\``, inline: true },
          { name: 'Current Time', value: localTime, inline: true }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
