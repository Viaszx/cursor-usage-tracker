export class Logger {
    constructor(module = 'App') {
        this.module = module;
    }

    formatMessage(level, message, ...args) {
        const timestamp = new Date().toISOString();
        const moduleTag = `[${this.module}]`;
        const levelTag = `[${level.toUpperCase()}]`;

        if (args.length > 0) {
            return `${timestamp} ${moduleTag} ${levelTag} ${message} ${args.map(arg =>
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ')}`;
        }

        return `${timestamp} ${moduleTag} ${levelTag} ${message}`;
    }

    info(message, ...args) {
        console.log(this.formatMessage('info', message, ...args));
    }

    warn(message, ...args) {
        console.warn(this.formatMessage('warn', message, ...args));
    }

    error(message, ...args) {
        console.error(this.formatMessage('error', message, ...args));
    }

    debug(message, ...args) {
        if (process.env.NODE_ENV === 'development') {
            console.debug(this.formatMessage('debug', message, ...args));
        }
    }
}
