/**
 * Offline sanity check for boot-critical modules.
 * Does not log into Discord or require a live bot token.
 */
import { Collection, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../src/utils/embeds.js';
import { toDate, toEpochMs } from '../src/utils/database/timestamps.js';
import {
  getCommandDefaultPermissions,
  memberMeetsCommandPermissions,
  memberHasModerationCommandAccess,
  checkUserPermissions,
} from '../src/utils/permissionGuard.js';
import { loadCommands } from '../src/handlers/loaders/commandLoader.js';
import { initializeDatabase } from '../src/utils/database.js';
import { getXpForLevel } from '../src/services/leveling/leveling.js';

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

  const replies = [];
  const result = await checkUserPermissions(
    { member: null, user: { id: '1' }, commandName: 'leveladd', guildId: '2', reply: async (payload) => replies.push(payload) },
    PermissionFlagsBits.ManageGuild,
  );
  assert(result === false, 'checkUserPermissions denies when member is missing');
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

async function checkDatabaseFacade() {
  assert(typeof initializeDatabase === 'function', 'database wrapper exports initializeDatabase');
  assert(getXpForLevel(1) === 105, 'leveling XP curve helper is importable');
}

await checkTimestamps();
await checkEmbeds();
await checkPermissions();
await checkDatabaseFacade();
await checkCommands();

if (failures.length > 0) {
  console.error(`\nSmoke check failed: ${failures.length} assertion(s)`);
  process.exit(1);
}

console.log('\nSmoke check passed');
