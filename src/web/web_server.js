import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config/constants.js';
import { DataStorage } from '../storage/data_storage.js';
import { Logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class WebServer {
    constructor() {
        this.app = express();
        this.storage = new DataStorage();
        this.logger = new Logger('WebServer');
        this.clients = []; // Store SSE clients
        this.setupRoutes();
    }

    setupRoutes() {
        // Статические файлы
        this.app.use(express.static(path.join(__dirname, 'public')));

        // API маршруты
        this.app.get('/api/stats', this.getStats.bind(this));
        this.app.get('/api/data', this.getData.bind(this));
        this.app.get('/api/all-events', this.getAllEvents.bind(this));
        this.app.get('/api/user-info', this.getUserInfo.bind(this));
        this.app.get('/api/health', this.getHealth.bind(this));

        // Server-Sent Events endpoint for real-time updates
        this.app.get('/api/events', this.handleSSE.bind(this));

        // Главная страница
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
    }

    async getStats(req, res) {
        try {
            const stats = await this.storage.loadStats();
            if (!stats) {
                return res.status(404).json({ error: 'No statistics available' });
            }

            res.json(stats);
        } catch (error) {
            this.logger.error('Failed to get stats:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async getData(req, res) {
        try {
            const data = await this.storage.loadUsageData();
            if (!data) {
                return res.status(404).json({ error: 'No data available' });
            }

            res.json(data);
        } catch (error) {
            this.logger.error('Failed to get data:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async getAllEvents(req, res) {
        try {
            const data = await this.storage.loadUsageData();
            if (!data || !data.events) {
                return res.status(404).json({ error: 'No events available' });
            }

            res.json(data.events);
        } catch (error) {
            this.logger.error('Failed to get all events:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    async getUserInfo(req, res) {
        try {
            // Load user info from saved file
            const userInfo = await this.storage.loadUserInfo();

            if (!userInfo) {
                return res.status(404).json({ error: 'User info not available' });
            }

            res.json(userInfo);
        } catch (error) {
            this.logger.error('Failed to get user info:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    getHealth(req, res) {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    }

    async handleSSE(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });

        // Send initial data
        await this.sendUpdate(res);

        // Store client connection
        this.clients.push(res);

        // Remove client when connection closes
        req.on('close', () => {
            this.clients = this.clients.filter(client => client !== res);
        });
    }

    async sendUpdate(res) {
        try {
            const [stats, data, userInfo] = await Promise.all([
                this.storage.loadStats(),
                this.storage.loadUsageData(),
                this.storage.loadUserInfo()
            ]);

            const update = {
                stats,
                data,
                userInfo,
                timestamp: new Date().toISOString()
            };

            res.write(`data: ${JSON.stringify(update)}\n\n`);
        } catch (error) {
            this.logger.error('Failed to send update:', error);
            res.write(`data: ${JSON.stringify({ error: 'Failed to load data' })}\n\n`);
        }
    }

    async broadcastUpdate() {
        if (this.clients.length === 0) return;

        this.logger.info(`Broadcasting update to ${this.clients.length} clients`);

        const [stats, data, userInfo] = await Promise.all([
            this.storage.loadStats(),
            this.storage.loadUsageData(),
            this.storage.loadUserInfo()
        ]);

        const update = {
            stats,
            data,
            userInfo,
            timestamp: new Date().toISOString()
        };

        const message = `data: ${JSON.stringify(update)}\n\n`;

        // Send to all connected clients
        this.clients.forEach(client => {
            try {
                client.write(message);
            } catch (error) {
                // Remove dead clients
                this.clients = this.clients.filter(c => c !== client);
            }
        });
    }

    async start() {
        try {
            await this.storage.initialize();

            this.server = this.app.listen(CONFIG.WEB_PORT, () => {
                this.logger.info(`Web server started on port ${CONFIG.WEB_PORT}`);
                this.logger.info(`Dashboard available at: http://localhost:${CONFIG.WEB_PORT}`);
            });

        } catch (error) {
            this.logger.error('Failed to start web server:', error);
            throw error;
        }
    }

    async startStandalone() {
        try {
            await this.storage.initialize();

            this.server = this.app.listen(CONFIG.WEB_PORT, () => {
                console.log(`Web server started on port ${CONFIG.WEB_PORT}`);
                console.log(`Dashboard available at: http://localhost:${CONFIG.WEB_PORT}`);
            });

        } catch (error) {
            console.error('Failed to start web server:', error);
            throw error;
        }
    }

    async stop() {
        if (this.server) {
            this.server.close();
            this.logger.info('Web server stopped');
        }
    }
}
