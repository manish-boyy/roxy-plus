const { WebhookClient } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../data/mirror_config.json');

// Store active mirrors: Map<sourceChannelId, Config>
// Config: { sourceId, targetId, mode ('normal'|'webhook'), webhook: { id, token } (optional), startTime }
let activeMirrors = new Map();

function loadData() {
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 4));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.error("Error loading mirror config:", e);
        return {};
    }
}

function saveData() {
    const data = {};
    for (const [sourceId, config] of activeMirrors.entries()) {
        data[sourceId] = {
            sourceId: config.sourceId,
            targetId: config.targetId,
            mode: config.mode,
            webhook: config.webhook,
            startTime: config.startTime
        };
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 4));
}

async function initialize(client) {
    console.log("[Mirror System] Initializing...");
    const saved = loadData();

    // Restore mirrors
    for (const [sourceId, config] of Object.entries(saved)) {
        try {
            await startMirror(client, config.sourceId, config.targetId, config.mode, config.webhook, true);
            // true = restoring, don't save immediately (optimization)
        } catch (e) {
            console.error(`[Mirror] Failed to restore mirror for ${sourceId}:`, e.message);
        }
    }

    // Single Global Listener for Performance? 
    // Or per mirror?
    // Using a global listener is better for memory if many mirrors.
    client.on('messageCreate', async (message) => {
        if (!activeMirrors.has(message.channel.id)) return;
        const config = activeMirrors.get(message.channel.id);

        // Loop prevention
        if (message.author.id === client.user.id) return;
        // Also ignore webhook messages if we are creating them? 
        // Webhooks have `message.webhookId`.
        if (message.webhookId) return;

        // Ignore system messages?
        if (message.system) return;

        try {
            await processMirror(client, message, config);
        } catch (e) {
            console.error(`[Mirror] Error processing message from ${message.channel.id}:`, e);
        }
    });

    console.log(`[Mirror System] Restored ${activeMirrors.size} mirrors.`);
}

async function startMirror(client, sourceId, targetId, mode, webhookData = null, isRestoring = false) {
    if (activeMirrors.has(sourceId)) {
        throw new Error("Mirror already active for this source channel.");
    }

    const sourceChannel = await client.channels.fetch(sourceId).catch(() => null);
    const targetChannel = await client.channels.fetch(targetId).catch(() => null);

    if (!sourceChannel) throw new Error("Invalid Source Channel.");
    if (!targetChannel) throw new Error("Invalid Target Channel.");

    // Setup Webhook if needed
    let webhookInfo = webhookData;
    let webhookClient = null;

    if (mode === 'webhook') {
        if (!webhookInfo) {
            // Create/Find Webhook
            const hooks = await targetChannel.fetchWebhooks().catch(() => null);
            let hook = hooks ? hooks.find(h => h.token) : null; // Find one with token (we need to be able to send)

            if (!hook) {
                // Create
                try {
                    hook = await targetChannel.createWebhook('Mirror Bot', {
                        avatar: client.user.displayAvatarURL(),
                        reason: 'Mirror System'
                    });
                } catch (e) {
                    throw new Error("Failed to create Webhook. Check Permissions in Target Channel.");
                }
            }
            webhookInfo = { id: hook.id, token: hook.token };
        }

        webhookClient = new WebhookClient({ id: webhookInfo.id, token: webhookInfo.token });
    }

    const config = {
        sourceId,
        targetId,
        mode,
        webhook: webhookInfo,
        webhookClient, // Runtime only
        startTime: new Date().toISOString()
    };

    activeMirrors.set(sourceId, config);

    if (!isRestoring) {
        saveData();
    }
}

async function stopMirror(sourceId) {
    if (!activeMirrors.has(sourceId)) return false;
    activeMirrors.delete(sourceId);
    saveData();
    return true;
}

async function processMirror(client, message, config) {
    const { mode, targetId, webhookClient } = config;
    const targetChannel = await client.channels.fetch(targetId); // Can cache this?

    // Prepare Payload
    const files = [];
    if (message.attachments.size > 0) {
        message.attachments.forEach(a => files.push(a.url));
    }
    // Extract CDN links from content? (As per example)
    const cdnLinks = (message.content || '').match(/https:\/\/cdn\.discordapp\.com\/[^\s]+/g) || [];
    cdnLinks.forEach(link => { if (!files.includes(link)) files.push(link); });

    const embeds = message.embeds || [];

    // Payload Object
    const payload = {
        content: message.content || undefined, // undefined if empty string?
        files: files,
        embeds: embeds
    };

    // Safety: don't send empty
    if (!payload.content && !payload.files.length && !payload.embeds.length) return;

    if (mode === 'webhook' && webhookClient) {
        // Clone User Identity
        payload.username = message.author.username;
        payload.avatarURL = message.author.displayAvatarURL({ dynamic: true });

        await webhookClient.send(payload);
    } else {
        // Normal Mode (Send as SelfBot)
        // Just content
        await targetChannel.send(payload);
    }
}

function getActiveMirrors() {
    const list = [];
    for (const [sourceId, config] of activeMirrors.entries()) {
        list.push({
            sourceId,
            targetId: config.targetId,
            mode: config.mode,
            startTime: config.startTime
        });
    }
    return list;
}

module.exports = { initialize, startMirror, stopMirror, getActiveMirrors, loadData };
