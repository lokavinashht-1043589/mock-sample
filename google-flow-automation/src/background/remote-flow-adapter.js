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
        const { elementTimeoutMs } = this.getSettings();
        return this.connection.command(COMMANDS.CHECK_READY, { prepare: true, elementTimeoutMs }, { signal, timeoutMs: elementTimeoutMs });
    }

    async generateImage(prompt, { signal, timeoutMs, elementTimeoutMs, onProgress } = {}) {
        return this.connection.command(COMMANDS.GENERATE_IMAGE, { prompt, timeoutMs, elementTimeoutMs }, { signal, timeoutMs: timeoutMs + 2 * elementTimeoutMs, onProgress });
    }

    async animateImage(image, { prompt, signal, elementTimeoutMs, onProgress } = {}) {
        return this.connection.command(COMMANDS.ANIMATE_IMAGE, { image, prompt, elementTimeoutMs }, { signal, timeoutMs: 4 * elementTimeoutMs, onProgress });
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
