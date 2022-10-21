#!/usr/bin/node
const { promisify } = require("util");
const execute = promisify(require("child_process").exec);
const https = require("https");
const fs = require("fs");
const ms = require("ms");

const processArguments = process.argv.slice(2);
const options = {
    debug: processArguments.find(value => value === "-v") || false,
    configPath: processArguments.find(value => value === "--config=")?.replace("--config=", "") || "/etc/default/batterymonitor",
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
    }, () => resolve());

    request.on("error", error => reject(error));
    
    request.write(webhookData);
    request.end();
});

// Turns off the system
const shutdownSystem = () => "";
//! const shutdownSystem = () => execute('/usr/sbin/poweroff');

//? Getters
// Returns battery percentage
const getBatteryPercentage = async () => execute('cat /sys/class/power_supply/*/capacity').then(process => Number(process.stdout.trim()));

// Returns if system is charging
const isSystemCharging = async () => execute('cat /sys/class/power_supply/*/online').then(process => Number(process.stdout.trim()));

//? Checkers
const adapterCheck = async () => {
    // Get battery percentage
    const batteryPercentage = await getBatteryPercentage();
    
    // Notify the user that adapter is plugged in
    if (!userNotified.systemCharging) {
        if (options.debug) console.log("[DEBUG] Sending Discord webhook");

        // Send a Discord webhook
        await sendDiscordWebhook({
            embeds: [
                {
                    timestamp: new Date().toISOString(),
                    color: Colors.Green,
                    title: "System is charging!",
                }
            ]
        })
        .then(() => userNotified.systemCharging = true)
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message}`) : undefined);
    }

    // Notify the user with details when the adapter is plugged in
    if (lastBatteryPercentage && lastPluggedIn) {
        // Send a Discord webhook
        await sendDiscordWebhook({
            embeds: [
                {
                    timestamp: new Date().toISOString(),
                    color: Colors.Green,
                    title: "Details while the system was unplugged",
                    description: `**Current percentage:** ${batteryPercentage}%\n**Lowest battery percentage:** ${lastBatteryPercentage}%\n**System unplugged time:** ${ms(new Date() - lastPluggedIn, { long: true })}`,
                }
            ]
        })
        .then(() => userNotified.systemCharging = true)
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message}`) : undefined);

        lastBatteryPercentage = undefined;
        lastPluggedIn = undefined;
    }
};

const batteryCheck = async () => {
    // Get battery percentage
    const batteryPercentage = await getBatteryPercentage();

    // If lastPluggedIn variable is not set, notify the user that the adapter has been unplugged
    if (!(lastPluggedIn && userNotified.adapterUnplugged))
        await sendDiscordWebhook({
            embeds: [
                {
                    timestamp: new Date().toISOString(),
                    color: Colors.Red,
                    title: "The adapter charger has been unplugged!",
                    description: `**Current battery percentage:** ${batteryPercentage}%`,
                }
            ]
        })
        .then(() => userNotified.adapterUnplugged = true)
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message}`) : undefined);

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
        await sendDiscordWebhook({
            embeds: [
                {
                    timestamp: new Date().toISOString(),
                    color: Colors.Red,
                    title: "Battery percentage is below minimum!",
                    description: `**Current battery percentage:** ${batteryPercentage}%\n**Minimal battery percentage:** ${config.batteryPercentageMinimal}%\n**Critical battery percentage:** ${config.batteryPercentageCritical}%`,
                }
            ]
        })
        .then(() => userNotified.minimalBatteryPercentage = true)
        .catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message}`) : undefined);
    }

    // If battery percentage is below critical then report it and shutdown the system
    if (batteryPercentage <= config.batteryPercentageCritical) {
        console.log("A critical percentage has been reached in the battery");
        
        if (options.debug && !userNotified.criticalBatteryPercentage) console.log("[DEBUG] Sending Discord webhook");
        // Send a Discord webhook
        if (!userNotified.criticalBatteryPercentage) await sendDiscordWebhook({ embeds: [{ timestamp: new Date().toISOString(), color: Colors.Dark_Red, title: "Battery percentage is at critical percentage, system shutting down!", description: `**Current battery percentage:** ${batteryPercentage}%\n**Critical battery percentage:** ${config.batteryPercentageCritical}%`, }] }).then(() => userNotified.criticalBatteryPercentage = true).catch(error => options.debug ? console.log(`[DEBUG] Failed to send Discord message! ${error.message}`) : undefined);

        console.log("Due to battery percentage being at critical, the system will be shut down..");
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