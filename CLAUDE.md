# Claude Code Instructions

## IMPORTANT — Git Workflow
- ALWAYS push directly to main
- NEVER create new branches under any circumstances
- NEVER use claude/ prefix for branches
- NEVER open pull requests
- If you are about to create a branch, stop and push to main instead
- The command to push is always: git push origin main

## Project Context
<<<<<<< HEAD
This is a personal Discord bot for a small friend 
group server. Solo developer, no code review needed.
=======

This is a personal Discord bot for a small friend group server. Solo developer, no code review process needed. All changes should go directly to main.

## Ephemeral Message Rule

All ephemeral messages must follow this rule without exception:

**Essential — stay until manually dismissed:**
- Error messages (anything starting with ❌)
- Balance checks (`/th-trinkets`)
- Command lists (`/th-commands`, `/th-admin`)
- `/th-health`, `/th-trinkets-guide`
- `/th-restore` dropdown
- Any message that contains interactive components the user must act on (dropdowns, confirmation dialogs)

**Non-essential — auto-delete after 15 seconds:**
- Confirmations that something was done successfully (queue cleared/created/joined/left, timezone set, item given, etc.)
- Balance reveals after gambling (coinflip, bet)
- Any one-off "✅ Done" message where the visual feedback is already visible elsewhere

**Implementation patterns:**
```js
// Essential — no change needed, just reply normally
interaction.reply({ content: '❌ Error.', flags: 64 });

// Non-essential — schedule deletion after reply
await interaction.reply({ content: '✅ Done.', flags: 64 });
setTimeout(() => interaction.deleteReply().catch(() => {}), 15_000);

// Non-essential followUp (when already deferred as button)
const msg = await interaction.followUp({ content: '✅ Done.', flags: 64 });
setTimeout(() => msg.delete().catch(() => {}), 15_000);

// Non-essential update() (direct button update, no deferUpdate)
await interaction.update({ content: '✅ Done.', components: [] });
setTimeout(() => interaction.message.delete().catch(() => {}), 15_000);
```
>>>>>>> origin/claude/fix-roles-fetch-timeout-jUbdT
