import fs from 'fs/promises';
import path from 'path';
import { CONFIG, PATHS } from '../config/constants.js';
import { Logger } from '../utils/logger.js';

export class DataStorage {
    constructor() {
        this.logger = new Logger('DataStorage');
    }

    async initialize() {
        try {
            // Создаем директорию для данных если её нет
            await fs.mkdir(PATHS.DATA_DIR, { recursive: true });
            this.logger.info(`Data directory initialized: ${PATHS.DATA_DIR}`);
        } catch (error) {
            this.logger.error('Failed to initialize data directory:', error);
            throw error;
        }
    }

    async saveUsageData(data, isIncremental = false, lastSyncDate = null) {
        try {
            this.logger.info(`Saving ${data.length} usage events (incremental: ${isIncremental})...`);

            let existingData = null;
            if (isIncremental) {
                existingData = await this.loadUsageData();
            }

            // Определяем lastSyncDate
            let syncDate;
            if (isIncremental) {
                // При инкрементальной синхронизации обновляем на текущее время
                syncDate = Date.now().toString();
            } else {
                // При полной синхронизации берем самую свежую дату из загруженных событий
                if (data.length > 0) {
                    // Сортируем события по дате (новые сверху) и берем самую свежую
                    const sortedEvents = [...data].sort((a, b) => new Date(b.date) - new Date(a.date));
                    const newestEvent = sortedEvents[0];
                    syncDate = new Date(newestEvent.date).getTime().toString();
                } else {
                    syncDate = Date.now().toString();
                }
            }

            // Добавляем метаданные
            const dataWithMeta = {
                timestamp: new Date().toISOString(),
                lastSyncDate: syncDate,
                totalEvents: data.length,
                syncMetadata: {
                    lastSuccessfulSync: new Date().toISOString(),
                    adaptivePageSize: existingData?.syncMetadata?.adaptivePageSize || 500,
                    syncStrategy: isIncremental ? 'incremental' : 'full'
                },
                events: data
            };

            // Сохраняем данные
            await fs.writeFile(
                PATHS.USAGE_DATA_FILE,
                JSON.stringify(dataWithMeta, null, 2),
                'utf8'
            );

            this.logger.info(`Usage data saved to: ${PATHS.USAGE_DATA_FILE}`);

            // Обновляем статистику
            await this.updateStats(data);

        } catch (error) {
            this.logger.error('Failed to save usage data:', error);
            throw error;
        }
    }

    async loadUsageData() {
        try {
            const data = await fs.readFile(PATHS.USAGE_DATA_FILE, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.logger.info('No existing usage data found');
                return null;
            }
            this.logger.error('Failed to load usage data:', error);
            throw error;
        }
    }

    async updateStats(data) {
        try {
            const stats = this.calculateStats(data);

            await fs.writeFile(
                PATHS.STATS_FILE,
                JSON.stringify(stats, null, 2),
                'utf8'
            );

            this.logger.info('Statistics updated');

        } catch (error) {
            this.logger.error('Failed to update stats:', error);
        }
    }

    calculateStats(data) {
        const stats = {
            timestamp: new Date().toISOString(),
            totalEvents: data.length,
            totalTokens: 0,
            totalCost: 0,
            byModel: {},
            byKind: {},
            byDate: {},
            recentEvents: []
        };

        // Обрабатываем каждое событие
        data.forEach(event => {
            // Общие счетчики
            stats.totalTokens += event.tokens || 0;

            // Используем правильную стоимость из costInfo
            let eventCost = 0;
            if (event.costInfo && event.costInfo.originalCost) {
                eventCost = event.costInfo.originalCost;
            } else {
                eventCost = event.cost || 0;
            }
            stats.totalCost += eventCost;

            // По моделям
            const model = event.model || 'unknown';
            if (!stats.byModel[model]) {
                stats.byModel[model] = {
                    count: 0,
                    tokens: 0,
                    cost: 0,
                    credits: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0
                };
            }
            stats.byModel[model].count++;
            stats.byModel[model].tokens += event.tokens || 0;
            stats.byModel[model].cost += eventCost;
            stats.byModel[model].credits += event.credits || 0;

            // Детальные токены
            if (event.tokenUsage) {
                stats.byModel[model].inputTokens += event.tokenUsage.inputTokens || 0;
                stats.byModel[model].outputTokens += event.tokenUsage.outputTokens || 0;
                stats.byModel[model].cacheReadTokens += event.tokenUsage.cacheReadTokens || 0;
                stats.byModel[model].cacheWriteTokens += event.tokenUsage.cacheWriteTokens || 0;
            }

            // По типам
            const kind = event.kind || 'unknown';
            if (!stats.byKind[kind]) {
                stats.byKind[kind] = {
                    count: 0,
                    tokens: 0,
                    cost: 0,
                    credits: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0
                };
            }
            stats.byKind[kind].count++;
            stats.byKind[kind].tokens += event.tokens || 0;
            stats.byKind[kind].cost += eventCost;
            stats.byKind[kind].credits += event.credits || 0;

            // Детальные токены
            if (event.tokenUsage) {
                stats.byKind[kind].inputTokens += event.tokenUsage.inputTokens || 0;
                stats.byKind[kind].outputTokens += event.tokenUsage.outputTokens || 0;
                stats.byKind[kind].cacheReadTokens += event.tokenUsage.cacheReadTokens || 0;
                stats.byKind[kind].cacheWriteTokens += event.tokenUsage.cacheWriteTokens || 0;
            }

            // По датам
            const date = new Date(event.date).toISOString().split('T')[0];
            if (!stats.byDate[date]) {
                stats.byDate[date] = { count: 0, tokens: 0, cost: 0 };
            }
            stats.byDate[date].count++;
            stats.byDate[date].tokens += event.tokens || 0;
            stats.byDate[date].cost += eventCost;
        });

        // Сортируем по дате и берем последние 10 событий
        stats.recentEvents = data
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .slice(0, 10)
            .map(event => ({
                id: event.id,
                date: event.date,
                model: event.model,
                kind: event.kind,
                kindDisplay: event.kindDisplay,
                tokens: event.tokens,
                cost: event.cost,
                tokenUsage: event.tokenUsage,
                costInfo: event.costInfo,
                credits: event.credits
            }));

        return stats;
    }

    async loadStats() {
        try {
            const data = await fs.readFile(PATHS.STATS_FILE, 'utf8');
            const stats = JSON.parse(data);

            // Пересчитываем статистику с правильными данными
            const usageData = await this.loadUsageData();
            if (usageData && usageData.events) {
                const recalculatedStats = this.calculateStats(usageData.events);
                // Сохраняем пересчитанную статистику
                await fs.writeFile(
                    PATHS.STATS_FILE,
                    JSON.stringify(recalculatedStats, null, 2),
                    'utf8'
                );
                return recalculatedStats;
            }

            return stats;
        } catch (error) {
            if (error.code === 'ENOENT') {
                this.logger.info('No existing stats found');
                return null;
            }
            this.logger.error('Failed to load stats:', error);
            throw error;
        }
    }

    async mergeUsageData(newData, isIncremental = false) {
        try {
            // Загружаем существующие данные
            const existingData = await this.loadUsageData();

            if (!existingData || !isIncremental) {
                // Если нет существующих данных или полная синхронизация, сохраняем новые
                await this.saveUsageData(newData, isIncremental);
                return;
            }

            // Создаем Set существующих ID для быстрой проверки дубликатов
            const existingIds = new Set(existingData.events.map(event => event.id));

            // Фильтруем новые события (убираем дубликаты)
            const uniqueNewData = newData.filter(event => !existingIds.has(event.id));

            if (uniqueNewData.length === 0) {
                this.logger.info('No new events to merge');
                return;
            }

            this.logger.info(`Merging ${uniqueNewData.length} new events (filtered from ${newData.length})`);

            // Объединяем данные: новые события в начале (самые свежие сверху)
            const mergedEvents = [...uniqueNewData, ...existingData.events];

            // Сортируем по дате (новые сверху)
            mergedEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

            // Сохраняем объединенные данные
            await this.saveUsageData(mergedEvents, true, existingData.lastSyncDate);

        } catch (error) {
            this.logger.error('Failed to merge usage data:', error);
            throw error;
        }
    }

    async appendUsageData(newData) {
        // Перенаправляем на новый метод mergeUsageData
        await this.mergeUsageData(newData, false);
    }

    async getSyncMetadata() {
        try {
            const data = await this.loadUsageData();
            if (!data) {
                return {
                    lastSyncDate: null,
                    adaptivePageSize: 500,
                    syncStrategy: 'full'
                };
            }

            return {
                lastSyncDate: data.lastSyncDate,
                adaptivePageSize: data.syncMetadata?.adaptivePageSize || 500,
                syncStrategy: data.syncMetadata?.syncStrategy || 'full',
                lastSuccessfulSync: data.syncMetadata?.lastSuccessfulSync
            };
        } catch (error) {
            this.logger.error('Failed to get sync metadata:', error);
            return {
                lastSyncDate: null,
                adaptivePageSize: 500,
                syncStrategy: 'full'
            };
        }
    }

    async updateAdaptivePageSize(responseTime, eventsCount) {
        try {
            const data = await this.loadUsageData();
            if (!data || !data.syncMetadata) return;

            // Адаптивная логика: если ответ быстрый - увеличиваем, если медленный - уменьшаем
            const currentPageSize = data.syncMetadata.adaptivePageSize || 500;
            let newPageSize = currentPageSize;

            if (responseTime < 1000 && eventsCount === currentPageSize) {
                // Быстрый ответ и полная страница - увеличиваем
                newPageSize = Math.min(currentPageSize * 1.5, 1000);
            } else if (responseTime > 3000) {
                // Медленный ответ - уменьшаем
                newPageSize = Math.max(currentPageSize * 0.7, 100);
            }

            if (newPageSize !== currentPageSize) {
                data.syncMetadata.adaptivePageSize = Math.round(newPageSize);
                await fs.writeFile(
                    PATHS.USAGE_DATA_FILE,
                    JSON.stringify(data, null, 2),
                    'utf8'
                );
                this.logger.info(`Updated adaptive page size: ${currentPageSize} → ${Math.round(newPageSize)}`);
            }
        } catch (error) {
            this.logger.error('Failed to update adaptive page size:', error);
        }
    }

    async saveUserInfo(userInfo) {
        try {
            if (!userInfo || typeof userInfo !== 'object') {
                this.logger.warn('Invalid user info provided:', userInfo);
                return;
            }

            const userInfoPath = path.join(PATHS.DATA_DIR, 'user_info.json');
            const userInfoData = {
                timestamp: new Date().toISOString(),
                ...userInfo
            };

            const jsonString = JSON.stringify(userInfoData, null, 2);
            this.logger.info('Saving user info to:', userInfoPath);
            this.logger.info('Data to save:', jsonString);

            await fs.writeFile(userInfoPath, jsonString, 'utf8');
            this.logger.info('User info saved successfully');
        } catch (error) {
            this.logger.error('Failed to save user info:', error);
        }
    }

    async loadUserInfo() {
        try {
            const userInfoPath = path.join(PATHS.DATA_DIR, 'user_info.json');
            if (await fs.access(userInfoPath).then(() => true).catch(() => false)) {
                const data = await fs.readFile(userInfoPath, 'utf8');
                return JSON.parse(data);
            }
            return null;
        } catch (error) {
            this.logger.error('Failed to load user info:', error);
            return null;
        }
    }

    async cleanupOldData(daysToKeep = 30) {
        try {
            const data = await this.loadUsageData();
            if (!data || !data.events || data.events.length === 0) return;

            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

            const filteredEvents = data.events.filter(event => {
                return new Date(event.date) >= cutoffDate;
            });

            if (filteredEvents.length < data.events.length) {
                this.logger.info(`Cleaning up ${data.events.length - filteredEvents.length} old events`);
                await this.saveUsageData(filteredEvents);
            }

        } catch (error) {
            this.logger.error('Failed to cleanup old data:', error);
        }
    }
}
