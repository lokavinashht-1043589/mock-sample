import {
    JOB_STATUS,
    STATUS_LABELS,
    getNextJob,
    getStats,
    buildSummary,
    markInterrupted,
    resetJob
} from './queue-manager.js';
import { RUN_STATUS } from './state-manager.js';
import { sleep as defaultSleep, isAbortError, AbortedError } from '../utils/helpers.js';

export class AuthRequiredError extends Error {
    constructor(message = 'Google authentication is required.') {
        super(message);
        this.name = 'AuthRequiredError';
        this.code = 'AUTH_REQUIRED';
    }
}

export class ProjectRequiredError extends Error {
    constructor(message = 'No project is open in Google Flow.') {
        super(message);
        this.name = 'ProjectRequiredError';
        this.code = 'PROJECT_REQUIRED';
    }
}

export const PROJECT_MESSAGE =
    'No project is open in Google Flow.\n\nOpen (or create) a project in the Flow tab.\nAutomation will continue once the project is open.';

export const AUTH_MESSAGE =
    'Google authentication is required.\n\nPlease log in to Google Flow manually.\nAutomation will continue after authentication.';

/**
 * Central state machine. Talks to Google Flow ONLY through `adapter`, which must implement:
 *   checkReady()                          -> { ready, authenticated, projectOpen?, reason? }
 *   submitPrompt(prompt, opts)            -> pendingVideoRef  (types into the project's main prompt box)
 *   waitForGenerated(pendingVideoRef, opts) -> void           (this prompt's progress reached 100%)
 *   waitForVideo(pendingVideoRef, opts)   -> videoRef
 *   getVideoDownloadInfo(videoRef, opts)  -> { url, mimeHint? }
 *   triggerNativeDownload(videoRef, opts) -> void   (clicks Flow's own download button)
 *   abort()                               -> void
 * (see tests/mocks/mock-flow-adapter.js and src/background/remote-flow-adapter.js)
 *
 *   PENDING -> GENERATING_VIDEO --(100%)--> DOWNLOADING -> COMPLETED
 *   Generation is one prompt at a time; as soon as a prompt reaches 100% the next one is typed.
 *   Downloads run in a background queue (one at a time, in order) that overlaps generation, and
 *   their page clicks never interleave with typing a prompt (see withPage).
 *   any state -> error -> retry (up to maxRetries) -> FAILED -> next job
 */
export class FlowAutomationEngine {
    constructor({ stateManager, adapter, downloadManager, logger, getSettings, emit = () => {}, sleep = defaultSleep, authPollMs = 5000, retryBackoffMs = 3000 }) {
        this.state = stateManager;
        this.adapter = adapter;
        this.downloads = downloadManager;
        this.logger = logger;
        this.getSettings = getSettings;
        this.emit = emit;
        this.sleep = sleep;
        this.authPollMs = authPollMs;
        this.retryBackoffMs = retryBackoffMs;

        this.loopPromise = null;
        this.downloadChain = Promise.resolve(); // background downloads, strictly one after another
        this.pageLock = Promise.resolve(); // serialises page interactions (typing vs. download clicks)
        this.pauseRequested = false;
        this.stopRequested = false;
        this.abortController = null;
    }

    get isRunning() {
        return this.loopPromise !== null;
    }

    // ───────────────────────────── controls ─────────────────────────────

    /** Launch the processing loop. Resolves once the loop has been started (not finished). */
    async start({ scope = null } = {}) {
        if (this.isRunning) {
            this.logger.warn('Start ignored: automation is already running');
            return false;
        }
        this.pauseRequested = false;
        this.stopRequested = false;
        await this.state.update({ runStatus: RUN_STATUS.RUNNING, scope, summary: null, statusMessage: 'Starting…' });
        this.loopPromise = this.processQueue().finally(() => {
            this.loopPromise = null;
        });
        return true;
    }

    /** For tests / callers that want to await completion. */
    async whenIdle() {
        if (this.loopPromise) await this.loopPromise;
    }

    async pause() {
        if (!this.isRunning) return;
        this.pauseRequested = true;
        this.logger.info('Pause requested — the current job will finish first');
        await this.state.update({ runStatus: RUN_STATUS.PAUSING, statusMessage: 'Pausing after the current job…' });
    }

    async resume() {
        if (this.isRunning) {
            if (this.pauseRequested) {
                this.pauseRequested = false;
                this.logger.info('Pause cancelled — continuing');
                await this.state.update({ runStatus: RUN_STATUS.RUNNING, statusMessage: 'Resumed' });
            }
            return true;
        }
        this.logger.info('Resuming automation');
        return this.start({ scope: this.state.get().scope });
    }

    async stop() {
        if (!this.isRunning) {
            await this.state.update({ runStatus: RUN_STATUS.STOPPED, statusMessage: 'Stopped' });
            return;
        }
        this.stopRequested = true;
        this.logger.info('Stop requested');
        await this.state.update({ runStatus: RUN_STATUS.STOPPING, statusMessage: 'Stopping…' });
        this.abortController?.abort(new AbortedError('Stopped by user'));
        try {
            await this.adapter.abort?.();
        } catch {
            // best effort
        }
        await this.whenIdle();
    }

    /** Put a failed (or any non-running) job back in the queue with fresh retries. */
    async retryJob(number) {
        const job = this.state.getJob(number);
        if (!job) throw new Error(`Job ${number} not found`);
        if (this.state.get().currentJobNumber === number && this.isRunning) throw new Error(`Job ${number} is currently running`);
        await this.state.updateJob(number, resetJob(job));
        this.logger.info(`Job ${number} queued for retry`);
    }

    async retryFailed() {
        const failed = this.state.get().jobs.filter((j) => j.status === JOB_STATUS.FAILED).map((j) => j.number);
        for (const n of failed) await this.state.updateJob(n, (job) => resetJob(job));
        return failed;
    }

    /**
     * Called once when the service worker boots. If a run was in progress, the job that was
     * mid-flight is parked (PAUSED). `resume` decides whether processing continues automatically.
     */
    async restore({ resume }) {
        const s = this.state.get();
        const wasActive = [RUN_STATUS.RUNNING, RUN_STATUS.PAUSING, RUN_STATUS.WAITING_AUTH, RUN_STATUS.WAITING_PROJECT, RUN_STATUS.STOPPING].includes(s.runStatus);

        // A download that was already started may have finished while we were gone.
        for (const job of s.jobs) {
            if (job.status === JOB_STATUS.DOWNLOADING && job.downloadId != null && this.downloads?.lookupCompleted) {
                const done = await this.downloads.lookupCompleted(job.downloadId).catch(() => null);
                if (done) {
                    await this.state.updateJob(job.number, { status: JOB_STATUS.COMPLETED, outputFile: done.filename, error: null, finishedAt: Date.now() });
                    this.logger.info(`Job ${job.number}: download finished while the extension was inactive (${done.filename})`);
                }
            }
        }

        const jobs = markInterrupted(this.state.get().jobs, 'Interrupted by browser/extension restart');
        if (!wasActive) {
            await this.state.update({ jobs, currentJobNumber: null });
            return false;
        }
        if (resume && s.runStatus !== RUN_STATUS.STOPPING) {
            await this.state.update({ jobs, currentJobNumber: null });
            this.logger.info('Restored previous queue — resuming');
            return this.start({ scope: s.scope });
        }
        await this.state.update({
            jobs,
            currentJobNumber: null,
            runStatus: s.runStatus === RUN_STATUS.STOPPING ? RUN_STATUS.STOPPED : RUN_STATUS.PAUSED,
            statusMessage: 'Restored previous queue. Press Resume to continue.'
        });
        this.logger.info('Restored previous queue (Auto Resume is off — press Resume to continue)');
        return false;
    }

    // ───────────────────────────── main loop ─────────────────────────────

    async processQueue() {
        this.abortController = new AbortController();
        this.logger.info('Automation started');
        try {
            let needDelay = false;
            for (;;) {
                if (this.stopRequested) break;
                if (this.pauseRequested) {
                    await this.drainDownloads();
                    await this.state.update({ runStatus: RUN_STATUS.PAUSED, currentJobNumber: null, statusMessage: 'Paused' });
                    this.logger.info('Automation paused');
                    return;
                }
                const job = getNextJob(this.state.get().jobs, this.state.get().scope);
                if (!job) break;

                if (needDelay) {
                    needDelay = false;
                    const delay = this.getSettings().delayBetweenJobsMs;
                    if (delay > 0) {
                        await this.state.update({ statusMessage: `Waiting ${Math.round(delay / 1000)}s before job ${job.number}…` }, { immediate: false });
                        await this.sleep(delay, this.abortController.signal);
                        continue; // re-check pause/stop and re-pick (queue may have changed)
                    }
                }
                await this.runJobWithRetries(job.number);
                needDelay = true;
            }

            await this.drainDownloads();
            if (this.stopRequested) {
                await this.state.update({ runStatus: RUN_STATUS.STOPPED, currentJobNumber: null, statusMessage: 'Stopped' });
                this.logger.info('Automation stopped');
                return;
            }
            await this.finish();
        } catch (error) {
            await this.drainDownloads();
            if (isAbortError(error) || this.stopRequested) {
                await this.state.update({ runStatus: RUN_STATUS.STOPPED, currentJobNumber: null, statusMessage: 'Stopped' });
                this.logger.info('Automation stopped');
                return;
            }
            this.logger.error(`Automation error: ${error.message}`);
            this.emit('AUTOMATION_ERROR', { error: error.message });
            await this.state.update({ runStatus: RUN_STATUS.ERROR, currentJobNumber: null, statusMessage: `Error: ${error.message}` });
        } finally {
            this.abortController = null;
        }
    }

    async finish() {
        const summary = buildSummary(this.state.get().jobs);
        await this.state.update({ runStatus: RUN_STATUS.COMPLETED, currentJobNumber: null, summary, statusMessage: 'Automation complete' });
        this.logger.info(`Automation complete — ${summary.completed}/${summary.total} completed, ${summary.failed} failed`);
    }

    async runJobWithRetries(number) {
        const { maxRetries } = this.getSettings();
        let job = this.state.getJob(number);

        if (job.status === JOB_STATUS.PAUSED && job.interruptedStage) {
            if (job.retryCount >= maxRetries) {
                await this.failJob(number, job.error || 'Interrupted');
                return;
            }
            await this.state.updateJob(number, { retryCount: job.retryCount + 1, interruptedStage: null });
            this.logger.info(`Job ${number}: Retry #${job.retryCount + 1} (previous attempt was interrupted)`);
        }

        for (;;) {
            try {
                await this.processJob(this.state.getJob(number));
                return;
            } catch (error) {
                if (isAbortError(error) || this.stopRequested) {
                    await this.state.updateJob(number, (j) => ({ ...resetJob(j, { keepRetries: true }), error: 'Stopped before completion' }));
                    throw new AbortedError('Stopped by user');
                }
                if (error.code === 'AUTH_REQUIRED') {
                    await this.waitForAuthentication();
                    continue; // does not consume a retry
                }
                if (error.code === 'PROJECT_REQUIRED') {
                    await this.waitForProject();
                    continue; // does not consume a retry
                }
                if (error.code === 'QUOTA_EXCEEDED') {
                    // Respect Flow's limits: don't burn retries, park the job and pause the run.
                    await this.state.updateJob(number, (j) => ({ ...resetJob(j, { keepRetries: true }), error: error.message }));
                    this.pauseRequested = true;
                    this.logger.error(`Google Flow reported a usage limit: ${error.message} — pausing automation`);
                    this.emit('AUTOMATION_ERROR', { error: error.message, code: 'QUOTA_EXCEEDED' });
                    await this.state.update({ statusMessage: `Paused: Flow usage limit reached (${error.message})` });
                    return;
                }
                job = this.state.getJob(number);
                const message = error.message || String(error);
                this.logger.warn(`Job ${number} error at "${STATUS_LABELS[job.status] || job.status}": ${message}`);

                if (error.retryable !== false && job.retryCount < maxRetries) {
                    const attempt = job.retryCount + 1;
                    await this.state.updateJob(number, { status: JOB_STATUS.PENDING, retryCount: attempt, error: message });
                    this.logger.info(`Job ${number}: Retry #${attempt}`);
                    await this.state.update({ statusMessage: `Job ${number}: retry #${attempt} after error: ${message}` });
                    await this.sleep(this.retryBackoffMs, this.abortController?.signal);
                    continue;
                }
                await this.failJob(number, message);
                return;
            }
        }
    }

    async failJob(number, message) {
        await this.state.updateJob(number, { status: JOB_STATUS.FAILED, error: message, finishedAt: Date.now() });
        const job = this.state.getJob(number);
        this.logger.error(`Job ${number} failed after ${job.retryCount} retr${job.retryCount === 1 ? 'y' : 'ies'}: ${message}`);
        this.emit('JOB_FAILED', { number, error: message, retryCount: job.retryCount });
    }

    async waitForAuthentication() {
        await this.waitForUser({
            runStatus: RUN_STATUS.WAITING_AUTH,
            message: AUTH_MESSAGE,
            code: 'AUTH_REQUIRED',
            waitingLog: 'Google authentication required — waiting for manual login',
            isDone: (status) => status?.authenticated,
            doneLog: 'Authentication detected — continuing',
            doneMessage: 'Authenticated'
        });
    }

    async waitForProject() {
        await this.waitForUser({
            runStatus: RUN_STATUS.WAITING_PROJECT,
            message: PROJECT_MESSAGE,
            code: 'PROJECT_REQUIRED',
            waitingLog: 'No Flow project is open — waiting for the user to open one',
            isDone: (status) => status?.projectOpen !== false,
            doneLog: 'Flow project detected — continuing',
            doneMessage: 'Connected to the Flow project'
        });
    }

    /** Park the run until the user fixes something in the Flow tab (polls checkReady). */
    async waitForUser({ runStatus, message, code, waitingLog, isDone, doneLog, doneMessage }) {
        await this.state.update({ runStatus, statusMessage: message });
        this.logger.warn(waitingLog);
        this.emit('AUTOMATION_ERROR', { error: message, code });
        for (;;) {
            await this.sleep(this.authPollMs, this.abortController?.signal);
            if (this.stopRequested) throw new AbortedError('Stopped by user');
            const status = await this.adapter.checkReady().catch(() => null);
            if (status && isDone(status)) break;
        }
        this.logger.info(doneLog);
        await this.state.update({ runStatus: this.pauseRequested ? RUN_STATUS.PAUSING : RUN_STATUS.RUNNING, statusMessage: doneMessage });
    }

    // ───────────────────────────── one attempt ─────────────────────────────

    async processJob(job) {
        const n = job.number;
        const signal = this.abortController?.signal;
        await this.state.update({ currentJobNumber: n, statusMessage: `Job ${n}: preparing…` });

        const ready = await this.adapter.checkReady({ signal });
        if (ready && ready.authenticated === false) throw new AuthRequiredError();
        if (ready && ready.projectOpen === false) throw new ProjectRequiredError();
        if (ready && ready.ready === false) throw new Error(ready.reason || 'Google Flow is not ready');

        if (this.downloads?.assertOutputAvailable) await this.downloads.assertOutputAvailable(job);

        this.logger.info(`Job ${n} started`);
        this.emit('JOB_STARTED', { number: n });
        await this.setJobStatus(n, JOB_STATUS.GENERATING_VIDEO, { startedAt: Date.now(), error: null });

        const pendingVideo = await this.withPage(() => this.submitPrompt(job));
        await this.waitForGenerated(job, pendingVideo);

        // 100%: the next prompt can go now; this job's download finishes in the background.
        await this.state.updateJob(n, { status: JOB_STATUS.DOWNLOADING });
        this.emit('JOB_PROGRESS', { number: n, status: JOB_STATUS.DOWNLOADING });
        this.queueDownload(this.state.getJob(n), pendingVideo);
    }

    /** Run page interactions one at a time, so a download click never lands mid-typing. */
    withPage(fn) {
        const run = this.pageLock.then(fn, fn);
        this.pageLock = run.catch(() => {});
        return run;
    }

    queueDownload(job, pendingVideo) {
        this.logger.info(`Job ${job.number}: queued for download (next prompt can start)`);
        this.downloadChain = this.downloadChain.then(() => this.finishInBackground(job, pendingVideo)).catch(() => {});
    }

    /** Wait until every queued background download has finished (or failed). */
    async drainDownloads() {
        let chain;
        do {
            chain = this.downloadChain;
            await chain;
        } while (chain !== this.downloadChain);
    }

    /** Background part of a job: find its finished video, download it, complete the job. */
    async finishInBackground(job, pendingVideo) {
        const n = job.number;
        const { maxRetries } = this.getSettings();
        for (let attempt = 0; ; attempt++) {
            // Queued behind other downloads: after Stop, don't start this one at all.
            if (this.stopRequested || this.abortController?.signal.aborted) {
                await this.state.updateJob(n, (j) => ({ ...resetJob(j, { keepRetries: true }), error: 'Stopped before the download finished' }));
                return;
            }
            try {
                const video = await this.waitForVideo(job, pendingVideo);
                const result = await this.downloadVideo(job, video);
                await this.state.updateJob(n, { status: JOB_STATUS.COMPLETED, outputFile: result.filename, error: null, finishedAt: Date.now() });
                this.logger.info(`Saved: ${result.filename}`);
                this.logger.info(`Job ${n} completed`);
                this.emit('JOB_COMPLETED', { number: n, outputFile: result.filename });
                return;
            } catch (error) {
                if (isAbortError(error) || this.stopRequested) {
                    await this.state.updateJob(n, (j) => ({ ...resetJob(j, { keepRetries: true }), error: 'Stopped before the download finished' }));
                    return;
                }
                const message = error.message || String(error);
                // The video was already generated: retry only the download, never regenerate here.
                if (error.retryable !== false && error.code !== 'STATE_LOST' && attempt < maxRetries) {
                    this.logger.warn(`Job ${n}: download error (${message}) — retrying the download`);
                    await this.state.updateJob(n, (j) => ({ retryCount: j.retryCount + 1, error: message }));
                    await this.sleep(this.retryBackoffMs, this.abortController?.signal).catch(() => {});
                    continue;
                }
                await this.failJob(n, message);
                return;
            }
        }
    }

    async submitPrompt(job) {
        const settings = this.getSettings();
        this.logger.info(`Job ${job.number}: entering prompt in the main prompt box`);
        const pending = await this.adapter.submitPrompt(job.prompt, {
            signal: this.abortController?.signal,
            elementTimeoutMs: settings.elementTimeoutMs,
            onProgress: (detail) => this.progress(job.number, detail)
        });
        this.logger.info(`Job ${job.number}: video generation started`);
        return pending;
    }

    async waitForGenerated(job, pendingVideo) {
        const settings = this.getSettings();
        await this.adapter.waitForGenerated(pendingVideo, {
            signal: this.abortController?.signal,
            timeoutMs: settings.videoGenerationTimeoutMs,
            onProgress: (detail) => this.progress(job.number, detail)
        });
        this.logger.info(`Job ${job.number}: video generation completed (100%)`);
    }

    async waitForVideo(job, pendingVideo) {
        const settings = this.getSettings();
        // Background: no onProgress, so the status line keeps showing the prompt being generated.
        const video = await this.adapter.waitForVideo(pendingVideo, {
            signal: this.abortController?.signal,
            timeoutMs: settings.videoGenerationTimeoutMs,
            elementTimeoutMs: settings.elementTimeoutMs
        });
        if (!video) throw new Error('Generated video not found');
        return video;
    }

    async downloadVideo(job, video) {
        const settings = this.getSettings();
        const signal = this.abortController?.signal;
        const info = await this.adapter.getVideoDownloadInfo(video, { signal, elementTimeoutMs: settings.elementTimeoutMs });
        this.logger.info(`Job ${job.number}: download started`);
        return this.downloads.downloadVideo(info, job, {
            signal,
            timeoutMs: settings.downloadTimeoutMs,
            triggerNativeDownload: () => this.withPage(() => this.adapter.triggerNativeDownload(video, { signal, elementTimeoutMs: settings.elementTimeoutMs })),
            onStarted: async ({ downloadId }) => {
                await this.state.updateJob(job.number, { downloadId });
                this.emit('DOWNLOAD_STARTED', { number: job.number, downloadId });
            },
            onCompleted: ({ filename }) => this.emit('DOWNLOAD_COMPLETED', { number: job.number, filename })
        });
    }

    async setJobStatus(number, status, extra = {}) {
        await this.state.updateJob(number, { status, ...extra });
        await this.state.update({ statusMessage: `Job ${number}: ${STATUS_LABELS[status]}…` });
        this.emit('JOB_PROGRESS', { number, status });
    }

    progress(number, detail) {
        if (!detail) return;
        const text = typeof detail === 'string' ? detail : detail.message;
        if (!text) return;
        this.logger.debug(`Job ${number}: ${text}`);
        this.state.update({ statusMessage: `Job ${number}: ${text}` }, { immediate: false }).catch(() => {});
        this.emit('JOB_PROGRESS', { number, detail: text });
    }

    getStats() {
        const s = this.state.get();
        return getStats(s.jobs, s.currentJobNumber);
    }
}
