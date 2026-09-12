import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;
const DISCORD_NAME_MAX = 32;
const DISCORD_DESCRIPTION_MAX = 100;
const DISCORD_CHOICE_VALUE_MAX = 100;

function getSubcommandInfo(commandData) {
    const subcommands = [];
    
    if (commandData.options) {
        for (const option of commandData.options) {
if (option.type === 1) {
                subcommands.push(option.name);
} else if (option.type === 2) {
                if (option.options) {
                    for (const subOption of option.options) {
if (subOption.type === 1) {
                            subcommands.push(`${option.name}/${subOption.name}`);
                        }
                    }
                }
            }
        }
    }
    
    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });
    
    for (const file of files) {
        const filePath = path.join(directory, file.name);
        
        if (file.isDirectory()) {
            if (file.name === 'modules') {
                continue;
            }
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    
    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../../commands');
    const commandFiles = await getAllFiles(commandsPath);
    
    logger.info(`Found ${commandFiles.length} command files to load`);
    
    const uniqueCommandNames = new Set();
    
    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);
            
            const commandModule = await import(pathToFileURL(filePath).href);
            const command = commandModule.default || commandModule;
            
            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }
            
            command.category = category;
            command.filePath = normalizedPath;
            
            const primaryCommandName = command.data.name;

            if (uniqueCommandNames.has(primaryCommandName)) {
                logger.warn(`Skipping duplicate command name "${primaryCommandName}" from ${normalizedPath}`);
                continue;
            }

            uniqueCommandNames.add(primaryCommandName);
            client.commands.set(primaryCommandName, command);
            
            const subcommands = getSubcommandInfo(command.data.toJSON());
            
            logger.debug(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`);
            
            if (subcommands.length > 0) {
                logger.debug(`  - Subcommands: ${subcommands.join(', ')}`);
            }
            
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }
    
    logger.info(`Loaded ${client.commands.size} commands`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn(`Command missing data or toJSON method: ${command}`);
            continue;
        }

        const commandName = command.data.name;
        logger.debug(`Processing command for registration: ${commandName}`);

        if (registeredNames.has(commandName)) {
            logger.debug(`Skipping duplicate command: ${commandName}`);
            continue;
        }

        registeredNames.add(commandName);
        const commandJson = command.data.toJSON();
        commands.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;

        if (process.env.NODE_ENV !== 'production') {
            logger.debug(`Registering command: ${commandName}`);
        }
    }

    return { commands, totalSubcommands };
}

function validateCommands(commands) {
    const validationErrors = [];

    const checkLength = (label, value, max) => {
        if (typeof value === 'string' && value.length > max) {
            validationErrors.push(`${label} is longer than ${max} chars (${value.length}): "${value}"`);
        }
    };

    const walk = (node, label) => {
        checkLength(`${label} name`, node.name, DISCORD_NAME_MAX);
        checkLength(`${label} description`, node.description, DISCORD_DESCRIPTION_MAX);

        for (const choice of node.choices || []) {
            checkLength(`${label} choice name`, choice.name, DISCORD_DESCRIPTION_MAX);
            if (typeof choice.value === 'string') {
                checkLength(`${label} choice value`, choice.value, DISCORD_CHOICE_VALUE_MAX);
            }
        }

        for (const child of node.options || []) {
            walk(child, `${label} ${child.name || 'option'}`);
        }
    };

    for (const cmd of commands) {
        walk(cmd, `Command ${cmd.name}`);
    }

    if (validationErrors.length > 0) {
        logger.error('Command validation failed. Errors:');
        validationErrors.forEach((error) => logger.error(`  - ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} global command limit`);
    }

    if (commands.length <= MAX_COMMANDS) {
        return commands;
    }

    logger.warn(`Command count (${commands.length}) exceeds Discord limit (${MAX_COMMANDS}), truncating...`);
    const truncated = commands.slice(0, MAX_COMMANDS);
    logger.info(`Truncated to ${truncated.length} commands for registration`);
    return truncated;
}

async function registerGlobalCommands(client, clientId, commands, totalSubcommands) {
    if (!clientId) {
        throw new Error('CLIENT_ID is required for slash command registration');
    }

    if (!client.rest) {
        throw new Error('Discord REST client is not available for slash command registration');
    }

    logger.info(`Preparing to register ${totalSubcommands + commands.length} commands globally`);
    logger.info('Validating commands before registration...');
    validateCommands(commands);
    logger.info('Command validation passed');

    const commandsToRegister = prepareCommandsForRegistration(commands);

    if (botConfig.commands?.deleteCommands) {
        logger.info('Clearing existing global commands before registration...');
        await client.rest.put(`/applications/${clientId}/commands`, { body: [] });
    }

    logger.info(`Registering ${commandsToRegister.length} global commands...`);
    await client.rest.put(`/applications/${clientId}/commands`, { body: commandsToRegister });
    logger.info(`Successfully registered ${commandsToRegister.length} global commands`);
    logger.info('Global commands may take up to an hour to appear in all servers on first deploy');
}

export async function registerCommands(client, options = {}) {
    const { clientId = null } = options;

    try {
        const { commands, totalSubcommands } = collectCommandPayloads(client);
        await registerGlobalCommands(client, clientId, commands, totalSubcommands);
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);
    
    if (!command) {
        return { success: false, message: `Command "${commandName}" not found` };
    }
    
    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());

        const commandModule = await import(moduleUrl.href);
        const newCommand = commandModule.default || commandModule;

        if (!newCommand?.data || typeof newCommand.execute !== 'function') {
            return { success: false, message: `Reloaded module for "${commandName}" is missing data or execute` };
        }

        newCommand.category = command.category;
        newCommand.filePath = command.filePath;
        client.commands.set(commandName, newCommand);
        
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}