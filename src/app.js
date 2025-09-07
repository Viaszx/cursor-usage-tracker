import { BrowserManager } from './browser/browser_manager.js';
import { DataCollector } from './collectors/data_collector.js';
import { DataStorage } from './storage/data_storage.js';
import { WebServer } from './web/web_server.js';
import { CONFIG } from './config/constants.js';
import { Logger } from './utils/logger.js';

export class CursorUsageTracker {
    constructor() {
        this.logger = new Logger('CursorUsageTracker');
        this.browserManager = null;
        this.dataCollector = null;
        this.dataStorage = new DataStorage();
        this.webServer = new WebServer();
        this.isRunning = false;
        this.collectionInterval = null;
    }

    async initialize(cookies = null) {
        try {
            this.logger.info('Initializing Cursor Usage Tracker...');

            // Инициализируем хранилище данных
            await this.dataStorage.initialize();

            // Инициализируем браузер с cookies
            this.browserManager = new BrowserManager();
            await this.browserManager.initialize(cookies);

            // Инициализируем сборщик данных
            this.dataCollector = new DataCollector(this.browserManager, this.dataStorage, this.webServer);

            this.logger.info('Initialization completed successfully');

        } catch (error) {
            this.logger.error('Failed to initialize:', error);
            throw error;
        }
    }

    async start() {
        try {
            if (this.isRunning) {
                this.logger.warn('Tracker is already running');
                return;
            }

            this.logger.info('Starting Cursor Usage Tracker...');

            // Запускаем веб-сервер
            await this.webServer.start();

            // Выполняем первичный сбор данных
            await this.collectData();

            // Настраиваем периодический сбор данных
            this.setupPeriodicCollection();

            this.isRunning = true;
            this.logger.info('Tracker started successfully');

        } catch (error) {
            this.logger.error('Failed to start tracker:', error);
            throw error;
        }
    }

    async stop() {
        try {
            if (!this.isRunning) {
                this.logger.warn('Tracker is not running');
                return;
            }

            this.logger.info('Stopping Cursor Usage Tracker...');

            // Останавливаем периодический сбор
            if (this.collectionInterval) {
                clearInterval(this.collectionInterval);
                this.collectionInterval = null;
            }

            // Останавливаем веб-сервер
            await this.webServer.stop();

            // Закрываем браузер
            if (this.browserManager) {
                await this.browserManager.close();
            }

            this.isRunning = false;
            this.logger.info('Tracker stopped successfully');

        } catch (error) {
            this.logger.error('Failed to stop tracker:', error);
            throw error;
        }
    }

    async collectData() {
        try {
            this.logger.info('Starting data collection...');

            const data = await this.dataCollector.collectUsageData();

            if (data.length > 0) {
                // Данные уже сохранены в DataCollector через mergeUsageData
                this.logger.info(`Collected and saved ${data.length} events`);
            } else {
                this.logger.warn('No data collected');
            }

        } catch (error) {
            this.logger.error('Failed to collect data:', error);
            throw error;
        }
    }

    setupPeriodicCollection() {
        this.collectionInterval = setInterval(async () => {
            try {
                this.logger.info('Starting periodic data collection...');
                await this.collectData();
            } catch (error) {
                this.logger.error('Periodic collection failed:', error);
            }
        }, CONFIG.COLLECTION_INTERVAL);

        this.logger.info(`Periodic collection set up (interval: ${CONFIG.COLLECTION_INTERVAL}ms)`);
    }

    async runOnce() {
        try {
            this.logger.info('Running single data collection...');

            await this.initialize();
            await this.collectData();
            await this.stop();

            this.logger.info('Single run completed');

        } catch (error) {
            this.logger.error('Single run failed:', error);
            throw error;
        }
    }
}

// Обработка сигналов завершения
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    if (global.tracker) {
        await global.tracker.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    if (global.tracker) {
        await global.tracker.stop();
    }
    process.exit(0);
});

// Обработка необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});
