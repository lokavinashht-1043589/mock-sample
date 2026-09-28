import { COMMANDS } from '../utils/messages.js';

/**
 * The adapter the automation engine uses in production. It forwards each step to the Flow
 * content script (src/content/flow-adapter.js) and has the same interface as
 * tests/mocks/mock-flow-adapter.js.
 */
export class RemoteFlowAdapter {
    constructor(connection, getSettings) {
        this.connection = connection;
        this.getSettings = getSettings;
    }

    async checkReady({ signal } = {}) {
        const conn = await this.connection.ensureConnected({ signal });
        if (!conn.ok) return { ready: false, authenticated: conn.authRequired ? false : null, reason: conn.reason };
        return this.connection.command(COMMANDS.CHECK_READY, {}, { signal, timeoutMs: 10000 });
    }

    /**
     * Where the user is in Flow, without opening or changing anything (for the popup).
     * @returns {{connected:boolean, noTab?:boolean, authRequired?:boolean, reason?:string,
     *            authenticated?:boolean|null, projectOpen?:boolean, projectName?:string|null, promptFound?:boolean}}
     */
    async getStatus({ signal, preferProject = true } = {}) {
        if (preferProject) await this.connection.preferProjectTab();
        const conn = await this.connection.ensureConnected({ signal, openIfMissing: false, waitMs: 4000 });
        if (!conn.ok) return { connected: false, noTab: Boolean(conn.noTab), authRequired: Boolean(conn.authRequired), reason: conn.reason };
        const status = await this.connection.command(COMMANDS.GET_STATUS, {}, { signal, timeoutMs: 5000 });
        return { connected: true, ...status };
    }

    async submitPrompt(prompt, { signal, elementTimeoutMs, onProgress } = {}) {
        return this.connection.command(COMMANDS.SUBMIT_PROMPT, { prompt, elementTimeoutMs }, { signal, timeoutMs: 4 * elementTimeoutMs, onProgress });
    }

    async waitForVideo(video, { signal, timeoutMs, onProgress } = {}) {
        return this.connection.command(COMMANDS.WAIT_FOR_VIDEO, { video, timeoutMs }, { signal, timeoutMs, onProgress });
    }

    async getVideoDownloadInfo(video, { signal, elementTimeoutMs = 30000 } = {}) {
        return this.connection.command(COMMANDS.GET_VIDEO_INFO, { video }, { signal, timeoutMs: elementTimeoutMs });
    }

    async triggerNativeDownload(video, { signal, elementTimeoutMs = 30000 } = {}) {
        return this.connection.command(COMMANDS.TRIGGER_NATIVE_DOWNLOAD, { video, elementTimeoutMs }, { signal, timeoutMs: elementTimeoutMs });
    }

    async diagnose({ signal } = {}) {
        const conn = await this.connection.ensureConnected({ signal, openIfMissing: false, waitMs: 5000 });
        if (!conn.ok) return { connected: false, reason: conn.reason, authRequired: Boolean(conn.authRequired) };
        const result = await this.connection.command(COMMANDS.DIAGNOSE, {}, { signal, timeoutMs: 15000 });
        return { connected: true, ...result };
    }

    async abort() {
        this.connection.abortAll();
    }
}
