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
            await this.updateStats(dataWithMeta.events);

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

    async updateStats(events) {
        try {
            const stats = this.calculateStats(events);

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
            estimatedCost: 0,
            totalMaxMode: 0,
            byModel: {},
            byKind: {},
            byDate: {},
            recentEvents: []
        };

        // Обрабатываем каждое событие
        data.forEach(event => {
            // Общие счетчики
            stats.totalTokens += event.tokens || 0;

            // Проверяем maxMode в разных местах (приоритет у rawData)
            let maxMode = false;
            if (event.rawData && event.rawData.maxMode !== undefined) {
                maxMode = event.rawData.maxMode;
            } else if (event.maxMode !== undefined) {
                maxMode = event.maxMode;
            }

            if (maxMode) {
                stats.totalMaxMode++;
            }

            // Используем правильную стоимость из costInfo
            let eventCost = 0;
            if (event.costInfo && event.costInfo.originalCost) {
                eventCost = event.costInfo.originalCost;
            } else {
                eventCost = event.cost || 0;
            }

            // Добавляем к общей стоимости только если событие было оплачено
            if (event.kind !== 'errored_not_charged' && event.kind !== 'USAGE_EVENT_KIND_ERRORED_NOT_CHARGED') {
                stats.totalCost += eventCost;
            }

            // Estimated Cost включает все события (включая errored)
            stats.estimatedCost += eventCost;

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
                    cacheWriteTokens: 0,
                    maxMode: 0
                };
            }
            stats.byModel[model].count++;
            stats.byModel[model].tokens += event.tokens || 0;
            // Добавляем стоимость только если событие было оплачено
            if (event.kind !== 'errored_not_charged' && event.kind !== 'USAGE_EVENT_KIND_ERRORED_NOT_CHARGED') {
                stats.byModel[model].cost += eventCost;
            }
            stats.byModel[model].credits += event.credits || 0;
            if (maxMode) {
                stats.byModel[model].maxMode++;
            }

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
                    cacheWriteTokens: 0,
                    maxMode: 0
                };
            }
            stats.byKind[kind].count++;
            stats.byKind[kind].tokens += event.tokens || 0;
            // Всегда добавляем стоимость для отображения по типам
            stats.byKind[kind].cost += eventCost;
            stats.byKind[kind].credits += event.credits || 0;
            if (maxMode) {
                stats.byKind[kind].maxMode++;
            }

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
            .map(event => {
                // Определяем maxMode с правильным приоритетом (как в основном цикле)
                let maxMode = false;
                if (event.rawData && event.rawData.maxMode !== undefined) {
                    maxMode = event.rawData.maxMode;
                } else if (event.maxMode !== undefined) {
                    maxMode = event.maxMode;
                }

                return {
                    id: event.id,
                    date: event.date,
                    model: event.model,
                    kind: event.kind,
                    kindDisplay: event.kindDisplay,
                    tokens: event.tokens,
                    cost: event.cost,
                    tokenUsage: event.tokenUsage,
                    costInfo: event.costInfo,
                    credits: event.credits,
                    maxMode: maxMode
                };
            });

        return stats;
    }

    async loadStats() {
        try {
            const data = await fs.readFile(PATHS.STATS_FILE, 'utf8');
            const stats = JSON.parse(data);
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

            // Получаем активные события для проверки обновлений
            const activeEvents = this.getActiveEvents(existingData.events);
            // this.logger.info(`Checking ${activeEvents.length} active events for updates`);

            // Создаем Map новых событий для быстрого поиска
            const newEventsMap = new Map(newData.map(event => [event.id, event]));

            let newEvents = [];
            let updatedEvents = 0;

            // 1. Проверяем активные события на предмет обновлений
            for (const activeEvent of activeEvents) {
                // Ищем событие по timestamp (первая часть ID до подчеркивания)
                const activeTimestamp = activeEvent.id.split('_')[0];
                const updatedEvent = Array.from(newEventsMap.values()).find(event =>
                    event.id && event.id.startsWith(activeTimestamp)
                );

                if (updatedEvent) {
                    // Событие есть в новых данных - проверяем обновления
                    // this.logger.info(`Checking active event ${activeEvent.id} for updates...`);
                    if (this.isEventUpdated(activeEvent, updatedEvent)) {
                        this.logger.info(`Event ${activeEvent.id} updated: credits ${activeEvent.credits} → ${updatedEvent.credits}`);
                        updatedEvents++;
                        // Заменяем старое событие новым
                        const eventIndex = existingData.events.findIndex(e => e.id === activeEvent.id);
                        if (eventIndex !== -1) {
                            existingData.events[eventIndex] = updatedEvent;
                        }
                    } else {
                        // this.logger.info(`Event ${activeEvent.id} unchanged`);
                    }
                }
            }

            // 2. Добавляем новые события (которых нет в существующих данных)
            const existingIds = new Set(existingData.events.map(event => event.id));
            const existingTimestamps = new Set(existingData.events.map(event => event.id.split('_')[0]));

            for (const newEvent of newData) {
                const newTimestamp = newEvent.id.split('_')[0];
                // Проверяем, что события нет ни по полному ID, ни по timestamp
                if (!existingIds.has(newEvent.id) && !existingTimestamps.has(newTimestamp)) {
                    newEvents.push(newEvent);
                }
            }

            if (newEvents.length === 0 && updatedEvents === 0) {
                this.logger.info('No new or updated events to merge');
                return;
            }

            this.logger.info(`Merging ${newEvents.length} new events and ${updatedEvents} updated events`);

            // Объединяем данные: новые события в начале (самые свежие сверху)
            const mergedEvents = [...newEvents, ...existingData.events];

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

    getActiveEvents(events) {
        if (!events || events.length === 0) return [];

        const now = Date.now();
        const checkHours = CONFIG.ACTIVE_EVENTS_CHECK_HOURS;
        const checkMs = checkHours * 60 * 60 * 1000;
        const cutoffTime = now - checkMs;

        // this.logger.info(`Filtering events: now=${now}, cutoffTime=${cutoffTime}, checkHours=${checkHours}`);
        // this.logger.info(`Cutoff time as date: ${new Date(cutoffTime).toISOString()}`);

        // Фильтруем события по времени
        const timeFilteredEvents = events.filter(event => {
            try {
                const eventTime = new Date(event.date).getTime();
                const isRecent = eventTime >= cutoffTime;
                // if (!isRecent) {
                //     this.logger.debug(`Event ${event.id} too old: ${event.date} (${eventTime}) < ${cutoffTime}`);
                // } else {
                //     this.logger.debug(`Event ${event.id} is recent: ${event.date} (${eventTime}) >= ${cutoffTime}`);
                // }
                return isRecent;
            } catch (error) {
                this.logger.error(`Failed to parse event date: ${event.date}`, error);
                return false;
            }
        });

        // this.logger.info(`Time filtered events: ${timeFilteredEvents.length} out of ${events.length}`);

        // Берем последние N событий (что больше)
        const maxCount = CONFIG.ACTIVE_EVENTS_MAX_COUNT;
        const activeEvents = timeFilteredEvents.length > maxCount
            ? timeFilteredEvents.slice(0, maxCount)
            : timeFilteredEvents;

        // this.logger.info(`Active events: ${activeEvents.length} (maxCount=${maxCount})`);

        return activeEvents;
    }

    isEventUpdated(existingEvent, newEvent) {
        // Проверяем, что это одно и то же событие по timestamp
        const existingTimestamp = existingEvent.id.split('_')[0];
        const newTimestamp = newEvent.id.split('_')[0];
        if (existingTimestamp !== newTimestamp) return false;

        // Сравниваем ключевые поля
        const fieldsToCompare = [
            'credits',
            'tokens',
            'cost',
            'kind',
            'model'
        ];

        for (const field of fieldsToCompare) {
            if (existingEvent[field] !== newEvent[field]) {
                this.logger.info(`Field ${field} changed: ${existingEvent[field]} → ${newEvent[field]}`);
                return true;
            }
        }

        // Дополнительное логирование для отладки (отключено)
        // this.logger.debug(`Comparing events: existing=${existingEvent.id}, new=${newEvent.id}`);
        // this.logger.debug(`Existing credits: ${existingEvent.credits}, new credits: ${newEvent.credits}`);
        // this.logger.debug(`Existing tokens: ${existingEvent.tokens}, new tokens: ${newEvent.tokens}`);

        // Проверяем tokenUsage
        if (existingEvent.tokenUsage && newEvent.tokenUsage) {
            const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
            for (const field of tokenFields) {
                if (existingEvent.tokenUsage[field] !== newEvent.tokenUsage[field]) {
                    this.logger.info(`Token field ${field} changed: ${existingEvent.tokenUsage[field]} → ${newEvent.tokenUsage[field]}`);
                    return true;
                }
            }
        }

        // Проверяем costInfo
        if (existingEvent.costInfo && newEvent.costInfo) {
            const costFields = ['originalCost', 'discountedCost', 'discount'];
            for (const field of costFields) {
                if (existingEvent.costInfo[field] !== newEvent.costInfo[field]) {
                    this.logger.info(`Cost field ${field} changed: ${existingEvent.costInfo[field]} → ${newEvent.costInfo[field]}`);
                    return true;
                }
            }
        }

        return false;
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
