#!/usr/bin/env node

import { CursorUsageTracker } from './src/app.js';
import { CONFIG } from './src/config/constants.js';
import fs from 'fs/promises';

async function main() {
    try {
        // Пытаемся загрузить cookies из файла
        let cookies = null;
        try {
            const cookiesData = await fs.readFile('cookies.json', 'utf8');
            const parsed = JSON.parse(cookiesData);
            cookies = parsed.cookies;
            console.log(`Loaded ${cookies.length} cookies from cookies.json`);
        } catch (error) {
            console.log('No cookies.json found, using browser profile');
        }

        const tracker = new CursorUsageTracker();
        global.tracker = tracker;

        console.log('Starting Cursor Usage Tracker with cookies...');
        console.log(`Dashboard will be available at: http://localhost:${CONFIG.WEB_PORT}`);
        console.log(`Collection interval: ${CONFIG.COLLECTION_INTERVAL / 1000} seconds`);
        console.log(`Headless mode: ${CONFIG.HEADLESS ? 'enabled' : 'disabled'}`);
        console.log('');

        await tracker.initialize(cookies);
        await tracker.start();

        console.log('Tracker started successfully!');
        console.log('Press Ctrl+C to stop the tracker');

    } catch (error) {
        console.error('Failed to start tracker:', error.message);
        console.log('\nTips:');
        console.log('1. Run "node extract_cookies.js" to extract cookies from browser');
        console.log('2. Or set CHROME_USER_DATA_DIR in config.example.env');
        process.exit(1);
    }
}

main();
