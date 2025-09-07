import { CONFIG } from '../config/constants.js';
import { Logger } from '../utils/logger.js';
import { DataStorage } from '../storage/data_storage.js';

export class DataCollector {
    constructor(browserManager, dataStorage, webServer = null) {
        this.browserManager = browserManager;
        this.dataStorage = dataStorage;
        this.webServer = webServer;
        this.logger = new Logger('DataCollector');
    }

    async collectUsageData() {
        try {
            this.logger.info('Starting data collection...');

            // Навигация к странице
            await this.browserManager.navigateToDashboard();

            // Ожидание аутентификации
            const isAuthenticated = await this.browserManager.waitForAuthentication();
            if (!isAuthenticated) {
                throw new Error('Authentication required');
            }

            // Получение данных пользователя
            await this.collectUserInfo();

            // Получаем метаданные синхронизации
            const syncMetadata = await this.dataStorage.getSyncMetadata();
            const isIncremental = syncMetadata && syncMetadata.lastSyncDate && syncMetadata.lastSyncDate !== '0';

            this.logger.info(`Sync strategy: ${isIncremental ? 'incremental' : 'full'}`);
            if (isIncremental) {
                this.logger.info(`Last sync date: ${syncMetadata.lastSyncDate}`);
            }

            // Сбор данных через API
            let data = await this.collectFromAPI(syncMetadata);

            // Если инкрементальная синхронизация и нет новых событий, 
            // запрашиваем активные события для проверки обновлений
            if (isIncremental && data.length === 0) {
                this.logger.info('No new events found, checking active events for updates...');
                const activeEventsData = await this.collectActiveEventsForUpdates();
                data = activeEventsData;
            }

            if (data.length === 0) {
                this.logger.warn('No data collected from API, trying DOM extraction...');
                const domData = await this.collectFromDOM();
                return domData;
            }

            this.logger.info(`Collected ${data.length} usage events`);

            // Сливаем данные
            await this.dataStorage.mergeUsageData(data, isIncremental);

            // Уведомляем WebServer о новых данных
            if (this.webServer && data.length > 0) {
                await this.webServer.broadcastUpdate();
            }

            return data;

        } catch (error) {
            this.logger.error('Failed to collect usage data:', error);
            throw error;
        }
    }

    async collectFromAPI(syncMetadata = null) {
        try {
            this.logger.info('Collecting data from API...');

            const page = this.browserManager.page;
            if (!page) {
                throw new Error('Browser page not available');
            }

            // Ждем стабилизации страницы
            await page.waitForLoadState('networkidle');
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Получаем cookies
            const cookies = await page.context().cookies();
            const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

            // Собираем данные через events API
            const eventsData = await this.fetchAllEvents(page, cookieString, syncMetadata);

            // Парсим события
            const parsedData = eventsData.map(event => this.parseUsageEvent(event)).filter(Boolean);

            this.logger.info(`Collected ${parsedData.length} events from API`);
            return parsedData;

        } catch (error) {
            this.logger.error('API collection failed:', error);
            return [];
        }
    }

    async fetchAllEvents(page, cookieString, syncMetadata = null) {
        let allEvents = [];
        let pageNum = 1;
        let hasMore = true;

        // Определяем параметры синхронизации
        const isIncremental = syncMetadata && syncMetadata.lastSyncDate;
        const pageSize = syncMetadata?.adaptivePageSize || 500;

        this.logger.info(`Fetching events (incremental: ${isIncremental}, pageSize: ${pageSize})`);

        while (hasMore) {
            try {
                const startTime = Date.now();
                this.logger.info(`Fetching page ${pageNum}...`);

                // Определяем даты для запроса
                let startDate, endDate;
                if (isIncremental) {
                    // Инкрементальная синхронизация: от lastSyncDate до текущего времени
                    startDate = new Date(parseInt(syncMetadata.lastSyncDate));
                    endDate = new Date();
                } else {
                    // Полная синхронизация: загружаем все доступные события (без ограничений по датам)
                    endDate = new Date();
                    startDate = new Date(0); // 1970-01-01 - начало эпохи Unix
                }

                const response = await page.evaluate(async ({ url, teamId, pageNum, pageSize, cookieString, startDate, endDate }) => {
                    try {
                        // console.log(`Fetching page ${pageNum} with dates: ${startDate.toISOString()} to ${endDate.toISOString()}`);
                        const response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Accept': '*/*',
                                'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
                                'Content-Type': 'application/json',
                                'Priority': 'u=1, i',
                                'Referer': 'https://cursor.com/dashboard?tab=usage',
                                'Sec-CH-UA': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
                                'Sec-CH-UA-Arch': '"x86"',
                                'Sec-CH-UA-Bitness': '"64"',
                                'Sec-CH-UA-Mobile': '?0',
                                'Sec-CH-UA-Platform': '"Windows"',
                                'Sec-CH-UA-Platform-Version': '"19.0.0"',
                                'Sec-Fetch-Dest': 'empty',
                                'Sec-Fetch-Mode': 'cors',
                                'Sec-Fetch-Site': 'same-origin',
                                'User-Agent': navigator.userAgent,
                                'Cookie': cookieString
                            },
                            credentials: 'include',
                            body: JSON.stringify({
                                teamId,
                                startDate: startDate.getTime().toString(),
                                endDate: endDate.getTime().toString(),
                                page: pageNum,
                                pageSize
                            })
                        });

                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                        }

                        const data = await response.json();
                        // console.log(`Page ${pageNum} response:`, JSON.stringify(data, null, 2));
                        return data;
                    } catch (error) {
                        console.error('API request failed:', error);
                        return { usageEventsDisplay: [] };
                    }
                }, {
                    url: CONFIG.CURSOR_EVENTS_API,
                    teamId: 0,
                    pageNum,
                    pageSize,
                    cookieString,
                    startDate,
                    endDate
                });

                // Извлекаем события из usageEventsDisplay
                const events = response.usageEventsDisplay || [];
                const responseTime = Date.now() - startTime;

                // Обновляем адаптивный размер страницы
                if (syncMetadata) {
                    await this.dataStorage.updateAdaptivePageSize(responseTime, events.length);
                }

                if (events.length === 0) {
                    // Если нет новых событий - это нормально для инкрементальной синхронизации
                    if (isIncremental) {
                        this.logger.info('No new events found - this is normal for incremental sync');
                        hasMore = false;
                    } else {
                        // Для полной синхронизации - просто завершаем, если нет событий
                        this.logger.info('No events found in full sync - this may be normal if no data exists');
                        hasMore = false;
                    }
                } else {
                    allEvents = allEvents.concat(events);
                    pageNum++;

                    // Пауза между запросами
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

            } catch (error) {
                this.logger.error(`Failed to fetch page ${pageNum}:`, error);
                hasMore = false;
            }
        }

        return allEvents;
    }

    async collectActiveEventsForUpdates() {
        try {
            this.logger.info('Collecting active events for updates...');

            // Получаем активные события из локальной базы
            let existingData;
            try {
                existingData = await this.dataStorage.loadUsageData();
                this.logger.info('Successfully loaded existing data');
            } catch (error) {
                this.logger.error('Failed to load existing data:', error);
                return [];
            }

            if (!existingData || !existingData.events) {
                this.logger.info('No existing data to check for updates');
                return [];
            }

            // this.logger.info(`Loaded ${existingData.events.length} existing events`);

            let activeEvents;
            try {
                activeEvents = this.dataStorage.getActiveEvents(existingData.events);
                // this.logger.info('Successfully got active events');
            } catch (error) {
                this.logger.error('Failed to get active events:', error);
                return [];
            }

            if (activeEvents.length === 0) {
                this.logger.info('No active events to check for updates');
                return [];
            }

            // this.logger.info(`Found ${activeEvents.length} active events for updates`);

            // Получаем ID активных событий
            let activeEventIds;
            try {
                activeEventIds = activeEvents.map(event => event.id);
                // this.logger.info(`Active event IDs: ${activeEventIds.slice(0, 5).join(', ')}${activeEventIds.length > 5 ? '...' : ''}`);
            } catch (error) {
                this.logger.error('Failed to map active event IDs:', error);
                return [];
            }

            // Запрашиваем эти события с сервера
            const page = this.browserManager.page;
            if (!page) {
                throw new Error('Browser page not available');
            }

            // Проверяем, что страница готова
            try {
                const url = await page.url();
                this.logger.info(`Current page URL: ${url}`);
            } catch (error) {
                this.logger.error('Failed to get page URL:', error);
                return [];
            }

            // Получаем cookies
            let cookieString;
            try {
                const cookies = await page.cookies();
                this.logger.info(`Got ${cookies.length} cookies from page`);
                cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                this.logger.info(`Cookie string length: ${cookieString.length}`);
            } catch (error) {
                this.logger.error('Failed to get cookies:', error);
                this.logger.error('Error details:', error.message);
                this.logger.error('Stack trace:', error.stack);

                // Попробуем альтернативный способ получения cookies
                try {
                    this.logger.info('Trying alternative cookie method...');
                    const context = page.context();
                    const cookies = await context.cookies();
                    this.logger.info(`Got ${cookies.length} cookies from context`);
                    cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                    this.logger.info(`Alternative cookie string length: ${cookieString.length}`);
                } catch (altError) {
                    this.logger.error('Alternative cookie method also failed:', altError);
                    return [];
                }
            }

            // Запрашиваем события за последние 30 дней
            const now = new Date();
            const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 дней назад
            const endDate = now;

            this.logger.info(`Requesting events from ${startDate.toISOString()} to ${endDate.toISOString()}`);

            let response;
            try {
                response = await page.evaluate(async ({ url, teamId, pageSize, cookieString, startDate, endDate, activeEventIds }) => {
                    try {
                        const response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Accept': '*/*',
                                'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
                                'Content-Type': 'application/json',
                                'Priority': 'u=1, i',
                                'Referer': 'https://cursor.com/dashboard?tab=usage',
                                'Sec-CH-UA': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
                                'Sec-CH-UA-Arch': '"x86"',
                                'Sec-CH-UA-Mobile': '?0',
                                'Sec-CH-UA-Platform': '"Windows"',
                                'Sec-CH-UA-Platform-Version': '"19.0.0"',
                                'Sec-Fetch-Dest': 'empty',
                                'Sec-Fetch-Mode': 'cors',
                                'Sec-Fetch-Site': 'same-origin',
                                'User-Agent': navigator.userAgent,
                                'Cookie': cookieString
                            },
                            credentials: 'include',
                            body: JSON.stringify({
                                teamId,
                                startDate: startDate.getTime().toString(),
                                endDate: endDate.getTime().toString(),
                                page: 1,
                                pageSize
                            })
                        });

                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }

                        const data = await response.json();
                        // console.log('Server response for active events:', JSON.stringify(data, null, 2));
                        // console.log('Active event IDs to check:', activeEventIds);
                        // console.log('Response status:', response.status);
                        // console.log('Response headers:', Object.fromEntries(response.headers.entries()));
                        return data;
                    } catch (error) {
                        console.error('Failed to fetch active events:', error);
                        return { events: [] };
                    }
                }, {
                    url: CONFIG.CURSOR_EVENTS_API,
                    teamId: 0,
                    pageSize: 500,
                    cookieString,
                    startDate,
                    endDate,
                    activeEventIds
                });
                this.logger.info('Successfully made API request');
            } catch (error) {
                this.logger.error('Failed to make API request:', error);
                return [];
            }

            if (!response) {
                this.logger.warn('No response from server for active events check');
                return [];
            }

            this.logger.info(`Server response keys: ${Object.keys(response).join(', ')}`);
            this.logger.info(`Full server response: ${JSON.stringify(response, null, 2)}`);

            // Проверяем, есть ли события в ответе (могут быть в разных полях)
            let events = response.events || response.usageEventsDisplay || [];

            if (!events || events.length === 0) {
                this.logger.warn('No events in response for active events check');
                return [];
            }

            this.logger.info(`Received ${events.length} events from server`);

            // Фильтруем только те события, которые есть в активных
            let relevantEvents;
            try {
                // Создаем ID для событий с сервера в том же формате, что и в локальной базе
                const serverEventIds = events.map(event => event.timestamp + '_' + Math.random().toString(36).substr(2, 9));

                relevantEvents = events.filter((event, index) => {
                    const serverEventId = serverEventIds[index];
                    return activeEventIds.some(activeId => activeId.startsWith(event.timestamp));
                });

                this.logger.info(`Found ${relevantEvents.length} relevant events for update check`);
            } catch (error) {
                this.logger.error('Failed to filter relevant events:', error);
                return [];
            }

            // Парсим события
            let parsedEvents;
            try {
                parsedEvents = relevantEvents.map(event => this.parseUsageEvent(event));
                this.logger.info(`Parsed ${parsedEvents.length} events successfully`);
            } catch (error) {
                this.logger.error('Failed to parse events:', error);
                return [];
            }

            return parsedEvents;

        } catch (error) {
            this.logger.error('Failed to collect active events for updates:', error);
            this.logger.error('Error details:', error.message);
            this.logger.error('Stack trace:', error.stack);
            return [];
        }
    }

    async collectFromDOM() {
        try {
            this.logger.info('Collecting data from DOM...');

            const page = this.browserManager.page;
            if (!page) {
                throw new Error('Browser page not available');
            }

            // Ждем загрузки таблицы
            await page.waitForSelector(CONFIG.SELECTORS.USAGE_TABLE, { timeout: 10000 });

            const data = await page.evaluate((selectors) => {
                const rows = document.querySelectorAll(selectors.USAGE_ROWS);
                const events = [];

                rows.forEach((row, index) => {
                    try {
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 5) {
                            const dateText = cells[0]?.textContent?.trim() || '';
                            const modelText = cells[1]?.textContent?.trim() || '';
                            const kindText = cells[2]?.textContent?.trim() || '';
                            const tokensText = cells[3]?.textContent?.trim() || '';
                            const costText = cells[4]?.textContent?.trim() || '';

                            if (dateText && modelText) {
                                events.push({
                                    id: `dom_${Date.now()}_${index}`,
                                    date: new Date().toISOString(),
                                    model: modelText,
                                    kind: kindText.toLowerCase(),
                                    tokens: this.parseTokens(tokensText),
                                    cost: this.parseCost(costText),
                                    source: 'DOM'
                                });
                            }
                        }
                    } catch (error) {
                        console.error('Error parsing row:', error);
                    }
                });

                return events;
            }, CONFIG.SELECTORS);

            this.logger.info(`Collected ${data.length} events from DOM`);
            return data;

        } catch (error) {
            this.logger.error('DOM collection failed:', error);
            return [];
        }
    }

    parseUsageEvent(event) {
        try {
            // Parse timestamp
            let timestamp;
            if (event.timestamp) {
                const ts = parseInt(event.timestamp);
                if (ts > 1577836800000) { // 2020-01-01
                    timestamp = new Date(ts);
                } else {
                    timestamp = new Date();
                }

                // Debug logging removed - timestamp parsing is working correctly
            } else {
                timestamp = new Date();
            }

            // Parse detailed token usage
            let tokenUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0
            };

            if (event.tokenUsage) {
                tokenUsage.inputTokens = event.tokenUsage.inputTokens || 0;
                tokenUsage.outputTokens = event.tokenUsage.outputTokens || 0;
                tokenUsage.cacheReadTokens = event.tokenUsage.cacheReadTokens || 0;
                tokenUsage.cacheWriteTokens = event.tokenUsage.cacheWriteTokens || 0;
                tokenUsage.totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens +
                    tokenUsage.cacheReadTokens + tokenUsage.cacheWriteTokens;

                // Debug log (commented out to reduce log spam)
                // this.logger.info('Token usage parsed:', {
                //     input: tokenUsage.inputTokens,
                //     output: tokenUsage.outputTokens,
                //     cacheRead: tokenUsage.cacheReadTokens,
                //     cacheWrite: tokenUsage.cacheWriteTokens,
                //     total: tokenUsage.totalTokens
                // });
            }

            // Parse detailed cost information
            let costInfo = {
                totalCents: 0,
                requestsCosts: 0,
                usageBasedCosts: 0,
                isIncluded: false,
                isFree: false,
                displayCost: 0,
                originalCost: 0
            };

            if (event.tokenUsage && event.tokenUsage.totalCents) {
                costInfo.totalCents = event.tokenUsage.totalCents;
                costInfo.originalCost = event.tokenUsage.totalCents / 100;
            }
            if (event.requestsCosts) {
                costInfo.requestsCosts = event.requestsCosts;
            }
            if (event.usageBasedCosts && event.usageBasedCosts !== '-') {
                costInfo.usageBasedCosts = parseFloat(event.usageBasedCosts);
            }

            // Determine if cost is included in plan
            if (event.kind === 'USAGE_EVENT_KIND_CUSTOM_SUBSCRIPTION' ||
                event.kind === 'USAGE_EVENT_KIND_INCLUDED_IN_PRO' ||
                event.kind === 'USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS' ||
                event.kind === 'USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS' ||
                event.kind === 'USAGE_EVENT_KIND_INCLUDED_IN_ULTRA') {
                costInfo.isIncluded = true;
                costInfo.displayCost = 0;
            } else if (event.kind === 'USAGE_EVENT_KIND_ERRORED_NOT_CHARGED' ||
                event.kind === 'USAGE_EVENT_KIND_ABORTED_NOT_CHARGED') {
                costInfo.isFree = true;
                costInfo.displayCost = 0;
            } else if (costInfo.totalCents > 0) {
                costInfo.displayCost = costInfo.totalCents / 100;
            } else if (costInfo.usageBasedCosts > 0) {
                costInfo.displayCost = costInfo.usageBasedCosts;
            } else if (costInfo.requestsCosts > 0) {
                costInfo.displayCost = costInfo.requestsCosts;
            }

            // Parse kind with detailed mapping
            let kind = 'unknown';
            let kindDisplay = 'Unknown';

            switch (event.kind) {
                case 'USAGE_EVENT_KIND_CUSTOM_SUBSCRIPTION':
                    // Handle specific subscription types
                    if (event.customSubscriptionName === 'pro-free-trial') {
                        kind = 'pro-free-trial';
                        kindDisplay = 'Pro Free Trial';
                    } else if (event.customSubscriptionName === 'free') {
                        kind = 'free';
                        kindDisplay = 'Free';
                    } else {
                        kind = 'custom_subscription';
                        kindDisplay = event.customSubscriptionName || 'Custom Subscription';
                    }
                    break;
                case 'USAGE_EVENT_KIND_INCLUDED_IN_PRO':
                    kind = 'included_pro';
                    kindDisplay = 'Included in Pro';
                    break;
                case 'USAGE_EVENT_KIND_INCLUDED_IN_BUSINESS':
                    kind = 'included_business';
                    kindDisplay = 'Included in Business';
                    break;
                case 'USAGE_EVENT_KIND_INCLUDED_IN_PRO_PLUS':
                    kind = 'included_pro_plus';
                    kindDisplay = 'Included in Pro+';
                    break;
                case 'USAGE_EVENT_KIND_INCLUDED_IN_ULTRA':
                    kind = 'included_ultra';
                    kindDisplay = 'Included in Ultra';
                    break;
                case 'USAGE_EVENT_KIND_ERRORED_NOT_CHARGED':
                    kind = 'errored_not_charged';
                    kindDisplay = 'Errored, Not Charged';
                    break;
                case 'USAGE_EVENT_KIND_ABORTED_NOT_CHARGED':
                    kind = 'aborted_not_charged';
                    kindDisplay = 'Aborted, Not Charged';
                    break;
                case 'USAGE_EVENT_KIND_USAGE_BASED':
                    kind = 'usage_based';
                    kindDisplay = 'Usage Based';
                    break;
                case 'USAGE_EVENT_KIND_USER_API_KEY':
                    kind = 'user_api_key';
                    kindDisplay = 'User API Key';
                    break;
                default:
                    kind = 'unknown';
                    kindDisplay = 'Unknown';
            }

            // Parse model from rawData
            let model = event.model || 'auto';

            // If model is "default", change to "auto"
            if (model === 'default') {
                model = 'auto';
            }

            // Keep other models as they are (claude-4-sonnet, etc.)

            // Извлекаем maxMode из разных источников
            let maxMode = false;
            if (event.maxMode !== undefined) {
                maxMode = event.maxMode;
            } else if (event.details && event.details.toolCallComposer && event.details.toolCallComposer.maxMode !== undefined) {
                maxMode = event.details.toolCallComposer.maxMode;
            }

            const parsedEvent = {
                id: event.timestamp + '_' + Math.random().toString(36).substr(2, 9),
                date: timestamp,
                model: model,
                kind: kind,
                kindDisplay: kindDisplay,
                tokens: tokenUsage.totalTokens,
                tokenUsage: tokenUsage,
                cost: costInfo.displayCost,
                costInfo: costInfo,
                credits: event.requestsCosts || costInfo.requestsCosts,
                maxMode: maxMode,
                source: 'API',
                rawData: event
            };


            return parsedEvent;

        } catch (error) {
            this.logger.error('Failed to parse usage event:', error);
            return null;
        }
    }

    parseTokens(tokensText) {
        if (!tokensText) return 0;

        const match = tokensText.match(/(\d+(?:\.\d+)?)\s*([KMB]?)/i);
        if (match) {
            let value = parseFloat(match[1]);
            const unit = match[2].toUpperCase();

            switch (unit) {
                case 'K': value *= 1000; break;
                case 'M': value *= 1000000; break;
                case 'B': value *= 1000000000; break;
            }

            return Math.round(value);
        }

        return 0;
    }

    parseCost(costText) {
        if (!costText) return 0;

        const match = costText.match(/\$?(\d+(?:\.\d+)?)/);
        return match ? parseFloat(match[1]) : 0;
    }

    async collectUserInfo() {
        try {
            this.logger.info('Collecting user info...');

            const page = this.browserManager.page;
            if (!page) {
                throw new Error('Browser page not available');
            }

            // Получаем данные пользователя через браузер
            const userInfo = await page.evaluate(async () => {
                try {
                    const [authResponse, stripeResponse] = await Promise.all([
                        fetch('/api/auth/me'),
                        fetch('/api/auth/stripe')
                    ]);

                    let userData = {};

                    if (authResponse.ok) {
                        const authData = await authResponse.json();
                        userData = { ...userData, ...authData };
                        console.log('Auth data:', authData);
                    } else {
                        console.log('Auth response failed:', authResponse.status);
                    }

                    if (stripeResponse.ok) {
                        const stripeData = await stripeResponse.json();
                        userData = { ...userData, ...stripeData };
                        console.log('Stripe data:', stripeData);
                    } else {
                        console.log('Stripe response failed:', stripeResponse.status);
                    }

                    // Фильтруем ненужные поля
                    const { paymentId, sub, ...filteredData } = userData;

                    console.log('Final user data:', filteredData);
                    return filteredData;
                } catch (error) {
                    console.error('Failed to fetch user info:', error);
                    return {};
                }
            });

            // this.logger.info('Collected user info:', userInfo);

            // Сохраняем данные пользователя
            if (Object.keys(userInfo).length > 0) {
                await this.dataStorage.saveUserInfo(userInfo);
                this.logger.info('User info collected and saved successfully');
            } else {
                this.logger.warn('No user info collected');
            }

        } catch (error) {
            this.logger.error('Failed to collect user info:', error);
        }
    }
}
