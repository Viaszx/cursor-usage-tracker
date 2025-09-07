import { chromium } from 'playwright';
import { CONFIG } from '../config/constants.js';
import { Logger } from '../utils/logger.js';

export class BrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.logger = new Logger('BrowserManager');
    }


    async initialize(cookies = null) {
        try {
            this.logger.info('Initializing browser...');

            const contextOptions = {
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                headless: CONFIG.HEADLESS,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            };

            if (CONFIG.CHROME_USER_DATA_DIR) {
                contextOptions.userDataDir = CONFIG.CHROME_USER_DATA_DIR;
                this.logger.info(`Using Chrome user data directory: ${CONFIG.CHROME_USER_DATA_DIR}`);

                // Используем launchPersistentContext для профиля Chrome
                this.context = await chromium.launchPersistentContext(
                    CONFIG.CHROME_USER_DATA_DIR,
                    contextOptions
                );
            } else {
                // Обычный запуск без профиля
                this.browser = await chromium.launch({
                    headless: CONFIG.HEADLESS,
                    args: contextOptions.args
                });
                this.context = await this.browser.newContext(contextOptions);
            }

            this.page = await this.context.newPage();

            // Устанавливаем cookies если они предоставлены
            if (cookies && cookies.length > 0) {
                await this.setCookies(cookies);
            }

            this.page.setDefaultTimeout(CONFIG.TIMEOUT);

            this.logger.info('Browser initialized successfully');
            return true;
        } catch (error) {
            this.logger.error('Failed to initialize browser:', error);
            throw error;
        }
    }

    async setCookies(cookies) {
        try {
            this.logger.info(`Setting ${cookies.length} cookies...`);

            // Конвертируем cookies в формат Playwright
            const playwrightCookies = cookies.map(cookie => ({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain || '.cursor.com',
                path: cookie.path || '/',
                expires: cookie.expires ? new Date(cookie.expires * 1000) : undefined,
                httpOnly: cookie.httpOnly || false,
                secure: cookie.secure || false,
                sameSite: cookie.sameSite || 'lax'
            }));

            await this.context.addCookies(playwrightCookies);
            this.logger.info('Cookies set successfully');

        } catch (error) {
            this.logger.error('Failed to set cookies:', error);
            throw error;
        }
    }

    async navigateToDashboard() {
        try {
            this.logger.info(`Navigating to: ${CONFIG.CURSOR_DASHBOARD_URL}`);
            await this.page.goto(CONFIG.CURSOR_DASHBOARD_URL, {
                waitUntil: 'networkidle',
                timeout: CONFIG.TIMEOUT
            });

            // Ждем полной загрузки страницы и всех ресурсов
            await this.waitForPageLoad();

            this.logger.info('Successfully navigated to dashboard');
            return true;
        } catch (error) {
            this.logger.error('Failed to navigate to dashboard:', error);
            throw error;
        }
    }

    async waitForPageLoad() {
        try {
            this.logger.info('Waiting for page resources to load...');

            // Ждем загрузки основных скриптов
            await this.page.waitForFunction(() => {
                return window.__NEXT_DATA__ || window.__APOLLO_STATE__ || document.readyState === 'complete';
            }, { timeout: 10000 });

            // Ждем загрузки API endpoints
            await this.page.waitForFunction(() => {
                return window.fetch && typeof window.fetch === 'function';
            }, { timeout: 5000 });

            // Дополнительная пауза для стабилизации
            await new Promise(resolve => setTimeout(resolve, 2000));

            this.logger.info('Page resources loaded successfully');

        } catch (error) {
            this.logger.warn('Page load timeout, continuing anyway:', error.message);
        }
    }

    async waitForAuthentication() {
        try {
            this.logger.info('Waiting for authentication...');

            const maxWaitTime = 10000;
            const checkInterval = 1000;
            let waited = 0;

            while (waited < maxWaitTime) {
                const currentUrl = this.page.url();

                if (currentUrl.includes('/dashboard') && !currentUrl.includes('/login')) {
                    this.logger.info('Authentication detected');
                    return true;
                }

                await this.page.waitForTimeout(checkInterval);
                waited += checkInterval;
            }

            this.logger.warn('Authentication timeout - proceeding anyway');
            return false;
        } catch (error) {
            this.logger.error('Error during authentication check:', error);
            return false;
        }
    }

    async waitForUsageData() {
        try {
            this.logger.info('Waiting for usage data to load...');

            // Ждем загрузки всех API запросов
            try {
                await this.page.waitForFunction(() => {
                    // Проверяем, что все необходимые API запросы выполнены
                    const hasUsageData = window.performance &&
                        window.performance.getEntriesByType('navigation').length > 0;

                    // Проверяем наличие данных в DOM
                    const tables = document.querySelectorAll('table');
                    const rows = document.querySelectorAll('tr');
                    const usageElements = document.querySelectorAll('[class*="usage"], [class*="token"], [class*="cost"]');

                    return tables.length > 0 || rows.length > 0 || usageElements.length > 0;
                }, { timeout: 20000 });

                this.logger.info('Usage data loaded successfully');
                return true;
            } catch (e) {
                this.logger.warn('Usage data not loaded within timeout');
            }

            // Дополнительно ждем загрузки через сеть
            try {
                await this.page.waitForLoadState('networkidle');
                this.logger.info('Network idle state reached');
            } catch (e) {
                this.logger.warn('Network idle timeout');
            }

            // Пробуем найти элементы с помощью селекторов
            const selectors = Object.values(CONFIG.SELECTORS);
            for (const selector of selectors) {
                try {
                    await this.page.waitForSelector(selector, { timeout: 5000 });
                    this.logger.info(`Found usage data with selector: ${selector}`);
                    return true;
                } catch (e) {
                    continue;
                }
            }

            this.logger.warn('Usage data not found with any selector');
            return false;
        } catch (error) {
            this.logger.error('Error waiting for usage data:', error);
            return false;
        }
    }

    async getPageContent() {
        try {
            return await this.page.content();
        } catch (error) {
            this.logger.error('Failed to get page content:', error);
            throw error;
        }
    }

    async takeScreenshot(filename = 'screenshot.png') {
        try {
            await this.page.screenshot({ path: filename, fullPage: true });
            this.logger.info(`Screenshot saved: ${filename}`);
        } catch (error) {
            this.logger.error('Failed to take screenshot:', error);
        }
    }

    async close() {
        try {
            if (this.page) {
                await this.page.close();
            }
            if (this.context) {
                await this.context.close();
            }
            if (this.browser) {
                await this.browser.close();
            }
            this.logger.info('Browser closed successfully');
        } catch (error) {
            this.logger.error('Error closing browser:', error);
        }
    }

}
