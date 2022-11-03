#!/usr/bin/node
const { promisify } = require("util");
const execute = promisify(require("child_process").exec);
const https = require("https");
const fs = require("fs");
const ms = require("ms");

const processArguments = process.argv.slice(2);
const options = {
    debug: processArguments.find(value => value === "-v" || value === "-debug") || false,
    configPath: processArguments.find(value => value.startsWith("--config="))?.replace("--config=", "") || "/etc/default/batterymonitor",
};

// If config doesn't exist on the defined path, create it!
if (!fs.existsSync(options.configPath))
    fs.writeFileSync(options.configPath, JSON.stringify({
        discordWebhookID: "REPLACE",
        discordWebhookToken: "REPLACE",
        batteryPercentageMinimal: 30,
        batteryPercentageCritical: 10,
        notifications: {
            systemCharging: {
                timestamp: true,
                color: "#1ed760",
                title: "System is charging!",
            },
            
            adapterUnpluggedDetails: {
                timestamp: true,
                color: "#1ed760",
                title: "Details while the system was unplugged",
                description: `**Current percentage:** {batteryPercentage}%\n**Lowest battery percentage:** {lastBatteryPercentage}%\n**System unplugged time:** {unpluggedTime}`,
            },
            
            adapterUnplugged: {
                timestamp: true,
                color: "#ec7979",
                title: "The adapter charger has been unplugged!",
                description: `**Current battery percentage:** {batteryPercentage}%`,
            },
            
            batteryBelowMinimum: {
                timestamp: true,
                color: "#ec7979",
                title: "Battery percentage is below minimum!",
                description: `**Current battery percentage:** {batteryPercentage}%\n**Minimal battery percentage:** {batteryPercentageMinimal}%\n**Critical battery percentage:** {batteryPercentageCritical}%`,
            },

            batteryAtCriticalLevel: {
                timestamp: true,
                color: "#ec7979",
                title: "Battery percentage is at critical percentage, system shutting down!",
                description: `**Current battery percentage:** {batteryPercentage}%\n**Critical battery percentage:** {batteryPercentageCritical}%`,
            },
        },
    }, null, 2));

// Importing the config
const config = require(options.configPath);

//? Variables
let userNotified = { minimalBatteryPercentage: false, criticalBatteryPercentage: false, systemCharging: false, adapterUnplugged: false, },
    lastState, lastBatteryPercentage, lastPluggedIn;

// Resets the variables
const resetVariables = () => {
    userNotified = { minimalBatteryPercentage: false, criticalBatteryPercentage: false, systemCharging: false, adapterUnplugged: false, };
    lastState = undefined;
}

//? Functions
// Sends a webhook to Discord
const sendDiscordWebhook = (webhookData) => new Promise((resolve, reject) => {
    webhookData = JSON.stringify(webhookData);

    const request = https.request({
        hostname: 'discord.com',
        port: 443,
        path: `/api/webhooks/${config.discordWebhookID}/${config.discordWebhookToken}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': webhookData.length,
        },
    }, (response) => {
        if (response.statusCode != 204 && response.statusCode != 200)
            reject(`Discord API returned ${response.statusCode} (${response.statusMessage})`)

        resolve();
    });

    request.on("error", error => reject(error));
    
    request.write(webhookData);
    request.end();
});

// Injects variables into string
const stringInject = (template, variables) => {
    if (!template) return;
    
    return template.replace(new RegExp("\{([^\{]+)\}", "g"), function (_unused, varName) {
        return variables[varName];
    });
}

// Turns off the system
const shutdownSystem = () => execute('/usr/sbin/poweroff');

// Logs into console
const log = (message, debug) => debug && options.debug ? console.log(`[DEBUG] ${message}`) : console.log(message);

//? Getters
// Returns battery percentage
const getBatteryPercentage = async () => execute('cat /sys/class/power_supply/*/capacity').then(process => Number(process.stdout.trim()));

// Returns if system is charging
const isSystemCharging = async () => execute('cat /sys/class/power_supply/*/online').then(process => Number(process.stdout.trim()));

//? Notifications
// Sends the embed to Discord for notifications
const notify = (data, variables) => sendDiscordWebhook({ embeds: [embedify(data, variables)] });

// TODO: Optimize this code someday
// Properly formats user configured embed
const embedify = (embed, variables) => {
    embed = Object.create(embed);
    
    // Title
    embed.title = stringInject(embed.title, variables);
    
    // Description
    embed.description = stringInject(embed?.description, variables);

    // URL
    embed.url = stringInject(embed?.url, variables);

    // Footer
    embed.footer = stringInject(embed?.footer, variables);

    // Image
    embed.image = stringInject(embed?.image, variables);

    // Thumbnail
    embed.thumbnail = stringInject(embed?.thumbnail, variables);

    // Author
    embed.author = stringInject(embed?.author, variables);

    // Fields
    embed.fields = stringInject(embed?.fields, variables);

    // Format timestamp
    if (embed.timestamp) embed.timestamp = new Date().toISOString();

    // HEX Color to hexadecimal
    if (embed.color) embed.color = parseInt(embed.color.replace("#", ""), 16);

    return embed;
};

//? Checkers
const adapterCheck = async () => {
    // Get battery percentage
    const batteryPercentage = await getBatteryPercentage();
    
    // Notify the user that the adapter is plugged in
    if (!userNotified.systemCharging) {
        // Send a Discord webhook
        log("Sending Discord webhook..", true);
        await notify(config.notifications.systemCharging, { batteryPercentage })
            .then(() => { userNotified.systemCharging = true; log("Discord webhook sent!", true); })
            .catch(error => log(`Failed to send Discord message! ${error.message || error.stack || error}`, true));
    }

    // TODO: Make the function work again
    // Notify the user with details when the adapter is plugged in
    // if (lastBatteryPercentage && lastPluggedIn) {
    //     unpluggedTime =  ms(new Date() - lastPluggedIn, { long: true })

    //     // Send a Discord webhook
    //     await notify(config.notifications.adapterUnpluggedDetails, { batteryPercentage, lastBatteryPercentage, unpluggedTime })
    //     .then(() => userNotified.systemCharging = true)
    //     .catch(error => log(`Failed to send Discord message! ${error.message || error.stack || error}`, true));

    //     lastBatteryPercentage,
    //     lastPluggedIn = undefined;
    // }
};

const batteryCheck = async () => {
    // Get battery percentage
    const batteryPercentage = await getBatteryPercentage();

    // If lastPluggedIn variable is not set, notify the user that the adapter has been unplugged
    if (!(lastPluggedIn && userNotified.adapterUnplugged))
        await notify(config.notifications.adapterUnplugged, { batteryPercentage })
            .then(() => userNotified.adapterUnplugged = true)
            .catch(error => log(`Failed to send Discord message! ${error.message || error.stack || error}`, true));

    // Set lastPluggedIn variable if it's not set
    if (!lastPluggedIn)
        lastPluggedIn = Date.now();

    // If the battery percentage is bigger than minimal percentage, cancel
    if (batteryPercentage > config.batteryPercentageMinimal)
        return log("Battery percentage is higher than values, skipping..", true);

    // Log battery percentage decreasing or increasing
    if (options.debug && batteryPercentage !== lastBatteryPercentage) {
        lastBatteryPercentage = batteryPercentage;
        log(`Battery percentage ${batteryPercentage >= lastBatteryPercentage ? "increased" : "decreased"} to ${batteryPercentage}%`, true);
    }

    // If battery percentage is below minimal and higher than critical, report it
    if (batteryPercentage <= config.batteryPercentageMinimal && batteryPercentage > config.batteryPercentageCritical && !userNotified.minimalBatteryPercentage) {
        log("Battery percentage is below minimum");

        // Send a Discord webhook
        log("Sending Discord webhook", true);
        await notify(config.notifications.adapterUnplugged, { batteryPercentage })
            .then(() => userNotified.minimalBatteryPercentage = true)
            .catch(error => log(`Failed to send Discord message! ${error.message || error.stack || error}`, true));
    }

    // If battery percentage is below critical, report it and shutdown the system
    if (batteryPercentage <= config.batteryPercentageCritical) {
        log("A critical percentage has been reached in the battery");
        
        // Send a Discord webhook
        if (!userNotified.criticalBatteryPercentage) {
            log("Sending Discord webhook", true);
            await notify(config.notifications.batteryAtCriticalLevel, { batteryPercentage, batteryPercentageCritical: config.batteryPercentageCritical })
                .then(() => userNotified.criticalBatteryPercentage = true)
                .catch(error => log(`Failed to send Discord message! ${error.message || error.stack || error}`, true));
        }

        log("Due to battery percentage being at critical, the system will be shut down..");
        
        // TODO: Turn on fallback machine through WOL if configured before shutting down

        // Shutdown the system
        shutdownSystem();
    }
};

//? Application function
const start = async () => {
    const systemCharging = !!(await isSystemCharging());

    // If last state doesn't equal the one now, reset variables
    if (lastState != systemCharging) resetVariables();
    lastState = systemCharging;

    // If the system isn't charging, check battery
    if (!systemCharging) return batteryCheck();
    
    // If the system is charging, log and check adapter
    log("System is charging, skipping battery check..", true);
    return adapterCheck();
};

// Starts the application function every 2.5 seconds
setInterval(() => start(), 2500);