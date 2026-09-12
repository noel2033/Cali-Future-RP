/**
 * Safe SlashCommandBuilder / component payload reads.
 * Discord.js toJSON() can throw on malformed builders; callers must not assume options is an array.
 */

export function getCommandJson(commandData) {
  if (commandData == null) {
    return null;
  }

  try {
    if (typeof commandData.toJSON === 'function') {
      return commandData.toJSON() ?? commandData;
    }
  } catch {
    return commandData;
  }

  return commandData;
}

export function getCommandOptions(commandJson) {
  if (!Array.isArray(commandJson?.options)) {
    return [];
  }

  return commandJson.options.filter((option) => option && typeof option === 'object');
}
