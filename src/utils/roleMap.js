/**
 * Canonical emoji → role name mapping for the reaction role system.
 * `label` is the display text shown in the embed (not a role mention).
 * `role`  is the exact role name as it appears in the server.
 */
const EMOJI_ROLES = [
  { emoji: '🏀', label: 'Counter Strike',          role: 'NBA 2K'        },
  { emoji: '🏹', label: 'League of Legends ARAM',  role: "Curtis's QTE"  },
  { emoji: '🏈', label: 'Rainbow 6 Siege',         role: 'MADDEN NFL'    },
  { emoji: '🍁', label: 'Maplestory',              role: 'MapleStory'    },
  { emoji: '⛏️', label: 'Minecraft',               role: 'MC'            },
  { emoji: '🗡️', label: 'Monster Hunter',          role: 'MH'            },
  { emoji: '🔫', label: 'FPS',                     role: 'FPS'           },
  { emoji: '⚔️', label: 'MMO',                     role: 'MMO'           },
  { emoji: '💀', label: 'Souls',                   role: 'Souls'         },
  { emoji: '🔪', label: 'MW2 Michael Myers',       role: 'Michael Myers' },
  { emoji: '🎰', label: 'Gacha Games',             role: 'gacha'         },
  { emoji: '📺', label: 'Vtuber chat',             role: 'vtuber'        },
  { emoji: '🃏', label: 'Trading Card Games',      role: 'TCG'           },
];

const DEV_EMOJI_ROLES = [
  { emoji: '🧪', label: 'Tester', role: 'testers' },
];

const isDev = (process.env.NODE_ENV || 'development') === 'development';

/**
 * The active role map used at runtime — DEV_EMOJI_ROLES in development,
 * EMOJI_ROLES in production.
 */
const ACTIVE_ROLES = isDev ? DEV_EMOJI_ROLES : EMOJI_ROLES;

/**
 * Strips Unicode variation selectors (U+FE0F) so emoji like ⛏️ and ⛏
 * compare as equal regardless of how Discord normalises them.
 */
function normalizeEmoji(str) {
  return str.replace(/\uFE0F/g, '');
}

/**
 * Find the ACTIVE_ROLES entry whose emoji matches the given reaction emoji name.
 * Returns undefined if no match.
 */
function findRoleEntry(emojiName) {
  const norm = normalizeEmoji(emojiName);
  return ACTIVE_ROLES.find(e => normalizeEmoji(e.emoji) === norm);
}

module.exports = { EMOJI_ROLES, DEV_EMOJI_ROLES, ACTIVE_ROLES, normalizeEmoji, findRoleEntry };
