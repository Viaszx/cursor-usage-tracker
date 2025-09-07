import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../config.example.env') });

export const CONFIG = {
    CURSOR_DASHBOARD_URL: process.env.CURSOR_DASHBOARD_URL || 'https://cursor.com/dashboard?tab=usage',
    CURSOR_ANALYTICS_API: 'https://cursor.com/api/dashboard/get-user-analytics',
    CURSOR_EVENTS_API: 'https://cursor.com/api/dashboard/get-filtered-usage-events',
    CHROME_USER_DATA_DIR: process.env.CHROME_USER_DATA_DIR || '',
    OUTPUT_DIR: process.env.OUTPUT_DIR || './data',
    WEB_PORT: parseInt(process.env.WEB_PORT) || 3000,
    HEADLESS: process.env.HEADLESS === 'true',
    TIMEOUT: parseInt(process.env.TIMEOUT) || 30000,
    API_TIMEOUT: parseInt(process.env.API_TIMEOUT) || 10000,
    COLLECTION_INTERVAL: parseInt(process.env.COLLECTION_INTERVAL) || 100000, // 5 минут
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
    PAGE_SIZE: parseInt(process.env.PAGE_SIZE) || 100,
    SELECTORS: {
        USAGE_TABLE: 'table, [class*="table"], tbody, [class*="usage"]',
        USAGE_ROWS: 'tr[class*="bg-transparent"], tr[class*="hover"], tbody tr, tr',
        DATE_CELL: 'td[class*="w-[130px]"], td:first-child',
        MODEL_CELL: 'td[class*="min-w-[150px]"], td:nth-child(2)',
        KIND_CELL: 'td[class*="w-[1px]"], td:nth-child(3)',
        TOKENS_CELL: 'td[class*="text-right"], td:nth-child(4)',
        COST_CELL: 'td[class*="w-[100px]"], td:last-child'
    }
};

export const PATHS = {
    DATA_DIR: path.resolve(CONFIG.OUTPUT_DIR),
    USAGE_DATA_FILE: path.join(CONFIG.OUTPUT_DIR, 'usage_data.json'),
    STATS_FILE: path.join(CONFIG.OUTPUT_DIR, 'stats.json')
};
