require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');

const client = new Client({
    checkUpdate: false
});

// Initialize music system
const Lavalink = require('./music/lavalink');
const queueManager = require('./music/queue');

// Initialize Lavalink if configured
let lavalink = null;
if (process.env.LAVALINK_WS && process.env.LAVALINK_REST && process.env.LAVALINK_PASSWORD) {
    lavalink = new Lavalink({
        restHost: process.env.LAVALINK_REST,
        wsHost: process.env.LAVALINK_WS,
        password: process.env.LAVALINK_PASSWORD,
        clientName: process.env.CLIENT_NAME || 'RoxyPlus',
    });
}

// Voice states storage
const voiceStates = {};

client.commands = new Map();
client.lavalink = lavalink;
client.queueManager = queueManager;
client.voiceStates = voiceStates;

function loadAllowedUsers() {
    try {
        const allowedPath = path.join(__dirname, 'data', 'allowed.json');
        if (!fs.existsSync(allowedPath)) {
            const defaultData = { allowedUsers: [] };
            fs.writeFileSync(allowedPath, JSON.stringify(defaultData, null, 2));
            return defaultData.allowedUsers;
        }
        const data = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
        return data.allowedUsers || [];
    } catch (error) {
        console.error('Error loading allowed users:', error);
        return [];
    }
}

function isAllowedUser(userId) {
    const allowedUsers = loadAllowedUsers();
    return allowedUsers.includes(userId);
}

const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.name) {
                client.commands.set(command.name, command);
            }
        } catch (error) {
            console.error('Error loading command ' + file + ':', error);
        }
    }
}

const dashboard = require('./dashboard/index');

client.on('ready', () => {
    console.log('Logged in as ' + client.user.tag);
    console.log('User ID: ' + client.user.id);
    console.log('Roxy+ is ready!');
    console.log('Loaded ' + client.commands.size + ' commands');

    // Connect to Lavalink if available
    if (client.lavalink) {
        client.lavalink.connect(client.user.id);
        console.log('Connecting to Lavalink...');
    }

    // Initialize RPC
    const rpcManager = require('./commands/rpcManager');
    rpcManager.initialize(client);

    // Initialize Auto Reaction
    const reactionManager = require('./commands/reactionManager');
    reactionManager.initialize(client);

    // Initialize AI System
    const aiManager = require('./commands/aiManager');
    aiManager.initialize(client);

    // Initialize Mirror System
    const mirrorManager = require('./commands/mirrorManager');
    mirrorManager.initialize(client);

    // Start Dashboard
    dashboard(client);
});

// Voice state handling for Lavalink
if (client.lavalink) {
    client.ws.on('VOICE_STATE_UPDATE', (packet) => {
        if (packet.user_id !== client.user.id) return;

        const guildId = packet.guild_id;
        if (!voiceStates[guildId]) voiceStates[guildId] = {};
        voiceStates[guildId].sessionId = packet.session_id;
        console.log(`[Voice] State update for guild ${guildId}`);
    });

    client.ws.on('VOICE_SERVER_UPDATE', (packet) => {
        const guildId = packet.guild_id;
        if (!voiceStates[guildId]) voiceStates[guildId] = {};
        voiceStates[guildId].token = packet.token;
        voiceStates[guildId].endpoint = packet.endpoint;
        console.log(`[Voice] Server update for guild ${guildId}`);
    });

    // Lavalink event handlers
    client.lavalink.on('ready', () => {
        console.log('[Lavalink] Session established');
    });

    client.lavalink.on('event', async (evt) => {
        console.log(`[Lavalink Event] Type: ${evt.type}, Guild: ${evt.guildId}`);

        if (evt.type === 'TrackEndEvent') {
            if (evt.reason === 'finished' || evt.reason === 'loadFailed') {
                const queue = queueManager.get(evt.guildId);
                if (!queue) return;

                if (queue.nowPlaying) {
                    queue.history.push(queue.nowPlaying);
                }

                const nextSong = queueManager.getNext(evt.guildId);

                if (!nextSong) {
                    await client.lavalink.destroyPlayer(evt.guildId);
                    queueManager.delete(evt.guildId);
                    if (queue.textChannel) {
                        queue.textChannel.send('```Queue finished```');
                    }
                    return;
                }

                queue.nowPlaying = nextSong;
                const voiceState = voiceStates[evt.guildId];

                if (voiceState && voiceState.token && voiceState.sessionId && voiceState.endpoint) {
                    try {
                        await client.lavalink.updatePlayer(evt.guildId, nextSong, voiceState, {
                            volume: queue.volume,
                            filters: queue.filters
                        });

                        if (queue.textChannel) {
                            let nowPlayingMsg = '```\n';
                            nowPlayingMsg += '╭─[ NOW PLAYING ]─╮\n\n';
                            nowPlayingMsg += `  🎵 ${nextSong.info.title}\n`;
                            nowPlayingMsg += `  👤 ${nextSong.info.author}\n`;
                            nowPlayingMsg += '\n╰──────────────────────────────────╯\n```';
                            queue.textChannel.send(nowPlayingMsg);
                        }
                    } catch (err) {
                        console.error('[Auto-play Error]:', err);
                        if (queue.textChannel) {
                            queue.textChannel.send('```Error playing next song```');
                        }
                    }
                }
            }
        }
    });

    client.lavalink.on('playerUpdate', (packet) => {
        const queue = queueManager.get(packet.guildId);
        if (queue && packet.state) {
            queue.position = packet.state.position;
            queue.lastUpdate = Date.now();
        }
    });
}

// AFK & Logging Logic
const respondedUsers = new Set();
// Clear responded users every 1 hour
setInterval(() => respondedUsers.clear(), 3600000);

client.on('messageCreate', async (message) => {
    try {
        if (!message.author) return;

        // --- AFK & LOGGING SYSTEM ---
        const mentionsMe = message.mentions.users.has(client.user.id);
        const isDm = message.channel.type === 'DM';

        if ((mentionsMe || isDm) && message.author.id !== client.user.id) {

            // Read Settings
            const afkPath = path.join(__dirname, 'data', 'afk.json');
            const logPath = path.join(__dirname, 'data', 'afklog.json');

            let afkData = { isOn: false, reason: '', logsEnabled: false };
            if (fs.existsSync(afkPath)) {
                afkData = JSON.parse(fs.readFileSync(afkPath, 'utf8'));
            }

            // 1. LOGGING (If enabled)
            if (afkData.logsEnabled) {
                let logs = [];
                if (fs.existsSync(logPath)) {
                    logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
                }

                let cleanContent = message.content;

                // 1. Clean User Mentions <@ID> or <@!ID>
                cleanContent = cleanContent.replace(/<@!?(\d+)>/g, (match, id) => {
                    const user = client.users.cache.get(id);
                    return user ? `@${user.username}` : match;
                });

                // 2. Clean Role Mentions <@&ID>
                cleanContent = cleanContent.replace(/<@&(\d+)>/g, (match, id) => {
                    const role = message.guild ? message.guild.roles.cache.get(id) : null;
                    return role ? `@${role.name}` : match;
                });

                // 3. Clean Channel Mentions <#ID>
                cleanContent = cleanContent.replace(/<#(\d+)>/g, (match, id) => {
                    const channel = client.channels.cache.get(id);
                    return channel ? `#${channel.name}` : match;
                });

                // 4. Clean Custom Emojis <:name:ID>
                cleanContent = cleanContent.replace(/<a?:(\w+):(\d+)>/g, ':$1:');

                const logEntry = {
                    id: Date.now().toString(),
                    user: message.author.tag,
                    userId: message.author.id,
                    channel: isDm ? 'DM' : message.channel.name || 'Unknown',
                    guild: message.guild ? message.guild.name : 'Direct Message',
                    content: cleanContent,
                    time: new Date().toLocaleString(),
                    link: message.url
                };

                logs.unshift(logEntry);
                if (logs.length > 50) logs = logs.slice(0, 50);
                fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
            }

            // 2. AFK REPLY
            if (afkData.isOn && !respondedUsers.has(message.author.id)) {
                const reason = afkData.reason || "I'm currently AFK.";
                try {
                    await message.reply(`**[AFK]** ${reason}`);
                    respondedUsers.add(message.author.id);
                } catch (err) {
                    console.error('Failed to reply to AFK ping:', err);
                }
            }
        }

        // --- COMMAND HANDLER ---
        const prefix = process.env.PREFIX || '!';
        if (!message.content.startsWith(prefix)) return;

        const args = message.content.slice(prefix.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        if (!isAllowedUser(message.author.id)) {
            return;
        }

        const command = client.commands.get(commandName);
        if (!command) return;

        await command.execute(message, args, client);
    } catch (error) {
        console.error('Error in messageCreate:', error);
    }
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

if (!process.env.TOKEN) {
    console.error('Error: TOKEN not found in .env file');
    process.exit(1);
}

client.login(process.env.TOKEN).catch(error => {
    console.error('Failed to login:', error.message);
    process.exit(1);
});
