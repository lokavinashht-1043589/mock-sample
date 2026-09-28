import { formatClock } from '../utils/helpers.js';

/**
 * Ring-buffer logger. Entries are small plain objects so they can be persisted and
 * broadcast to the popup. debug() entries are only kept when debug mode is on.
 */
export class Logger {
    constructor({ maxEntries = 1000, debugMode = false, persist = null, persistDelayMs = 1000, now = Date.now } = {}) {
        this.maxEntries = maxEntries;
        this.debugMode = debugMode;
        this.entries = [];
        this.listeners = new Set();
        this.persist = persist;
        this.persistDelayMs = persistDelayMs;
        this.now = now;
        this.persistTimer = null;
    }

    load(entries) {
        if (Array.isArray(entries)) this.entries = entries.slice(-this.maxEntries);
    }

    setDebugMode(enabled) {
        this.debugMode = Boolean(enabled);
    }

    info(message, data) {
        return this.log('info', message, data);
    }

    warn(message, data) {
        return this.log('warn', message, data);
    }

    error(message, data) {
        return this.log('error', message, data);
    }

    debug(message, data) {
        if (!this.debugMode) return null;
        return this.log('debug', message, data);
    }

    log(level, message, data) {
        const entry = { t: this.now(), level, message: String(message) };
        if (data !== undefined) {
            try {
                entry.data = typeof data === 'string' ? data : JSON.stringify(data).slice(0, 2000);
            } catch {
                entry.data = String(data);
            }
        }
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
        for (const listener of this.listeners) {
            try {
                listener(entry);
            } catch {
                // listener errors never break logging
            }
        }
        this.schedulePersist();
        if (typeof console !== 'undefined' && this.debugMode) {
            (console[level] || console.log)(`[GFA] ${message}`, data ?? '');
        }
        return entry;
    }

    onEntry(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    clear() {
        this.entries = [];
        this.schedulePersist();
    }

    schedulePersist() {
        if (!this.persist || this.persistTimer) return;
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            Promise.resolve(this.persist(this.entries)).catch(() => {});
        }, this.persistDelayMs);
    }

    static format(entry) {
        const level = entry.level === 'info' ? '' : ` ${entry.level.toUpperCase()}:`;
        const data = entry.data ? ` ${entry.data}` : '';
        return `[${formatClock(entry.t)}]${level} ${entry.message}${data}`;
    }

    toText() {
        return this.entries.map(Logger.format).join('\n');
    }
}
