#!/usr/bin/env node

import { CursorUsageTracker } from './src/app.js';
import { CONFIG } from './src/config/constants.js';

async function main() {
    const tracker = new CursorUsageTracker();
    global.tracker = tracker;

    try {
        console.log('Starting Cursor Usage Tracker...');
        console.log(`Dashboard will be available at: http://localhost:${CONFIG.WEB_PORT}`);
        console.log(`Collection interval: ${CONFIG.COLLECTION_INTERVAL / 1000} seconds`);
        console.log(`Headless mode: ${CONFIG.HEADLESS ? 'enabled' : 'disabled'}`);
        console.log('');

        await tracker.initialize();
        await tracker.start();

        console.log('Tracker started successfully!');
        console.log('Press Ctrl+C to stop the tracker');

    } catch (error) {
        console.error('Failed to start tracker:', error.message);
        process.exit(1);
    }
}

main();
