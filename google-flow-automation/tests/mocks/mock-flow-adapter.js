import { AbortedError } from '../../src/utils/helpers.js';

/**
 * Stand-in for Google Flow. Same interface as RemoteFlowAdapter.
 *
 *   new MockFlowAdapter({
 *     failures: { submitPrompt: [new Error('boom'), null] },    // per-call outcomes, null = succeed
 *     ready: [{ authenticated: false }, { ready: true, authenticated: true }],
 *     hang: { waitForVideo: (prompt) => prompt === 'B' },       // block until aborted
 *     videoUrl: (prompt) => 'https://media.test/v.mp4'
 *   })
 */
export class MockFlowAdapter {
    constructor({ failures = {}, ready = [], hang = {}, videoUrl, onStep } = {}) {
        this.failures = Object.fromEntries(Object.entries(failures).map(([k, v]) => [k, [...v]]));
        this.readySequence = [...ready];
        this.hang = hang;
        this.videoUrl = videoUrl || ((prompt) => `https://media.test/${encodeURIComponent(prompt)}.mp4`);
        this.onStep = onStep;
        this.calls = [];
        this.active = 0;
        this.maxActive = 0;
        this.seq = 0;
        this.aborted = 0;
    }

    async step(name, prompt, signal) {
        this.calls.push(`${name}:${prompt}`);
        await this.onStep?.(name, prompt);
        if (this.hang[name]?.(prompt)) {
            await new Promise((_, reject) => {
                if (signal?.aborted) return reject(new AbortedError());
                signal?.addEventListener('abort', () => reject(new AbortedError()), { once: true });
            });
        }
        await Promise.resolve();
        const outcome = this.failures[name]?.shift();
        if (outcome) throw outcome;
    }

    async checkReady() {
        this.calls.push('checkReady');
        return this.readySequence.length ? this.readySequence.shift() : { ready: true, authenticated: true };
    }

    async submitPrompt(prompt, { signal } = {}) {
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        try {
            await this.step('submitPrompt', prompt, signal);
            return { id: `mock-pending-${++this.seq}`, prompt };
        } finally {
            this.active--;
        }
    }
    // `active`/`maxActive` track generations in flight (submit + waitForGenerated); must stay 1.

    async waitForGenerated(pending, { signal } = {}) {
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        try {
            await this.step('waitForGenerated', pending.prompt, signal);
        } finally {
            this.active--;
        }
    }

    async waitForVideo(pending, { signal } = {}) {
        await this.step('waitForVideo', pending.prompt, signal);
        return { id: `mock-video-${++this.seq}`, prompt: pending.prompt };
    }

    async getVideoDownloadInfo(video) {
        this.calls.push(`getVideoDownloadInfo:${video.prompt}`);
        return { url: this.videoUrl(video.prompt), mimeHint: null };
    }

    async getVideoDownloadUrl(video) {
        return (await this.getVideoDownloadInfo(video)).url;
    }

    async triggerNativeDownload(video) {
        this.calls.push(`triggerNativeDownload:${video.prompt}`);
    }

    async abort() {
        this.aborted++;
    }

    promptsFor(stepName) {
        return this.calls.filter((c) => c.startsWith(`${stepName}:`)).map((c) => c.slice(stepName.length + 1));
    }
}
