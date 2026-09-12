/**
 * Offline sanity check for boot-critical modules.
 * Does not log into Discord or require a live bot token.
 */
import 'dotenv/config';
import { Client, Collection, EmbedBuilder, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { createEmbed, formatDate, formatDuration, formatProgressBar } from '../src/utils/embeds.js';
import { toDate, toEpochMs, toNonNegativeInt, toPgInt } from '../src/utils/database/timestamps.js';
import {
  getCommandDefaultPermissions,
  memberMeetsCommandPermissions,
  memberHasModerationCommandAccess,
  checkUserPermissions,
  isModerator,
  botHasPermission,
} from '../src/utils/permissionGuard.js';
import { loadCommands } from '../src/handlers/loaders/commandLoader.js';
import loadEvents from '../src/handlers/loaders/events.js';
import loadInteractions from '../src/handlers/loaders/interactions.js';
import { initializeDatabase, getXpForLevel as dbGetXpForLevel } from '../src/utils/database.js';
import { getUserLevelKey, getEconomyKey } from '../src/utils/database/keys.js';
import { getXpForLevel, getLevelFromXp, MAX_LEVEL } from '../src/services/leveling/leveling.js';
import { createMockInteraction, resolveSlashAccessKey, resolvePrefixAccessKey, supportsPrefixExecution } from '../src/utils/messageAdapter.js';

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

  let nullFooterThrew = false;
  try {
    new EmbedBuilder().setFooter(null);
  } catch {
    nullFooterThrew = true;
  }
  assert(!nullFooterThrew, 'setFooter(null) does not throw');
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
    getCommandDefaultPermissions({ default_member_permissions: 'not-a-bitfield' }) === 0n,
    'invalid default_member_permissions fails closed as admin-only',
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
    const json = command.data.toJSON();
    if (json.description?.length > DISCORD_DESCRIPTION_MAX) {
      overLimit.push(`${json.name} (${json.description.length})`);
    }
    for (const option of json.options || []) {
      if (option.description?.length > DISCORD_DESCRIPTION_MAX) {
        overLimit.push(`${json.name}.${option.name} (${option.description.length})`);
      }
    }
  }
  assert(overLimit.length === 0, overLimit.length ? `descriptions exceed Discord 100-char limit: ${overLimit.join(', ')}` : 'slash descriptions stay within Discord 100-char limit');
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
  assert(resolveSlashAccessKey({ commandName: 'ban' }) === 'ban', 'resolveSlashAccessKey survives missing options');
  assert(resolvePrefixAccessKey(null, []) === null, 'resolvePrefixAccessKey returns null without command data');
  assert(supportsPrefixExecution(null) === false, 'supportsPrefixExecution is false for missing commands');
}

async function checkDatabaseFacade() {
  assert(typeof initializeDatabase === 'function', 'database wrapper exports initializeDatabase');
  assert(getXpForLevel(1) === 105, 'leveling XP curve helper is importable');
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
  } finally {
    await db.delete(levelKey).catch(() => {});
    await db.delete(economyKey).catch(() => {});
    if (db.db?.pool) {
      await db.db.pool.end().catch(() => {});
    }
  }
}

await checkTimestamps();
await checkLevelCurve();
await checkEmbeds();
await checkPermissions();
await checkDatabaseFacade();
await checkCommands();
await checkHandlers();
await checkPrefixAdapter();
await checkPostgresRoundTrip();

if (failures.length > 0) {
  console.error(`\nSmoke check failed: ${failures.length} assertion(s)`);
  process.exit(1);
}

console.log('\nSmoke check passed');
