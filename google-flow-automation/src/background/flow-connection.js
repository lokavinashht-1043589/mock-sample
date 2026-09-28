import { PORT_NAME, COMMANDS } from '../utils/messages.js';
import { AbortedError, TimeoutError, toError } from '../utils/helpers.js';

const manifest = () => chrome.runtime.getManifest();
const contentScriptFiles = () => manifest().content_scripts[0].js;
const flowMatchPatterns = () => manifest().content_scripts[0].matches;

/** Chrome match pattern -> RegExp (enough for "https://host/*" style patterns). */
function patternToRegex(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

export function isFlowUrl(url) {
    return Boolean(url) && flowMatchPatterns().some((p) => patternToRegex(p).test(url));
}

/**
 * Owns the Flow tab and the long-lived port to its content script.
 * Command replies, heartbeats and progress all arrive over that port.
 */
export class FlowConnection {
    constructor({ getSettings, logger, onTabChanged = () => {} }) {
        this.getSettings = getSettings;
        this.logger = logger;
        this.onTabChanged = onTabChanged;
        this.ports = new Map(); // tabId -> port
        this.pending = new Map(); // command id -> entry
        this.helloWaiters = new Set();
        this.tabId = null;
        this.seq = 0;
    }

    setTabId(tabId) {
        this.tabId = tabId ?? null;
    }

    /** Wire to chrome.runtime.onConnect. */
    attach(port) {
        if (port.name !== PORT_NAME || !port.sender?.tab) return;
        const tabId = port.sender.tab.id;
        this.ports.set(tabId, port);
        port.onMessage.addListener((msg) => this.onPortMessage(tabId, msg));
        port.onDisconnect.addListener(() => this.onPortDisconnect(tabId, port));
    }

    onPortMessage(tabId, msg) {
        switch (msg?.type) {
            case 'HELLO':
                this.logger.debug(`Flow content script connected (tab ${tabId})`);
                for (const waiter of this.helloWaiters) waiter(tabId);
                break;
            case 'RESULT': {
                const entry = this.pending.get(msg.id);
                if (!entry) return;
                this.finishCommand(msg.id);
                msg.ok ? entry.resolve(msg.result) : entry.reject(toError(msg.error));
                break;
            }
            case 'PROGRESS':
                this.pending.get(msg.id)?.onProgress?.(msg.detail);
                break;
            case 'HEARTBEAT':
                break; // receiving it is the point: it keeps the MV3 worker alive
            case 'LOG': {
                const level = ['debug', 'info', 'warn', 'error'].includes(msg.level) ? msg.level : 'info';
                this.logger[level](`[page] ${msg.message}`);
                break;
            }
            default:
                break;
        }
    }

    onPortDisconnect(tabId, port) {
        void chrome.runtime.lastError;
        if (this.ports.get(tabId) === port) this.ports.delete(tabId);
        for (const [id, entry] of this.pending) {
            if (entry.tabId !== tabId) continue;
            this.finishCommand(id);
            entry.reject(Object.assign(new Error('Flow page disconnected (reloaded, navigated away, or closed)'), { code: 'DISCONNECTED' }));
        }
        if (tabId === this.tabId) this.logger.warn('Lost connection to the Flow tab');
    }

    finishCommand(id) {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        entry.cleanup?.();
        this.pending.delete(id);
    }

    waitForHello(tabId, timeoutMs, signal) {
        if (this.ports.has(tabId)) return Promise.resolve(true);
        return new Promise((resolve) => {
            const done = (value) => {
                clearTimeout(timer);
                this.helloWaiters.delete(waiter);
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            };
            const waiter = (id) => id === tabId && done(true);
            const onAbort = () => done(false);
            const timer = setTimeout(() => done(this.ports.has(tabId)), timeoutMs);
            this.helloWaiters.add(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async findFlowTab() {
        const tabs = await chrome.tabs.query({ url: flowMatchPatterns() });
        return tabs.find((t) => this.ports.has(t.id)) || tabs.find((t) => /\/project\//.test(t.url || '')) || tabs[0] || null;
    }

    /**
     * Make sure there is a Flow tab with a live content script.
     * @returns {Promise<{ok:true,tabId:number}|{ok:false,reason:string,authRequired?:boolean,noTab?:boolean}>}
     */
    async ensureConnected({ signal, openIfMissing = true, waitMs = 15000 } = {}) {
        let tab = this.tabId != null ? await chrome.tabs.get(this.tabId).catch(() => null) : null;

        if (!tab) {
            tab = await this.findFlowTab();
            if (!tab) {
                if (!openIfMissing) return { ok: false, noTab: true, reason: 'No Google Flow tab is open' };
                const url = this.getSettings().flowUrl;
                tab = await chrome.tabs.create({ url, active: true });
                this.logger.info(`Opened Google Flow: ${url}`);
            }
            this.tabId = tab.id;
            this.onTabChanged(tab.id);
            // Stop Chrome's Memory Saver from discarding the tab mid-generation.
            chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
        }

        if (this.ports.has(tab.id)) return { ok: true, tabId: tab.id };

        if (tab.status === 'loading') await this.waitForHello(tab.id, waitMs, signal);
        if (this.ports.has(tab.id)) return { ok: true, tabId: tab.id };

        tab = await chrome.tabs.get(tab.id).catch(() => null);
        if (!tab) {
            this.tabId = null;
            return { ok: false, reason: 'The Flow tab was closed' };
        }
        if (!isFlowUrl(tab.url)) {
            // We can only read URLs of Flow pages; anything else (typically accounts.google.com) is hidden.
            return {
                ok: false,
                authRequired: true,
                reason: 'The Flow tab is not showing Google Flow (it may be on the Google sign-in page).'
            };
        }

        // Tab was open before the extension was (re)loaded: inject the content scripts once.
        try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: contentScriptFiles() });
            this.logger.debug('Injected content scripts into existing Flow tab');
        } catch (error) {
            this.logger.warn(`Could not inject content script: ${error.message}`);
        }
        const connected = await this.waitForHello(tab.id, waitMs, signal);
        if (signal?.aborted) throw new AbortedError();
        return connected ? { ok: true, tabId: tab.id } : { ok: false, reason: 'Flow content script did not respond (try reloading the Flow tab)' };
    }

    /**
     * Send one command to the content script. `timeoutMs` is the expected duration of the step;
     * a safety margin is added (the content script enforces the real timeout itself).
     */
    command(command, args = {}, { signal, timeoutMs = 60000, onProgress } = {}) {
        const tabId = this.tabId;
        const port = tabId != null ? this.ports.get(tabId) : null;
        if (!port) return Promise.reject(Object.assign(new Error('Not connected to the Flow tab'), { code: 'DISCONNECTED' }));
        if (signal?.aborted) return Promise.reject(new AbortedError());

        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                this.finishCommand(id);
                try {
                    port.postMessage({ type: 'COMMAND', id: ++this.seq, command: COMMANDS.ABORT });
                } catch {
                    // already gone
                }
                reject(new AbortedError());
            };
            const timer = setTimeout(() => {
                this.finishCommand(id);
                reject(new TimeoutError(`${command} did not respond in time`));
            }, timeoutMs + 30000);
            signal?.addEventListener('abort', onAbort, { once: true });
            this.pending.set(id, { resolve, reject, onProgress, tabId, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) });
            try {
                port.postMessage({ type: 'COMMAND', id, command, args });
            } catch (error) {
                this.finishCommand(id);
                reject(Object.assign(new Error(`Could not reach the Flow tab: ${error.message}`), { code: 'DISCONNECTED' }));
            }
        });
    }

    abortAll() {
        const port = this.tabId != null ? this.ports.get(this.tabId) : null;
        try {
            port?.postMessage({ type: 'COMMAND', id: ++this.seq, command: COMMANDS.ABORT });
        } catch {
            // ignore
        }
    }
}
