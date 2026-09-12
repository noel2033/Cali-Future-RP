import { isCommandCategoryEnabled } from '../config/bot.js';
import { isCommandEnabled } from '../services/commandAccessService.js';

const FOLDER_META = {
  calculate: { commandName: 'calculate', category: 'Tools' },
  ticket: { commandName: 'ticket', category: 'Ticket' },
  ticketFeedback: { commandName: 'ticket', category: 'Ticket' },
  warnings: { commandName: 'warnings', category: 'Moderation' },
  todo: { commandName: 'todo', category: 'Utility' },
  config: { commandName: 'configwizard', category: 'Core' },
  counter: { commandName: 'serverstats', category: 'ServerStats' },
  music: { commandName: 'music', category: 'Music' },
  help: { commandName: 'help', category: 'Core' },
  giveaway: { commandName: 'gcreate', category: 'Giveaway' },
  countdown: { commandName: 'countdown', category: 'Tools' },
  wipedata: { commandName: 'wipedata', category: 'Utility' },
  logging: { commandName: 'logging', category: 'Logging' },
  verification: { commandName: 'verification', category: 'Verification' },
  reactionRoles: { commandName: 'reactroles', category: 'Reaction_roles' },
};

const CUSTOM_ID_META = {
  giveaway_join: { commandName: 'gcreate', category: 'Giveaway' },
  giveaway_view: { commandName: 'gcreate', category: 'Giveaway' },
  giveaway_end: { commandName: 'gend', category: 'Giveaway' },
  giveaway_reroll: { commandName: 'greroll', category: 'Giveaway' },
};

export function resolveComponentAccessMeta(folder, customId) {
  if (customId && CUSTOM_ID_META[customId]) {
    return { ...CUSTOM_ID_META[customId] };
  }

  if (folder && FOLDER_META[folder]) {
    return { ...FOLDER_META[folder] };
  }

  return null;
}

export function applyComponentAccessMeta(handler, folder, customId) {
  if (!handler || typeof handler !== 'object') {
    return handler;
  }

  const meta = resolveComponentAccessMeta(folder, customId || handler.name || handler.customId);
  if (!meta) {
    return handler;
  }

  handler.commandName = handler.commandName || meta.commandName;
  handler.category = handler.category || meta.category;
  return handler;
}

export async function isComponentAllowed(client, guildId, handler) {
  if (!handler?.commandName && !handler?.category) {
    return true;
  }

  if (handler.category && !isCommandCategoryEnabled(handler.category)) {
    return false;
  }

  if (!guildId) {
    return true;
  }

  return isCommandEnabled(client, guildId, handler.commandName || '', handler.category);
}
