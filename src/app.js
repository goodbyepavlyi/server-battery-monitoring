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

if (!fs.existsSync(options.configPath))
    fs.writeFileSync(options.configPath, JSON.stringify({
        discordWebhookID: "REPLACE",        
        discordWebhookToken: "REPLACE",        
        batteryPercentageMinimal: 30,
        batteryPercentageCritical: 10,
    }, null, 2));

const config = JSON.parse(fs.readFileSync(options.configPath));

//? Variables
const Colors = {
    Green: parseInt("1ed760", 16),
    Red: parseInt("ec7979", 16),
    Dark_Red: parseInt("462224", 16),
};

let userNotified = { minimalBatteryPercentage: false, criticalBatteryPercentage: false, systemCharging: false, adapterUnplugged: false, },
    lastState, lastBatteryPercentage, lastPluggedIn;

const resetVariables = () => {
    userNotified = { minimalBatteryPercentage: false, criticalBatteryPercentage: false, systemCharging: false, adapterUnplugged: false, };
    lastState = undefined;
}

//? Functions
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
        if (response.statusCode != 204 && response.statusCode != 200) reject(`Discord API returned ${response.statusCode} (${response.statusMessage})`)

        resolve();
    });

    request.on("error", error => reject(error));
    
    request.write(webhookData);
    request.end();
});


// Turns off the system
const shutdownSystem = () => execute('/usr/sbin/poweroff');

//? Getters
// Returns battery percentage
const getBatteryPercentage = async () => execute('cat /sys/class/power_supply/*/capacity').then(process => Number(process.stdout.trim()));

// Returns if system is charging
const isSystemCharging = async () => execute('cat /sys/class/power_supply/*/online').then(process => Number(process.stdout.trim()));

//? Notifications
// TODO: Turn this into single function
// TODO: Make this customizable in config
const notificationSystemCharging = () => sendDiscordWebhook({
    embeds: [
        {
            timestamp: new Date().toISOString(),
            color: Colors.Green,
            title: "System is charging!",
        }
    ]
});

const notificationSystemDetails = (batteryPercentage) => sendDiscordWebhook({
    embeds: [
        {
            timestamp: new Date().toISOString(),
            color: Colors.Green,
            title: "Details while the system was unplugged",
            description: `**Current percentage:** ${batteryPercentage}%\n**Lowest battery percentage:** ${lastBatteryPercentage}%\n**System unplugged time:** ${ms(new Date() - lastPluggedIn, { long: true })}`,
        }
    ]
});

const notificationAdapterUnplugged = (batteryPercentage) => sendDiscordWebhook({
    embeds: [
        {
            timestamp: new Date().toISOString(),
            color: Colors.Red,
            title: "The adapter charger has been unplugged!",
            description: `**Current battery percentage:** ${batteryPercentage}%`,
        }
    ]
});

const notificationBatteryBelowMinimum = (batteryPercentage) => sendDiscordWebhook({
    embeds: [
        {
            timestamp: new Date().toISOString(),
            color: Colors.Red,
            title: "Battery percentage is below minimum!",
            description: `**Current battery percentage:** ${batteryPercentage}%\n**Minimal battery percentage:** ${config.batteryPercentageMinimal}%\n**Critical battery percentage:** ${config.batteryPercentageCritical}%`,
        }
    ]
});

//? Checkers
const adapterCheck = async () => {
    // Get battery percentage
    const batteryPercentage = await getBatteryPercentage();
    
    // Notify the user that adapter is plugged in
    if (!userNotified.systemCharging) {
        if (options.debug) console.log("[DEBUG] Sending Discord webhook");

        // Send a Discord webhook
        await notificationSystemCharging()
        .then(() => userNotified.systemCharging = true && options.debug ? console.log("[DEBUG] Discord webhook sent!") : '')
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message || error.stack || error}`) : undefined);
    }

    // Notify the user with details when the adapter is plugged in
    if (lastBatteryPercentage && lastPluggedIn) {
        // Send a Discord webhook
        await notificationSystemDetails(batteryPercentage)
        .then(() => userNotified.systemCharging = true)
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message || error.stack || error}`) : undefined);

        lastBatteryPercentage = undefined;
        lastPluggedIn = undefined;
    }
};

const batteryCheck = async () => {
    // Get battery percentage
    const batteryPercentage = await getBatteryPercentage();

    // If lastPluggedIn variable is not set, notify the user that the adapter has been unplugged
    if (!(lastPluggedIn && userNotified.adapterUnplugged))
        await notificationAdapterUnplugged(batteryPercentage)
        .then(() => userNotified.adapterUnplugged = true)
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message || error.stack || error}`) : undefined);

    // Set lastPluggedIn variable if it's not set
    if (!lastPluggedIn) lastPluggedIn = Date.now();

    // If the battery percentage is bigger than minimal percentage
    if (batteryPercentage > config.batteryPercentageMinimal)
        return options.debug ? console.log("[DEBUG] Battery percentage is higher than values, skipping..") : undefined;

    // Log battery decreasing
    if (options.debug && batteryPercentage !== lastBatteryPercentage) {
        lastBatteryPercentage = batteryPercentage;
        console.log(`[DEBUG] Battery percentage ${batteryPercentage >= lastBatteryPercentage ? "increased" : "decreased"} to ${batteryPercentage}%`);
    }

    // If battery percentage is below minimal and higher than critical then report it
    if (batteryPercentage <= config.batteryPercentageMinimal && batteryPercentage > config.batteryPercentageCritical && !userNotified.minimalBatteryPercentage) {
        console.log("Battery percentage is below minimum");

        if (options.debug) console.log("[DEBUG] Sending Discord webhook");
        // Send a Discord webhook
        await notificationBatteryBelowMinimum(batteryPercentage)
        .then(() => userNotified.minimalBatteryPercentage = true)
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message || error.stack || error}`) : undefined);
    }

    // If battery percentage is below critical then report it and shutdown the system
    if (batteryPercentage <= config.batteryPercentageCritical) {
        console.log("A critical percentage has been reached in the battery");
        
        if (options.debug && !userNotified.criticalBatteryPercentage) console.log("[DEBUG] Sending Discord webhook");
        // Send a Discord webhook
        if (!userNotified.criticalBatteryPercentage) await sendDiscordWebhook({ embeds: [{ timestamp: new Date().toISOString(), color: Colors.Dark_Red, title: "Battery percentage is at critical percentage, system shutting down!", description: `**Current battery percentage:** ${batteryPercentage}%\n**Critical battery percentage:** ${config.batteryPercentageCritical}%`, }] }).then(() => userNotified.criticalBatteryPercentage = true).catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message || error.stack || error}`) : undefined);

        console.log("Due to battery percentage being at critical, the system will be shut down..");
        
        // TODO: Turn on fallback machine through WOL if configured before shutting down

        // Shutdown the system
        shutdownSystem();
    }
};

//? Application function
const start = async () => {
    const systemCharging = !!(await isSystemCharging());

    // If last state doesn't equal the one now then reset variables
    if (lastState != systemCharging) resetVariables();
    lastState = systemCharging;

    // If the system isn't charging then check battery
    if (!systemCharging) return batteryCheck();
    
    if (options.debug) console.log("[DEBUG] System is charging, skipping battery check..");
    // If the system is charging then check adapter
    return adapterCheck();
};

// Starts the application function every 2.5 seconds
setInterval(() => start(), 2500);