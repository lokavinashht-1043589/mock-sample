import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowAutomationEngine } from '../src/core/automation-engine.js';
import { StateManager, MemoryStorage, RUN_STATUS } from '../src/core/state-manager.js';
import { buildQueue } from '../src/core/queue-manager.js';
import { DownloadManager } from '../src/core/download-manager.js';
import { Logger } from '../src/core/logger.js';
import { normalizeSettings } from '../src/core/settings.js';
import { parsePrompts } from '../src/utils/prompt-parser.js';
import { MockFlowAdapter } from './mocks/mock-flow-adapter.js';
import { FakeDownloads, EXT_ID } from './mocks/fake-downloads.js';

async function setup({ text = '1] A\n2] B\n3] C', adapter = new MockFlowAdapter(), settings = {}, downloads = new FakeDownloads(), state = null } = {}) {
    const s = normalizeSettings({ delayBetweenJobsMs: 0, ...settings });
    const getSettings = () => s;
    const logger = new Logger({ debugMode: true });
    const stateManager = new StateManager({ storage: new MemoryStorage() });
    await stateManager.load();
    await stateManager.update(state || { jobs: buildQueue(parsePrompts(text).prompts) });
    const downloadManager = new DownloadManager({ api: downloads, getSettings, logger, extensionId: EXT_ID, pollMs: 5, nativeClaimTimeoutMs: 500 });
    downloads.determine = (item, suggest) => downloadManager.handleDeterminingFilename(item, suggest);
    const events = [];
    const statuses = [];
    stateManager.subscribe((st) => statuses.push(st.runStatus));
    const engine = new FlowAutomationEngine({
        stateManager,
        adapter,
        downloadManager,
        logger,
        getSettings,
        emit: (type, payload) => events.push({ type, ...payload }),
        authPollMs: 1,
        retryBackoffMs: 0
    });
    return { engine, stateManager, adapter, downloads, logger, events, statuses, settings: s };
}

const jobsOf = (sm) => sm.get().jobs.map((j) => ({ n: j.number, status: j.status, file: j.outputFile, retries: j.retryCount }));

async function runToEnd(engine) {
    await engine.start();
    await engine.whenIdle();
}

test('generates one prompt at a time, in order, and names files by number', async () => {
    const { engine, stateManager, adapter, events } = await setup({ text: '1] A\n2] B\n10] C' });
    await runToEnd(engine);

    assert.deepEqual(jobsOf(stateManager), [
        { n: 1, status: 'completed', file: '1.mp4', retries: 0 },
        { n: 2, status: 'completed', file: '2.mp4', retries: 0 },
        { n: 10, status: 'completed', file: '10.mp4', retries: 0 }
    ]);
    assert.equal(adapter.maxActive, 1);
    const steps = adapter.calls.filter((c) => c !== 'checkReady');
    assert.deepEqual(adapter.promptsFor('submitPrompt'), ['A', 'B', 'C']);
    for (const p of ['A', 'B', 'C']) {
        const mine = steps.filter((s) => s.endsWith(`:${p}`));
        assert.deepEqual(mine, [`submitPrompt:${p}`, `waitForGenerated:${p}`, `waitForVideo:${p}`, `getVideoDownloadInfo:${p}`]);
    }
    // the next prompt is only typed once the previous one reached 100%
    assert.ok(steps.indexOf('waitForGenerated:A') < steps.indexOf('submitPrompt:B'));
    assert.ok(steps.indexOf('waitForGenerated:B') < steps.indexOf('submitPrompt:C'));
    assert.equal(stateManager.get().runStatus, RUN_STATUS.COMPLETED);
    assert.deepEqual(stateManager.get().summary.files, ['1.mp4', '2.mp4', '10.mp4']);
    assert.ok(events.some((e) => e.type === 'DOWNLOAD_COMPLETED' && e.number === 10));
});

test('prompt is passed to Flow exactly, without the number prefix', async () => {
    const text = '1] A highly detailed cinematic shot of a futuristic city, neon lights, rain, 4K';
    const { engine, adapter } = await setup({ text });
    await runToEnd(engine);
    assert.deepEqual(adapter.promptsFor('submitPrompt'), ['A highly detailed cinematic shot of a futuristic city, neon lights, rain, 4K']);
});

test('the next prompt starts at 100% while the previous download runs in the background', async () => {
    const order = [];
    const downloads = new FakeDownloads({ completeDelayMs: 30 });
    const origEmit = downloads.emit.bind(downloads);
    downloads.emit = (delta) => {
        if (delta.state?.current === 'complete') order.push(`downloaded:${delta.id}`);
        origEmit(delta);
    };
    const adapter = new MockFlowAdapter({ onStep: (name, prompt) => name === 'submitPrompt' && order.push(`start:${prompt}`) });
    const { engine } = await setup({ text: '1] A\n2] B', adapter, downloads });
    await runToEnd(engine);
    assert.deepEqual(order, ['start:A', 'start:B', 'downloaded:1', 'downloaded:2']);
});

test('a failing download is retried without regenerating the video (retryCount recorded)', async () => {
    const adapter = new MockFlowAdapter({ failures: { waitForVideo: [new Error('Video generation timed out'), new Error('Video generation timed out')] } });
    const { engine, stateManager } = await setup({ text: '1] A\n2] B', adapter });
    await runToEnd(engine);
    assert.deepEqual(jobsOf(stateManager)[0], { n: 1, status: 'completed', file: '1.mp4', retries: 2 });
    assert.equal(adapter.promptsFor('submitPrompt').filter((p) => p === 'A').length, 1);
});

test('after max retries the job fails, error is stored, and the queue continues', async () => {
    const err = () => new Error('Video generation timed out');
    const adapter = new MockFlowAdapter({ failures: { waitForVideo: [err(), err(), err()] } });
    const { engine, stateManager, events } = await setup({ text: '1] A\n2] B', adapter });
    await runToEnd(engine);
    const [j1, j2] = stateManager.get().jobs;
    assert.equal(j1.status, 'failed');
    assert.equal(j1.error, 'Video generation timed out');
    assert.equal(j1.retryCount, 2);
    assert.equal(j2.status, 'completed');
    assert.deepEqual(stateManager.get().summary.failures, [{ number: 1, error: 'Video generation timed out' }]);
    assert.ok(events.some((e) => e.type === 'JOB_FAILED' && e.number === 1));
});

test('maxRetries setting is honoured (0 = no retry)', async () => {
    const adapter = new MockFlowAdapter({ failures: { submitPrompt: [new Error('x')] } });
    const { engine, stateManager } = await setup({ text: '1] A', adapter, settings: { maxRetries: 0 } });
    await runToEnd(engine);
    assert.equal(stateManager.getJob(1).status, 'failed');
    assert.equal(adapter.promptsFor('submitPrompt').length, 1);
});

test('non-retryable errors (content policy) fail immediately', async () => {
    const policy = Object.assign(new Error('Flow content policy: blocked'), { code: 'CONTENT_POLICY', retryable: false });
    const adapter = new MockFlowAdapter({ failures: { submitPrompt: [policy] } });
    const { engine, stateManager } = await setup({ text: '1] A\n2] B', adapter });
    await runToEnd(engine);
    assert.equal(stateManager.getJob(1).status, 'failed');
    assert.equal(stateManager.getJob(1).retryCount, 0);
    assert.equal(stateManager.getJob(2).status, 'completed');
});

test('authentication required: waits for login without consuming retries', async () => {
    const adapter = new MockFlowAdapter({ ready: [{ ready: false, authenticated: false }, { authenticated: false }, { authenticated: true }] });
    const { engine, stateManager, statuses } = await setup({ text: '1] A', adapter });
    await runToEnd(engine);
    assert.equal(stateManager.getJob(1).status, 'completed');
    assert.equal(stateManager.getJob(1).retryCount, 0);
    assert.ok(statuses.includes(RUN_STATUS.WAITING_AUTH));
});

test('no Flow project open: waits for the user to open one without consuming retries', async () => {
    const adapter = new MockFlowAdapter({
        ready: [{ ready: false, authenticated: true, projectOpen: false }, { authenticated: true, projectOpen: false }, { ready: true, authenticated: true, projectOpen: true }]
    });
    const { engine, stateManager, statuses } = await setup({ text: '1] A', adapter });
    await runToEnd(engine);
    assert.equal(stateManager.getJob(1).status, 'completed');
    assert.equal(stateManager.getJob(1).retryCount, 0);
    assert.ok(statuses.includes(RUN_STATUS.WAITING_PROJECT));
});

test('pause lets the current job finish, then stops before the next; resume continues', async () => {
    let engineRef;
    const adapter = new MockFlowAdapter({ onStep: (name, prompt) => name === 'waitForVideo' && prompt === 'A' && engineRef.pause() });
    const { engine, stateManager } = await setup({ text: '1] A\n2] B\n3] C', adapter });
    engineRef = engine;
    await runToEnd(engine);
    assert.equal(stateManager.get().runStatus, RUN_STATUS.PAUSED);
    assert.deepEqual(jobsOf(stateManager).map((j) => j.status), ['completed', 'pending', 'pending']);

    await engine.resume();
    await engine.whenIdle();
    assert.deepEqual(jobsOf(stateManager).map((j) => j.status), ['completed', 'completed', 'completed']);
    assert.deepEqual(adapter.promptsFor('submitPrompt'), ['A', 'B', 'C']);
});

test('stop aborts the current job, preserves completed ones; start again resumes from there', async () => {
    let engineRef;
    const adapter = new MockFlowAdapter({
        hang: { waitForVideo: (p) => p === 'B' && !adapter.releaseB },
        onStep: (name, prompt) => {
            if (name === 'waitForVideo' && prompt === 'B' && !adapter.releaseB) setTimeout(() => engineRef.stop(), 5);
        }
    });
    const { engine, stateManager } = await setup({ text: '1] A\n2] B\n3] C', adapter });
    engineRef = engine;
    await engine.start();
    await engine.whenIdle();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stateManager.get().runStatus, RUN_STATUS.STOPPED);
    assert.deepEqual(jobsOf(stateManager).map((j) => j.status), ['completed', 'pending', 'pending']);
    assert.ok(adapter.aborted >= 1, 'adapter.abort() called');

    adapter.releaseB = true;
    await runToEnd(engine);
    assert.deepEqual(jobsOf(stateManager).map((j) => j.status), ['completed', 'completed', 'completed']);
    assert.equal(adapter.promptsFor('submitPrompt').filter((p) => p === 'A').length, 1, 'job 1 not re-run');
});

test('restart restore without Auto Resume: queue restored, nothing starts, completed jobs kept', async () => {
    const jobs = buildQueue(parsePrompts('1] A\n2] B\n3] C\n4] D\n5] E').prompts);
    jobs[0].status = 'completed';
    jobs[0].outputFile = '1.mp4';
    jobs[1].status = 'completed';
    jobs[1].outputFile = '2.mp4';
    jobs[2].status = 'generating_video';
    const { engine, stateManager, adapter } = await setup({ state: { jobs, runStatus: RUN_STATUS.RUNNING, currentJobNumber: 3 } });

    const started = await engine.restore({ resume: false });
    assert.equal(started, false);
    assert.equal(engine.isRunning, false);
    assert.equal(stateManager.get().runStatus, RUN_STATUS.PAUSED);
    assert.deepEqual(jobsOf(stateManager).map((j) => j.status), ['completed', 'completed', 'paused', 'pending', 'pending']);
    assert.equal(adapter.calls.length, 0, 'no Flow activity before the user resumes');

    await engine.resume();
    await engine.whenIdle();
    assert.deepEqual(adapter.promptsFor('submitPrompt'), ['C', 'D', 'E'], 'jobs 1 and 2 are not restarted');
    assert.equal(stateManager.getJob(3).retryCount, 1, 'interrupted job counts as a retry');
});

test('restart restore with Auto Resume starts processing', async () => {
    const jobs = buildQueue(parsePrompts('1] A\n2] B').prompts);
    jobs[0].status = 'animating';
    const { engine, stateManager } = await setup({ state: { jobs, runStatus: RUN_STATUS.RUNNING } });
    assert.equal(await engine.restore({ resume: true }), true);
    await engine.whenIdle();
    assert.deepEqual(jobsOf(stateManager).map((j) => j.status), ['completed', 'completed']);
});

test('restore when idle does not start anything', async () => {
    const { engine } = await setup({ state: { jobs: buildQueue(parsePrompts('1] A').prompts), runStatus: RUN_STATUS.STOPPED } });
    assert.equal(await engine.restore({ resume: true }), false);
    assert.equal(engine.isRunning, false);
});

test('restore: a download that finished while the worker was down marks the job completed', async () => {
    const downloads = new FakeDownloads();
    const done = downloads.makeItem({ rel: '1.mp4', state: 'complete' });
    downloads.items.push(done);
    const jobs = buildQueue(parsePrompts('1] A').prompts);
    Object.assign(jobs[0], { status: 'downloading', downloadId: done.id });
    const { engine, stateManager, adapter } = await setup({ downloads, state: { jobs, runStatus: RUN_STATUS.RUNNING } });
    await engine.restore({ resume: false });
    assert.equal(stateManager.getJob(1).status, 'completed');
    assert.equal(stateManager.getJob(1).outputFile, '1.mp4');
    assert.equal(adapter.calls.length, 0);
});

test('Flow usage limit pauses the whole queue instead of burning retries', async () => {
    const quota = Object.assign(new Error('Flow: daily limit reached'), { code: 'QUOTA_EXCEEDED', retryable: false });
    const adapter = new MockFlowAdapter({ failures: { submitPrompt: [null, quota] } });
    const { engine, stateManager } = await setup({ text: '1] A\n2] B\n3] C', adapter });
    await runToEnd(engine);
    assert.equal(stateManager.get().runStatus, RUN_STATUS.PAUSED);
    assert.deepEqual(jobsOf(stateManager).map((j) => [j.status, j.retries]), [['completed', 0], ['pending', 0], ['pending', 0]]);
});

test('retry failed jobs only processes failed jobs', async () => {
    const jobs = buildQueue(parsePrompts('1] A\n2] B\n3] C').prompts);
    Object.assign(jobs[0], { status: 'completed', outputFile: '1.mp4' });
    Object.assign(jobs[1], { status: 'failed', error: 'x', retryCount: 2 });
    const { engine, stateManager, adapter } = await setup({ state: { jobs } });
    const numbers = await engine.retryFailed();
    assert.deepEqual(numbers, [2]);
    await engine.start({ scope: { numbers } });
    await engine.whenIdle();
    assert.deepEqual(adapter.promptsFor('submitPrompt'), ['B']);
    assert.deepEqual(jobsOf(stateManager).map((j) => j.status), ['completed', 'completed', 'pending']);
});

test('retryJob requeues a single job', async () => {
    const jobs = buildQueue(parsePrompts('1] A\n2] B').prompts);
    Object.assign(jobs[0], { status: 'failed', error: 'x', retryCount: 2 });
    Object.assign(jobs[1], { status: 'completed' });
    const { engine, stateManager } = await setup({ state: { jobs } });
    await engine.retryJob(1);
    assert.deepEqual([stateManager.getJob(1).status, stateManager.getJob(1).retryCount, stateManager.getJob(1).error], ['pending', 0, null]);
});

test('"Prevent overwrite": existing output fails the job before any generation', async () => {
    const downloads = new FakeDownloads({ existingFiles: ['1.mp4'] });
    const { engine, stateManager, adapter } = await setup({ text: '1] A\n2] B', downloads });
    await runToEnd(engine);
    assert.equal(stateManager.getJob(1).status, 'failed');
    assert.match(stateManager.getJob(1).error, /already exists: 1\.mp4/);
    assert.equal(stateManager.getJob(1).retryCount, 0);
    assert.deepEqual(adapter.promptsFor('submitPrompt'), ['B']);
});

test('configured timeouts are passed to the adapter', async () => {
    const seen = {};
    const adapter = new MockFlowAdapter();
    const orig = { submit: adapter.submitPrompt.bind(adapter), wait: adapter.waitForVideo.bind(adapter) };
    adapter.submitPrompt = (p, o) => ((seen.element = o.elementTimeoutMs), orig.submit(p, o));
    adapter.waitForVideo = (v, o) => ((seen.video = o.timeoutMs), orig.wait(v, o));
    const { engine } = await setup({ text: '1] A', adapter, settings: { elementTimeoutMs: 12_000, videoGenerationTimeoutMs: 456_000 } });
    await runToEnd(engine);
    assert.deepEqual(seen, { element: 12_000, video: 456_000 });
});

test('logs the documented milestones', async () => {
    const { engine, logger } = await setup({ text: '1] A' });
    await runToEnd(engine);
    const text = logger.entries.map((e) => e.message).join('\n');
    for (const line of ['Automation started', 'Job 1 started', 'entering prompt in the main prompt box', 'video generation started', 'video generation completed', 'download started', 'Saved: 1.mp4', 'Job 1 completed']) {
        assert.ok(text.includes(line), `missing log "${line}"`);
    }
});
