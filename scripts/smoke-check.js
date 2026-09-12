/**
 * Offline sanity check for boot-critical modules.
 * Does not log into Discord or require a live bot token.
 */
import 'dotenv/config';
import { Client, Collection, EmbedBuilder, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import { createEmbed, formatDate, formatDuration, formatProgressBar, formatUser } from '../src/utils/embeds.js';
import { toDate, toEpochMs, toNonNegativeInt, toPgInt } from '../src/utils/database/timestamps.js';
import {
  getCommandDefaultPermissions,
  memberMeetsCommandPermissions,
  memberHasModerationCommandAccess,
  checkUserPermissions,
  checkModerationPermissions,
  isModerator,
  botHasPermission,
  hasPermission,
} from '../src/utils/permissionGuard.js';
import { loadCommands, reloadCommand, registerCommands } from '../src/handlers/loaders/commandLoader.js';
import loadEvents from '../src/handlers/loaders/events.js';
import loadInteractions from '../src/handlers/loaders/interactions.js';
import { initializeDatabase, getXpForLevel as dbGetXpForLevel, getLeaderboard as dbGetLeaderboard, getWelcomeConfig, getJoinToCreateConfig, formatChannelName, getApplication, getApplications, getGuildBirthdays, getEndedGiveaways, getColor as dbGetColor, getMessage } from '../src/utils/database.js';
import { getUserLevelKey, getEconomyKey, getGuildBirthdaysKey, getAFKKey } from '../src/utils/database/keys.js';
import { getXpForLevel, getLevelFromXp, getUserLevelData, getLeaderboard, MAX_LEVEL } from '../src/services/leveling/leveling.js';
import { createMockInteraction, resolveSlashAccessKey, resolvePrefixAccessKey, supportsPrefixExecution, executePrefixCommand } from '../src/utils/messageAdapter.js';
import { mapArgumentsToOptions } from '../src/utils/prefixParser.js';
import { getPrefixRestriction } from '../src/config/commands/prefixRestrictions.js';
import { isGiveawayEnded, saveGiveaway, deleteGiveaway, getGuildGiveaways } from '../src/utils/giveaways.js';
import { Mutex } from '../src/utils/mutex.js';
import { getBotPanelStatus } from '../src/utils/panelStatus.js';
import { hasDangerousPermissions } from '../src/services/reactionRoleService.js';
import ApplicationService from '../src/services/applicationService.js';
import { resolveComponentAccessMeta, isComponentAllowed } from '../src/utils/componentAccess.js';
import { buildCommandRegistry, isCommandEnabledInConfig } from '../src/services/commandAccessService.js';
import { getCommandJson, getCommandOptions } from '../src/utils/commandJson.js';
import { redactDatabaseSecrets, redactDatabaseUrl } from '../src/utils/database/redactUrl.js';
import { requireConfiguredPostgresUrl, resolveConfiguredPostgresUrl } from '../src/config/database/postgres.js';
import { getLavalinkNodes } from '../src/config/music/lavalink.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import ConfigService from '../src/services/config/configService.js';
import { validateLogChannel } from '../src/utils/ticket/ticketLogging.js';
import { logEvent, EVENT_TYPES as LOG_EVENT_TYPES } from '../src/services/loggingService.js';
import { ErrorTypes } from '../src/utils/errorHandler.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.error(`FAIL  ${message}`);
    return;
  }
  console.log(`PASS  ${message}`);
}

function mockMember({ owner = false, admin = false, permissions = 0n, roles = [] } = {}) {
  return {
    id: '111',
    guild: { ownerId: owner ? '111' : '999' },
    permissions: {
      has(required) {
        if (admin) {
          return true;
        }
        if (required == null) {
          return true;
        }
        const bits = typeof required === 'bigint' ? required : BigInt(required);
        if (bits === 0n) {
          return true;
        }
        return (permissions & bits) === bits;
      },
    },
    roles: {
      cache: {
        has(roleId) {
          return roles.includes(roleId);
        },
      },
    },
  };
}

async function checkTimestamps() {
  const iso = '2026-07-28T13:16:39.000Z';
  const date = new Date(iso);
  assert(toEpochMs(date) === date.getTime(), 'toEpochMs(Date) returns epoch ms');
  assert(toEpochMs(iso) === Date.parse(iso), 'toEpochMs(ISO string) parses instead of becoming 0');
  assert(toEpochMs('1753670199000') === 1753670199000, 'toEpochMs(numeric string) stays numeric');
  assert(toEpochMs(undefined, 0) === 0, 'toEpochMs(undefined) uses fallback 0');
  assert(toDate(0).getTime() === 0, 'toDate(0) is epoch, not "now"');
  assert(toDate(iso).toISOString() === iso, 'toDate(ISO string) round-trips');
  assert(toNonNegativeInt(2.9) === 2, 'toNonNegativeInt floors fractional XP/level values');
  assert(toNonNegativeInt('15') === 15, 'toNonNegativeInt parses numeric strings');
  assert(getXpForLevel(toNonNegativeInt(2.9) + 1) > 0, 'floored levels are valid for getXpForLevel');
  assert(toPgInt(3e15) === 2147483647, 'toPgInt clamps values that would overflow PostgreSQL INTEGER');
}

async function checkLevelCurve() {
  assert(getXpForLevel(0) === 50, 'getXpForLevel(0) matches XP curve');
  assert(getXpForLevel(1) === 105, 'getXpForLevel(1) matches XP curve');
  const capXp = getXpForLevel(MAX_LEVEL);
  let maxPlusOneThrew = false;
  let maxPlusOneValue;
  try {
    maxPlusOneValue = getXpForLevel(MAX_LEVEL + 1);
  } catch {
    maxPlusOneThrew = true;
  }
  assert(!maxPlusOneThrew, 'getXpForLevel(MAX_LEVEL + 1) does not throw for rank/xpSystem callers');
  assert(maxPlusOneValue === capXp, 'getXpForLevel above cap returns the cap XP threshold');
  assert(dbGetXpForLevel(MAX_LEVEL + 1) === capXp, 'database facade XP curve matches service cap');
  assert(getLevelFromXp('100').level >= 0, 'getLevelFromXp accepts numeric strings from storage');

  let negativeThrew = false;
  try {
    getXpForLevel(-1);
  } catch {
    negativeThrew = true;
  }
  assert(negativeThrew, 'getXpForLevel still rejects negative levels');
}

async function checkLevelStorage() {
  const iso = '2026-07-28T13:16:39.000Z';
  const mapped = await getUserLevelData(
    {
      db: {
        async get() {
          return {
            xp: '12',
            level: '3',
            total_xp: 200,
            last_message: iso,
            rank: 1,
          };
        },
      },
    },
    'guild-1',
    'user-1',
  );
  assert(mapped.xp === 12, 'getUserLevelData coerces string XP');
  assert(mapped.level === 3, 'getUserLevelData coerces string level');
  assert(mapped.totalXp === 200, 'getUserLevelData reads snake_case total_xp');
  assert(mapped.lastMessage === Date.parse(iso), 'getUserLevelData reads snake_case last_message as epoch ms');

  const nonObject = await getUserLevelData(
    {
      db: {
        async get() {
          return 'corrupt-row';
        },
      },
    },
    'guild-1',
    'user-2',
  );
  assert(nonObject.xp === 0 && nonObject.level === 0, 'getUserLevelData treats non-object rows as empty');

  const client = {
    guilds: {
      cache: {
        get() {
          return {
            members: {
              async fetch() {
                return new Map([
                  ['ok-user', { user: { bot: false, username: 'ok', discriminator: '0' } }],
                  ['bad-user', { user: { bot: false, username: 'bad', discriminator: '0' } }],
                ]);
              },
            },
          };
        },
      },
    },
    db: {
      async get(key) {
        if (String(key).includes('bad-user')) {
          throw new Error('row corrupted');
        }
        return { xp: 10, level: 1, totalXp: 100, lastMessage: 0, rank: 1 };
      },
    },
  };

  const rows = await getLeaderboard(client, 'guild-1', 10);
  assert(rows.length === 1, 'leaderboard skips users whose level rows fail to load');
  assert(rows[0].userId === 'ok-user', 'leaderboard keeps the successful user');

  const missingClient = await getLeaderboard(null, 'guild-1', 10);
  assert(Array.isArray(missingClient) && missingClient.length === 0, 'getLeaderboard returns [] when client is null');

  const facadeMissingClient = await dbGetLeaderboard(null, 'guild-1', 10);
  assert(Array.isArray(facadeMissingClient) && facadeMissingClient.length === 0, 'database facade getLeaderboard returns [] when client is null');
}

async function checkEmbeds() {
  const customFooter = 'Welcome to Cali Future RP';
  const embed = new EmbedBuilder()
    .setTitle('Preview')
    .setDescription('Body')
    .setFooter({ text: customFooter })
    .setTimestamp(new Date('2026-07-28T00:00:00.000Z'));

  const data = embed.toJSON();
  assert(data.footer?.text === customFooter, 'user footers are not dropped by embed sanitizer');
  assert(Boolean(data.timestamp), 'setTimestamp is no longer a no-op');

  const created = createEmbed({
    title: 'Notice',
    description: 'Hello',
    footer: 'Page 2 of 4',
    timestamp: true,
  });
  const createdData = created.toJSON();
  assert(createdData.footer?.text === 'Page 2 of 4', 'createEmbed keeps ordinary footers');
  assert(Boolean(createdData.timestamp), 'createEmbed({ timestamp: true }) sets a timestamp');

  let sanitizerThrew = false;
  try {
    new EmbedBuilder()
      .setTitle('🎉')
      .setDescription('🎉')
      .setFooter({ text: '🎉' })
      .addFields({ name: '🎉', value: '🎉' })
      .setAuthor('🎉');
  } catch {
    sanitizerThrew = true;
  }
  assert(!sanitizerThrew, 'emoji-only embed text does not throw after sanitization');

  let invalidTimestampThrew = false;
  try {
    createEmbed({ title: 'Notice', description: 'Hello', timestamp: new Date('not-a-date') });
  } catch {
    invalidTimestampThrew = true;
  }
  assert(!invalidTimestampThrew, 'invalid Date timestamp does not throw in createEmbed');
  assert(formatDate(new Date('not-a-date')) === 'Unknown', 'formatDate does not emit NaN timestamps');
  assert(formatProgressBar(0, 0).includes('0%'), 'formatProgressBar(0, 0) does not throw');
  assert(formatDuration(Number.NaN) === '0s', 'formatDuration(NaN) does not emit NaN units');

  let longTitleThrew = false;
  let clippedTitle;
  try {
    clippedTitle = new EmbedBuilder().setTitle('A'.repeat(300)).toJSON().title;
  } catch {
    longTitleThrew = true;
  }
  assert(!longTitleThrew, 'oversize embed titles are clipped instead of throwing');
  assert(clippedTitle?.length === 256, 'oversize embed titles are clipped to Discord 256-char limit');

  let invalidDirectTimestampThrew = false;
  try {
    new EmbedBuilder().setTimestamp(new Date('not-a-date'));
  } catch {
    invalidDirectTimestampThrew = true;
  }
  assert(!invalidDirectTimestampThrew, 'setTimestamp(Invalid Date) does not throw');
  assert(formatUser(null) === 'Unknown', 'formatUser(null) does not throw');

  let nullFooterThrew = false;
  try {
    new EmbedBuilder().setFooter(null);
  } catch {
    nullFooterThrew = true;
  }
  assert(!nullFooterThrew, 'setFooter(null) does not throw');
  const medalDescription = new EmbedBuilder().setDescription('🥇 <@1> - Level 10').toJSON().description;
  assert(medalDescription?.includes('🥇'), 'leaderboard medals are not stripped from embeds');
  const emojiTitle = new EmbedBuilder().setTitle('🎉').toJSON().title;
  assert(emojiTitle === '🎉', 'emoji-only embed titles are kept');
}

async function checkPermissions() {
  const zeroPermCommand = {
    toJSON() {
      return { default_member_permissions: '0' };
    },
  };
  assert(
    getCommandDefaultPermissions(zeroPermCommand) === 0n,
    'default_member_permissions "0" is admin-only, not unrestricted',
  );
  assert(
    getCommandDefaultPermissions({
      toJSON() {
        throw new Error('toJSON failed');
      },
    }) === 0n,
    'getCommandDefaultPermissions fails closed when toJSON throws',
  );

  const regular = mockMember({ permissions: PermissionFlagsBits.SendMessages });
  assert(
    memberMeetsCommandPermissions(regular, 0n) === false,
    'non-admin denied when default_member_permissions is 0',
  );
  assert(
    memberMeetsCommandPermissions(mockMember({ admin: true }), 0n) === true,
    'administrator allowed when default_member_permissions is 0',
  );
  assert(
    memberMeetsCommandPermissions(mockMember({ owner: true }), 0n) === true,
    'guild owner allowed when default_member_permissions is 0',
  );
  assert(
    memberHasModerationCommandAccess(regular, { modRole: 'mod' }, 0n) === false,
    'moderation access does not treat bitfield 0 as "everyone"',
  );
  assert(
    memberHasModerationCommandAccess(mockMember({ roles: ['mod'] }), { modRole: 'mod' }, 0n) === true,
    'configured modRole still grants moderation access',
  );
  assert(
    isModerator(mockMember({ permissions: PermissionFlagsBits.ManageGuild })) === true,
    'ManageGuild-only member counts as moderator',
  );

  const replies = [];
  const result = await checkUserPermissions(
    { member: null, user: { id: '1' }, commandName: 'leveladd', guildId: '2', reply: async (payload) => replies.push(payload) },
    PermissionFlagsBits.ManageGuild,
  );
  assert(result === false, 'checkUserPermissions denies when member is missing');
  const zeroBitfieldDenied = await checkUserPermissions(
    {
      member: mockMember({ permissions: PermissionFlagsBits.SendMessages }),
      user: { id: '1' },
      commandName: 'secret',
      guildId: '2',
      reply: async () => {},
    },
    0n,
  );
  assert(zeroBitfieldDenied === false, 'checkUserPermissions treats bitfield 0 as admin-only');
  const zeroBitfieldAdmin = await checkUserPermissions(
    {
      member: mockMember({ admin: true }),
      user: { id: '1' },
      commandName: 'secret',
      guildId: '2',
      reply: async () => {},
    },
    0n,
  );
  assert(zeroBitfieldAdmin === true, 'checkUserPermissions allows administrators when bitfield is 0');
  assert(
    botHasPermission({ guild: { members: { me: { id: 'bot' } } }, permissionsFor: () => null }, PermissionFlagsBits.SendMessages) === false,
    'botHasPermission is false when permissionsFor returns null',
  );
  assert(
    botHasPermission({
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({
        has() {
          throw new Error('invalid bitfield');
        },
      }),
    }, PermissionFlagsBits.SendMessages) === false,
    'botHasPermission fails closed when permissions.has throws',
  );
  assert(await checkUserPermissions(null, 0n) === false, 'checkUserPermissions denies a missing interaction');
  assert(await checkModerationPermissions(null, {}, 0n) === false, 'checkModerationPermissions denies a missing interaction');

  const throwingPerms = {
    id: '111',
    guild: { ownerId: '999' },
    permissions: {
      has() {
        throw new Error('invalid bitfield');
      },
    },
  };
  assert(
    memberMeetsCommandPermissions(throwingPerms, PermissionFlagsBits.SendMessages) === false,
    'memberMeetsCommandPermissions fails closed when permissions.has throws',
  );
  assert(isModerator(throwingPerms) === false, 'isModerator fails closed when permissions.has throws');
  assert(hasPermission(null, PermissionFlagsBits.ManageGuild) === false, 'hasPermission denies a missing member');
}

async function checkCommands() {
  const client = { commands: new Collection() };
  const commands = await loadCommands(client);
  assert(commands.size > 0, `command loader registered ${commands.size} commands`);

  const required = ['ban', 'kick', 'economy', 'daily', 'search', 'embedbuilder', 'configwizard', 'commands'];
  for (const name of required) {
    assert(commands.has(name), `command "${name}" loaded`);
  }

  const DISCORD_DESCRIPTION_MAX = 100;
  const overLimit = [];
  for (const command of commands.values()) {
    let json;
    try {
      json = command.data.toJSON();
    } catch {
      overLimit.push(`${command.data?.name || 'unknown'} (toJSON failed)`);
      continue;
    }
    if (json.description?.length > DISCORD_DESCRIPTION_MAX) {
      overLimit.push(`${json.name} (${json.description.length})`);
    }
    const options = Array.isArray(json.options) ? json.options : [];
    for (const option of options) {
      if (option?.description?.length > DISCORD_DESCRIPTION_MAX) {
        overLimit.push(`${json.name}.${option.name} (${option.description.length})`);
      }
    }
  }
  assert(overLimit.length === 0, overLimit.length ? `descriptions exceed Discord 100-char limit: ${overLimit.join(', ')}` : 'slash descriptions stay within Discord 100-char limit');

  const missingReload = await reloadCommand({}, 'ban');
  assert(missingReload.success === false, 'reloadCommand fails closed without a command collection');

  let registeredBody;
  const fakeClient = {
    commands: new Collection([
      ['okcmd', {
        data: {
          name: 'okcmd',
          toJSON() {
            return { name: 'okcmd', description: 'ok', choices: [null], options: [null] };
          },
        },
      }],
      ['objchoices', {
        data: {
          name: 'objchoices',
          toJSON() {
            return { name: 'objchoices', description: 'ok', choices: { not: 'array' } };
          },
        },
      }],
      ['badjson', {
        data: {
          name: 'badjson',
          toJSON() {
            throw new Error('toJSON failed');
          },
        },
      }],
    ]),
    rest: {
      async put(_url, { body }) {
        registeredBody = body;
        return body;
      },
    },
  };
  let registerThrew = false;
  try {
    await registerCommands(fakeClient, { clientId: '123' });
  } catch {
    registerThrew = true;
  }
  assert(!registerThrew, 'registerCommands does not throw on null choices/options or toJSON failures');
  assert(Array.isArray(registeredBody) && registeredBody.some((cmd) => cmd.name === 'okcmd'), 'registerCommands still registers valid commands');
  assert(registeredBody.some((cmd) => cmd.name === 'objchoices'), 'registerCommands treats non-array choices as empty');
  assert(!registeredBody.some((cmd) => cmd.name === 'badjson'), 'registerCommands skips commands whose toJSON throws');
}

async function checkHandlers() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.events = new Collection();
  client.buttons = new Collection();
  client.selectMenus = new Collection();
  client.modals = new Collection();

  try {
    await loadEvents(client);
    await loadInteractions(client);

    assert(client.eventNames().includes('interactionCreate'), 'interactionCreate event registered');
    assert(client.eventNames().includes('messageCreate'), 'messageCreate event registered');
    assert(client.buttons.size > 0, `loaded ${client.buttons.size} button handlers`);
    assert(client.selectMenus.size > 0, `loaded ${client.selectMenus.size} select menu handlers`);
    assert(client.modals.size > 0, `loaded ${client.modals.size} modal handlers`);
    assert(client.buttons.get('create_ticket')?.commandName === 'ticket', 'loaded ticket buttons carry parent command access metadata');
    assert(client.buttons.get('giveaway_end')?.commandName === 'gend', 'loaded giveaway_end buttons carry gend access metadata');
    assert(client.selectMenus.get('reaction_roles')?.commandName === 'reactroles', 'loaded reaction role menus carry reactroles access metadata');
  } finally {
    await client.destroy();
  }
}

async function checkPrefixAdapter() {
  const channelId = '99';
  const fakeMessage = {
    author: { id: '1' },
    member: { id: '1', permissions: { has: () => true } },
    channel: { id: 'c' },
    guild: {
      id: 'g',
      members: { cache: { get: () => null } },
      channels: {
        cache: { get: (id) => (id === channelId ? { id: channelId } : undefined) },
        fetch: async () => {
          throw new Error('prefix getChannel should not fetch');
        },
      },
      roles: {
        cache: { get: () => null },
        fetch: async () => {
          throw new Error('prefix getRole should not fetch');
        },
      },
    },
    id: 'm',
    createdTimestamp: Date.now(),
    createdAt: new Date(),
    client: {},
  };
  const commandData = {
    name: 'say',
    toJSON() {
      return {
        name: 'say',
        options: [
          { name: 'channel', description: 'channel', type: 7, required: false },
        ],
      };
    },
  };

  const mock = createMockInteraction(fakeMessage, commandData, [channelId]);
  const channel = mock.options.getChannel('channel');
  assert(channel && typeof channel.then !== 'function', 'prefix getChannel returns a channel, not a Promise');
  assert(channel.id === channelId, 'prefix getChannel resolves mentions from cache');
  let missingCommandThrew = false;
  try {
    createMockInteraction(fakeMessage, null, ['x']);
  } catch {
    missingCommandThrew = true;
  }
  assert(!missingCommandThrew, 'createMockInteraction survives missing command data');
  assert(resolveSlashAccessKey({ commandName: 'ban' }) === 'ban', 'resolveSlashAccessKey survives missing options');
  assert(resolveSlashAccessKey(null) === null, 'resolveSlashAccessKey returns null without an interaction');
  assert(resolvePrefixAccessKey(null, []) === null, 'resolvePrefixAccessKey returns null without command data');
  let missingArgsThrew = false;
  try {
    resolvePrefixAccessKey(commandData, undefined);
  } catch {
    missingArgsThrew = true;
  }
  assert(!missingArgsThrew, 'resolvePrefixAccessKey survives missing args');
  const throwingCommandData = {
    name: 'x',
    toJSON() {
      throw new Error('toJSON failed');
    },
  };
  let throwingAccessKey;
  let throwingAccessThrew = false;
  try {
    throwingAccessKey = resolvePrefixAccessKey(throwingCommandData, []);
  } catch {
    throwingAccessThrew = true;
  }
  assert(!throwingAccessThrew, 'resolvePrefixAccessKey survives toJSON throw');
  assert(throwingAccessKey === 'x', 'resolvePrefixAccessKey falls back to command name when toJSON throws');
  let throwingMockThrew = false;
  try {
    createMockInteraction(fakeMessage, throwingCommandData, ['arg']);
  } catch {
    throwingMockThrew = true;
  }
  assert(!throwingMockThrew, 'createMockInteraction survives toJSON throw');
  assert(supportsPrefixExecution(null) === false, 'supportsPrefixExecution is false for missing commands');
  let missingPrefixCommandThrew = false;
  try {
    await executePrefixCommand(null, fakeMessage, []);
  } catch {
    missingPrefixCommandThrew = true;
  }
  assert(!missingPrefixCommandThrew, 'executePrefixCommand fails closed without a command');
}

async function checkRemainingStabilizers() {
  const futureIso = new Date(Date.now() + 120_000).toISOString();
  const pastIso = new Date(Date.now() - 120_000).toISOString();
  assert(isGiveawayEnded({ endsAt: futureIso }) === false, 'isGiveawayEnded parses future ISO end times as active');
  assert(isGiveawayEnded({ endsAt: pastIso }) === true, 'isGiveawayEnded parses past ISO end times as ended');
  assert(isGiveawayEnded({ ended: true, endsAt: futureIso }) === true, 'isGiveawayEnded honors the ended flag');
  assert(isGiveawayEnded({ endsAt: 'not-a-date' }) === true, 'isGiveawayEnded fails closed on invalid end times');

  let prefixRestrictionThrew = false;
  let prefixRestriction;
  try {
    prefixRestriction = getPrefixRestriction({
      data: {
        name: 'help',
        toJSON() {
          throw new Error('toJSON failed');
        },
      },
    }, [], (name) => name);
  } catch {
    prefixRestrictionThrew = true;
  }
  assert(!prefixRestrictionThrew, 'getPrefixRestriction survives toJSON throw');
  assert(prefixRestriction?.blocked === true, 'getPrefixRestriction still blocks slash-only commands when toJSON throws');

  let mapped;
  let mapThrew = false;
  try {
    mapped = mapArgumentsToOptions(['x'], { name: 'say', options: { not: 'array' } });
  } catch {
    mapThrew = true;
  }
  assert(!mapThrew, 'mapArgumentsToOptions survives non-array options');
  assert(mapped.getString('unused') === 'x', 'mapArgumentsToOptions falls back to positional args when options is not an array');

  assert(getCommandOptions({ options: { not: 'array' } }).length === 0, 'getCommandOptions treats non-array options as empty');
  assert(getCommandJson({
    name: 'x',
    toJSON() {
      throw new Error('toJSON failed');
    },
  })?.name === 'x', 'getCommandJson falls back to the builder when toJSON throws');

  const giveawayEndMeta = resolveComponentAccessMeta('giveaway', 'giveaway_end');
  assert(giveawayEndMeta?.commandName === 'gend', 'giveaway_end maps to gend for command access');
  const ticketMeta = resolveComponentAccessMeta('ticket', 'create_ticket');
  assert(ticketMeta?.commandName === 'ticket', 'ticket buttons map to ticket command access');
  assert(
    isCommandEnabledInConfig({ disabledCommands: { ticket: true } }, 'ticket', 'Ticket') === false,
    'disabled parent commands stay disabled in access config',
  );
  assert(await isComponentAllowed({}, null, { commandName: 'ticket', category: 'Ticket' }) === true, 'component access without a guild does not throw');
  assert(await isComponentAllowed({}, 'guild-1', {}) === true, 'unmapped components remain allowed');

  const emptyRegistry = buildCommandRegistry({});
  assert(emptyRegistry.size === 0, 'buildCommandRegistry returns an empty registry without client.commands');
  const throwingRegistry = buildCommandRegistry({
    commands: new Collection([
      ['ok', { data: { name: 'ok', description: 'ok' }, category: 'Core' }],
      ['bad', {
        data: {
          name: 'bad',
          description: 'bad',
          toJSON() {
            throw new Error('toJSON failed');
          },
        },
        category: 'Core',
      }],
    ]),
  });
  assert(throwingRegistry.get('core')?.commands.some((command) => command.name === 'bad'), 'buildCommandRegistry keeps commands whose toJSON throws');

  let loadNullThrew = false;
  try {
    await loadCommands(null);
  } catch {
    loadNullThrew = true;
  }
  assert(loadNullThrew, 'loadCommands fails closed without a client');

  const banOnlyRole = {
    permissions: {
      has(permission) {
        return permission === 'BanMembers';
      },
    },
  };
  assert(hasDangerousPermissions(banOnlyRole) === true, 'roles with any dangerous permission are blocked from self-assign');
  assert(hasDangerousPermissions({ id: 'role' }) === true, 'roles with unread permissions are treated as unsafe');
  assert(
    hasDangerousPermissions({
      permissions: {
        has() {
          throw new Error('invalid bitfield');
        },
      },
    }) === true,
    'permission bitfield throws are treated as unsafe',
  );

  ApplicationService.checkApplicationCooldown('smoke-user');
  let secondCooldownThrew = false;
  try {
    ApplicationService.checkApplicationCooldown('smoke-user');
  } catch {
    secondCooldownThrew = true;
  }
  assert(!secondCooldownThrew, 'failed application checks do not start the submit cooldown');
  ApplicationService.markApplicationCooldown('smoke-user');
  let markedCooldownThrew = false;
  try {
    ApplicationService.checkApplicationCooldown('smoke-user');
  } catch {
    markedCooldownThrew = true;
  }
  assert(markedCooldownThrew, 'successful application submits start the cooldown');

  let managerRolesTypeError = false;
  let managerRolesDenied = false;
  try {
    await ApplicationService.checkManagerPermission(
      {
        db: {
          async get() {
            return { managerRoles: 'not-an-array' };
          },
        },
      },
      'g1',
      {
        id: 'u1',
        permissions: {
          has() {
            return false;
          },
        },
        roles: { cache: { has() { return true; } } },
      },
    );
  } catch (error) {
    managerRolesTypeError = error instanceof TypeError;
    managerRolesDenied = /permission/i.test(String(error?.userMessage || error?.message || ''));
  }
  assert(!managerRolesTypeError, 'checkManagerPermission does not throw TypeError on non-array managerRoles');
  assert(managerRolesDenied, 'checkManagerPermission denies non-admins when managerRoles is not an array');

  const giveawayStore = {
    1: { messageId: '1', ended: true, isEnded: true, participants: ['a'], prize: 'x' },
  };
  const giveawayClient = {
    db: {
      async get() {
        return giveawayStore;
      },
      async set(_key, value) {
        Object.keys(giveawayStore).forEach((key) => {
          delete giveawayStore[key];
        });
        Object.assign(giveawayStore, value);
        return true;
      },
    },
  };
  let unendThrew = false;
  try {
    await saveGiveaway(giveawayClient, 'g1', {
      messageId: '1',
      ended: false,
      participants: ['a', 'b'],
      prize: 'x',
    });
  } catch {
    unendThrew = true;
  }
  assert(unendThrew, 'saveGiveaway refuses to revive an ended giveaway');
  assert(giveawayStore[1]?.ended === true, 'ended giveaway snapshot stays ended after a stale join write');
  assert(Array.isArray(giveawayStore[1]?.participants) && giveawayStore[1].participants.length === 1, 'stale join does not overwrite ended giveaway participants');

  const deletableStore = {
    2: { messageId: '2', ended: false, participants: [], prize: 'y' },
  };
  const deleteClient = {
    db: {
      async get() {
        return deletableStore;
      },
      async set(_key, value) {
        Object.keys(deletableStore).forEach((key) => {
          delete deletableStore[key];
        });
        Object.assign(deletableStore, value);
        return true;
      },
    },
  };
  let joinRecreated = false;
  const deleteOp = Mutex.runExclusive('giveaway:2', async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return deleteGiveaway(deleteClient, 'g1', '2');
  });
  const joinOp = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Mutex.runExclusive('giveaway:2', async () => {
      const list = await getGuildGiveaways(deleteClient, 'g1');
      if (!list.find((giveaway) => giveaway.messageId === '2')) {
        return false;
      }
      joinRecreated = await saveGiveaway(deleteClient, 'g1', {
        messageId: '2',
        ended: false,
        participants: ['u'],
        prize: 'y',
      });
      return joinRecreated;
    });
  })();
  const [deleted] = await Promise.all([deleteOp, joinOp]);
  assert(deleted === true, 'deleteGiveaway removes an active giveaway');
  assert(joinRecreated === false, 'a join waiting on the message lock cannot recreate a deleted giveaway');
  const afterDelete = await getGuildGiveaways(deleteClient, 'g1');
  assert(afterDelete.length === 0, 'giveaway map stays empty after locked delete');

  let panelStatusThrew = false;
  let panelStatus;
  try {
    panelStatus = await getBotPanelStatus(
      { user: { id: 'bot' } },
      {
        channels: {
          async fetch() {
            return {
              messages: {
                async fetch(query) {
                  if (query && typeof query === 'object' && query.limit) {
                    return [{ author: null, components: [] }];
                  }
                  return null;
                },
              },
            };
          },
        },
      },
      { channelId: 'c1', messageId: 'm1', buttonCustomId: 'create_ticket' },
    );
  } catch {
    panelStatusThrew = true;
  }
  assert(!panelStatusThrew, 'getBotPanelStatus survives messages without authors');
  assert(panelStatus?.exists === false, 'getBotPanelStatus does not treat authorless messages as live panels');
}

async function checkDatabaseFacade() {
  assert(typeof initializeDatabase === 'function', 'database wrapper exports initializeDatabase');
  assert(getXpForLevel(1) === 105, 'leveling XP curve helper is importable');

  const welcome = await getWelcomeConfig(null, 'guild-1');
  assert(welcome && typeof welcome === 'object', 'getWelcomeConfig returns defaults when client is null');

  const missingApplication = await getApplication(null, 'guild-1', 'app-1');
  assert(missingApplication === null, 'getApplication returns null when client is null');

  const newerCreatedAt = Date.now();
  const olderCreatedAt = new Date(newerCreatedAt - 5000).toISOString();
  const applicationRows = {
    'guild:g1:applications:a': { id: 'a', createdAt: olderCreatedAt, status: 'pending' },
    'guild:g1:applications:b': { id: 'b', createdAt: newerCreatedAt, status: 'pending' },
  };
  const listedApplications = await getApplications(
    {
      db: {
        async list() {
          return Object.keys(applicationRows);
        },
        async get(key) {
          return applicationRows[key] || {};
        },
      },
    },
    'g1',
  );
  assert(
    listedApplications[0]?.id === 'b' && listedApplications[1]?.id === 'a',
    'getApplications sorts ISO and epoch createdAt values newest first',
  );

  const joinConfig = await getJoinToCreateConfig(
    {
      db: {
        async get() {
          return { enabled: true, triggerChannels: null, temporaryChannels: null };
        },
      },
    },
    'guild-1',
  );
  assert(Array.isArray(joinConfig.triggerChannels), 'join-to-create triggerChannels stays an array when storage is null');
  assert(
    joinConfig.temporaryChannels && typeof joinConfig.temporaryChannels === 'object' && !Array.isArray(joinConfig.temporaryChannels),
    'join-to-create temporaryChannels stays an object when storage is null',
  );

  let channelNameThrew = false;
  let channelName;
  try {
    channelName = formatChannelName(null, null);
  } catch {
    channelNameThrew = true;
  }
  assert(!channelNameThrew, 'formatChannelName(null) does not throw');
  assert(typeof channelName === 'string' && channelName.length > 0, 'formatChannelName(null) returns a fallback name');

  const corruptBirthdays = await getGuildBirthdays({ db: { async get() { return 'corrupt-row'; } } }, 'guild-1');
  assert(
    corruptBirthdays && typeof corruptBirthdays === 'object' && !Array.isArray(corruptBirthdays) && Object.keys(corruptBirthdays).length === 0,
    'getGuildBirthdays treats non-object storage as empty',
  );

  const futureIso = new Date(Date.now() + 120_000).toISOString();
  const pastIso = new Date(Date.now() - 120_000).toISOString();
  const endedGiveaways = await getEndedGiveaways({
    db: {
      async list() {
        return ['guild:g1:giveaways'];
      },
      async get() {
        return [
          { messageId: 'future', endsAt: futureIso, ended: false },
          { messageId: 'past', endsAt: pastIso, ended: false },
        ];
      },
    },
  });
  assert(
    endedGiveaways.length === 1 && endedGiveaways[0].message_id === 'past',
    'ISO giveaway end times are parsed instead of treated as already ended',
  );

  const missingGiveawayList = await getEndedGiveaways({
    db: {
      async list() {
        return null;
      },
      async get() {
        return {};
      },
    },
  });
  assert(Array.isArray(missingGiveawayList) && missingGiveawayList.length === 0, 'getEndedGiveaways survives a non-array list result');

  assert(dbGetColor(null) === '#000000', 'database getColor returns fallback for non-string paths');
  let getMessageThrew = false;
  let interpolated;
  try {
    interpolated = getMessage('unused-key', null);
  } catch {
    getMessageThrew = true;
  }
  assert(!getMessageThrew, 'getMessage does not throw when replacements is null');
  assert(typeof interpolated === 'string', 'getMessage returns a string when replacements is null');
}

async function checkPluginsAndScripts() {
  const yml = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lavalink', 'application.yml'), 'utf8');
  assert(yml.includes('youtube-plugin:1.18.2'), 'Lavalink YouTube plugin is pinned to 1.18.2');
  assert(!yml.includes('ANDROID_TESTSUITE'), 'removed YouTube client ANDROID_TESTSUITE is not configured');
  assert(yml.includes('ANDROID_VR') && yml.includes('WEBEMBEDDED'), 'YouTube clients include ANDROID_VR and WEBEMBEDDED');

  const previousNodes = process.env.LAVALINK_NODES;
  process.env.LAVALINK_NODES = JSON.stringify([
    { host: 'valid.example', port: 443, password: 'secret' },
    { host: 'bad-port.example', port: 99999, password: 'secret' },
    { host: 'no-password.example', port: 443 },
  ]);
  try {
    const nodes = getLavalinkNodes();
    assert(
      nodes.length === 1 && nodes[0].host === 'valid.example',
      'invalid Lavalink node entries are dropped',
    );
  } finally {
    if (previousNodes === undefined) {
      delete process.env.LAVALINK_NODES;
    } else {
      process.env.LAVALINK_NODES = previousNodes;
    }
  }

  const previousWrappedNodes = process.env.LAVALINK_NODES;
  process.env.LAVALINK_NODES = JSON.stringify({
    nodes: [{ host: 'wrapped.example', port: 443, password: 'secret' }],
  });
  try {
    const wrappedNodes = getLavalinkNodes();
    assert(
      wrappedNodes.length === 1 && wrappedNodes[0].host === 'wrapped.example',
      'LAVALINK_NODES object.nodes payloads are accepted',
    );
  } finally {
    if (previousWrappedNodes === undefined) {
      delete process.env.LAVALINK_NODES;
    } else {
      process.env.LAVALINK_NODES = previousWrappedNodes;
    }
  }

  assert(resolveConfiguredPostgresUrl({}) === '', 'resolveConfiguredPostgresUrl is empty without env');
  assert(
    resolveConfiguredPostgresUrl({ DATABASE_URL: 'postgresql://example/db' }) === 'postgresql://example/db',
    'resolveConfiguredPostgresUrl falls back to DATABASE_URL',
  );
  let missingUrlThrew = false;
  try {
    requireConfiguredPostgresUrl({});
  } catch {
    missingUrlThrew = true;
  }
  assert(missingUrlThrew, 'requireConfiguredPostgresUrl fails closed without a URL');

  const redacted = redactDatabaseUrl('postgresql://titanbot:super-secret@127.0.0.1:5432/titanbot');
  assert(redacted.includes('***'), 'restore logs redact the database password');
  assert(!redacted.includes('super-secret'), 'redacted database URL does not include the password');
  assert(
    !redactDatabaseSecrets('pg_restore failed: postgresql://titanbot:super-secret@127.0.0.1/titanbot').includes('super-secret'),
    'restore command errors redact credentials in stderr',
  );
  assert(
    !redactDatabaseSecrets('password authentication failed for postgresql://titanbot:super-secret@127.0.0.1/titanbot').includes('super-secret'),
    'script failure logs redact credentials in error.message',
  );

  let logMissingGuildsThrew = false;
  let logMissingGuildsResult;
  try {
    logMissingGuildsResult = await logEvent({
      client: {},
      guildId: 'g1',
      eventType: LOG_EVENT_TYPES.MEMBER_JOIN,
      data: { title: 'join', lines: [] },
    });
  } catch {
    logMissingGuildsThrew = true;
  }
  assert(!logMissingGuildsThrew, 'logEvent does not throw when client.guilds is missing');
  assert(logMissingGuildsResult == null, 'logEvent returns null when client.guilds is missing');

  assert(
    ConfigService.verifyPermission(mockMember({ permissions: PermissionFlagsBits.ManageGuild })) === true,
    'config verifyPermission allows ManageGuild without Administrator',
  );
  assert(
    ConfigService.verifyPermission(mockMember({ permissions: PermissionFlagsBits.BanMembers })) === false,
    'config verifyPermission still denies BanMembers-only members',
  );

  const missingPerms = validateLogChannel(
    { type: ChannelType.GuildText, permissionsFor: () => null },
    { id: 'bot' },
  );
  assert(missingPerms.valid === false, 'validateLogChannel fails closed when permissionsFor is null');
  const throwingPerms = validateLogChannel(
    {
      type: ChannelType.GuildText,
      permissionsFor: () => ({
        has() {
          throw new Error('invalid bitfield');
        },
      }),
    },
    { id: 'bot' },
  );
  assert(throwingPerms.valid === false, 'validateLogChannel fails closed when permissions.has throws');

  let bannedByManageGuild = false;
  try {
    await ModerationService.banUser({
      guild: {
        ownerId: '999',
        name: 'smoke',
        client: {
          guilds: {
            cache: {
              get() {
                return null;
              },
            },
            fetch: async () => null,
          },
        },
        members: {
          fetch: async () => null,
          ban: async () => {
            bannedByManageGuild = true;
          },
        },
      },
      user: { id: 'u1', tag: 'user#0001' },
      moderator: {
        ...mockMember({ permissions: PermissionFlagsBits.ManageGuild }),
        user: { tag: 'mod#0001' },
      },
    });
  } catch {
    // logModerationAction may fail after the permission check and ban call
  }
  assert(bannedByManageGuild, 'ManageGuild-only moderators can ban users who are not in the guild');

  let bannedByBanMembers = false;
  let banMembersError;
  try {
    await ModerationService.banUser({
      guild: {
        ownerId: '999',
        name: 'smoke',
        client: {
          guilds: {
            cache: {
              get() {
                return null;
              },
            },
            fetch: async () => null,
          },
        },
        members: {
          fetch: async () => null,
          ban: async () => {
            bannedByBanMembers = true;
          },
        },
      },
      user: { id: 'u2', tag: 'user#0002' },
      moderator: {
        ...mockMember({ permissions: PermissionFlagsBits.BanMembers }),
        user: { tag: 'mod#0002' },
      },
    });
  } catch (error) {
    banMembersError = error;
  }
  assert(bannedByBanMembers === false, 'BanMembers-only moderators cannot ban users who are not in the guild');
  assert(banMembersError?.type === ErrorTypes.PERMISSION, 'out-of-guild ban denial is a permission error');
}

async function checkPostgresRoundTrip() {
  if (!process.env.POSTGRES_URL && !process.env.POSTGRES_HOST) {
    console.log('SKIP  Postgres round-trip (no POSTGRES_URL/POSTGRES_HOST)');
    return;
  }

  const { db } = await initializeDatabase();
  const status = db.getStatus();
  if (status.isDegraded) {
    console.log(`SKIP  Postgres round-trip (degraded: ${status.degradedReason || status.connectionType})`);
    return;
  }

  const guildId = 'smoke-guild';
  const userId = 'smoke-user';
  const iso = '2026-07-28T13:16:39.000Z';
  const levelKey = getUserLevelKey(guildId, userId);
  const economyKey = getEconomyKey(guildId, userId);

  try {
    await db.set(levelKey, {
      xp: 25,
      level: 2,
      totalXp: 180,
      lastMessage: iso,
      rank: 1,
    });
    const levelRow = await db.get(levelKey);
    assert(levelRow?.totalXp === 180, 'Postgres user_level stores camelCase totalXp');
    assert(levelRow?.lastMessage === Date.parse(iso), 'Postgres user_level lastMessage round-trips ISO to epoch ms');

    await db.set(levelKey, {
      ...levelRow,
      lastMessage: 1_753_670_199_000,
    });
    const numericRow = await db.get(levelKey);
    assert(numericRow?.lastMessage === 1_753_670_199_000, 'Postgres user_level lastMessage round-trips numeric epoch');

    await db.set(levelKey, {
      xp: 3e15,
      level: 2,
      totalXp: 3e15,
      lastMessage: 0,
      rank: 1,
    });
    const clampedRow = await db.get(levelKey);
    assert(clampedRow?.xp === 2147483647, 'Postgres user_level xp clamps to INTEGER max');
    assert(clampedRow?.totalXp === 2147483647, 'Postgres user_level totalXp clamps to INTEGER max');

    await db.set(levelKey, {
      xp: 1,
      level: 50000,
      totalXp: 1,
      lastMessage: 0,
      rank: 0,
    });
    const cappedLevelRow = await db.get(levelKey);
    assert(cappedLevelRow?.level === 1000, 'Postgres user_level level clamps to MAX_LEVEL');

    await db.set(economyKey, { wallet: 50, bank: 25 });
    const economyRow = await db.get(economyKey);
    assert(economyRow?.wallet === 50 && economyRow?.bank === 25, 'Postgres economy wallet/bank persist');

    await db.set(economyKey, { wallet: 3e15, bank: 3e15 });
    const clampedEconomy = await db.get(economyKey);
    assert(clampedEconomy?.wallet === 2147483647, 'Postgres economy wallet clamps to INTEGER max');
    assert(clampedEconomy?.bank === 2147483647, 'Postgres economy bank clamps to INTEGER max');

    const birthdayKey = getGuildBirthdaysKey(guildId);
    await db.set(birthdayKey, { 'user-1': { month: 3, day: 15 } });
    const birthdayRow = await db.get(birthdayKey);
    assert(birthdayRow?.['user-1']?.month === 3 && birthdayRow?.['user-1']?.day === 15, 'Postgres birthdays persist valid month/day');

    const rejectedBirthday = await db.set(birthdayKey, { 'user-1': { month: 99, day: 15 } });
    assert(rejectedBirthday === false, 'invalid birthday payload is rejected before delete');
    const birthdayAfterReject = await db.get(birthdayKey);
    assert(birthdayAfterReject?.['user-1']?.month === 3, 'rejected birthday write does not wipe existing rows');

    const mixedBirthday = await db.set(birthdayKey, {
      'user-1': { month: 3, day: 15 },
      'user-2': { month: 99, day: 1 },
    });
    assert(mixedBirthday === true, 'mixed birthday payload writes valid entries');
    const birthdayAfterMixed = await db.get(birthdayKey);
    assert(birthdayAfterMixed?.['user-1']?.month === 3, 'valid birthday kept when mixed with invalid');
    assert(birthdayAfterMixed?.['user-2'] == null, 'invalid birthday entry is skipped');

    const afkKey = getAFKKey(guildId, userId);
    const afkWrite = await db.set(afkKey, { reason: 'away', expiresAt: 'not-a-date' });
    assert(afkWrite === true, 'invalid AFK expiry is stored as null instead of throwing');
    const afkRow = await db.get(afkKey);
    assert(afkRow?.reason === 'away', 'AFK reason persists when expiry is invalid');
  } finally {
    await db.delete(levelKey).catch(() => {});
    await db.delete(economyKey).catch(() => {});
    await db.delete(getGuildBirthdaysKey(guildId)).catch(() => {});
    await db.delete(getAFKKey(guildId, userId)).catch(() => {});
    if (db.db?.pool) {
      await db.db.pool.end().catch(() => {});
    }
  }
}

await checkTimestamps();
await checkLevelCurve();
await checkLevelStorage();
await checkEmbeds();
await checkPermissions();
await checkDatabaseFacade();
await checkCommands();
await checkHandlers();
await checkPrefixAdapter();
await checkRemainingStabilizers();
await checkPluginsAndScripts();
await checkPostgresRoundTrip();

if (failures.length > 0) {
  console.error(`\nSmoke check failed: ${failures.length} assertion(s)`);
  process.exit(1);
}

console.log('\nSmoke check passed');
