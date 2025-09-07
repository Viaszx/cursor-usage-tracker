#!/usr/bin/env node

import { WebServer } from './src/web/web_server.js';

async function main() {
    const webServer = new WebServer();

    try {
        console.log('Starting Cursor Usage Tracker Web Server...');
        await webServer.startStandalone();
        console.log('Press Ctrl+C to stop the server');

    } catch (error) {
        console.error('Failed to start web server:', error.message);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    process.exit(0);
});

main();

