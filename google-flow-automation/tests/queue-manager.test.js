import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrompts } from '../src/utils/prompt-parser.js';
import {
    buildQueue,
    mergeQueue,
    getNextJob,
    getStats,
    markInterrupted,
    buildSummary,
    resetJob,
    JOB_STATUS
} from '../src/core/queue-manager.js';
import { StateManager, MemoryStorage } from '../src/core/state-manager.js';

const queueFrom = (text) => buildQueue(parsePrompts(text).prompts);

test('Phase 1 check: "1] prompt 1 / 2] prompt 2 / 3] prompt 3" becomes Job 1, 2, 3', () => {
    const jobs = queueFrom('1] prompt 1\n2] prompt 2\n3] prompt 3');
    assert.deepEqual(jobs.map((j) => [j.number, j.prompt]), [[1, 'prompt 1'], [2, 'prompt 2'], [3, 'prompt 3']]);
});

test('job objects have the documented shape', () => {
    const [job] = queueFrom('1] A cinematic futuristic city');
    assert.equal(job.number, 1);
    assert.equal(job.prompt, 'A cinematic futuristic city');
    assert.equal(job.status, 'pending');
    assert.equal(job.retryCount, 0);
    assert.equal(job.error, null);
    assert.equal(job.outputFile, null);
});

test('user numbers are preserved (10, 20, 30)', () => {
    const jobs = queueFrom('10] First prompt\n20] Second prompt\n30] Third prompt');
    assert.deepEqual(jobs.map(({ number, prompt }) => ({ number, prompt })), [
        { number: 10, prompt: 'First prompt' },
        { number: 20, prompt: 'Second prompt' },
        { number: 30, prompt: 'Third prompt' }
    ]);
});

test('getNextJob returns first runnable job in input order, honouring scope', () => {
    const jobs = queueFrom('5] a\n1] b\n9] c');
    jobs[0].status = JOB_STATUS.COMPLETED;
    assert.equal(getNextJob(jobs).number, 1);
    jobs[1].status = JOB_STATUS.FAILED;
    assert.equal(getNextJob(jobs).number, 9);
    assert.equal(getNextJob(jobs, { numbers: [1] }), null, 'failed job is not runnable');
    jobs[2].status = JOB_STATUS.PAUSED;
    assert.equal(getNextJob(jobs).number, 9, 'paused (interrupted) jobs are runnable');
    assert.equal(getNextJob(jobs, { numbers: [5] }), null);
});

test('mergeQueue keeps completed jobs with unchanged prompt, resets everything else', () => {
    const old = queueFrom('1] a\n2] b\n3] c');
    old[0] = { ...old[0], status: 'completed', outputFile: '1.mp4' };
    old[1] = { ...old[1], status: 'completed', outputFile: '2.mp4' };
    old[2] = { ...old[2], status: 'failed', error: 'x', retryCount: 2 };
    const merged = mergeQueue(old, parsePrompts('1] a\n2] b CHANGED\n3] c\n4] d').prompts);
    assert.deepEqual(merged.map((j) => [j.number, j.status, j.outputFile]), [
        [1, 'completed', '1.mp4'],
        [2, 'pending', null],
        [3, 'pending', null],
        [4, 'pending', null]
    ]);
    assert.equal(merged[2].retryCount, 0);
});

test('stats', () => {
    const jobs = queueFrom('1] a\n2] b\n3] c\n4] d');
    jobs[0].status = 'completed';
    jobs[1].status = 'failed';
    jobs[2].status = 'generating_video';
    const s = getStats(jobs, 3);
    assert.deepEqual({ ...s }, { total: 4, completed: 1, failed: 1, pending: 1, active: 1, current: 3, done: 2 });
});

test('markInterrupted parks only mid-flight jobs and never touches completed ones', () => {
    const jobs = queueFrom('1] a\n2] b\n3] c\n4] d\n5] e');
    jobs[0].status = 'completed';
    jobs[1].status = 'completed';
    jobs[2].status = 'generating_video';
    const out = markInterrupted(jobs, 'Interrupted');
    assert.deepEqual(out.map((j) => j.status), ['completed', 'completed', 'paused', 'pending', 'pending']);
    assert.equal(out[2].interruptedStage, 'generating_video');
    assert.match(out[2].error, /Generating video/);
});

test('resetJob', () => {
    const job = { ...queueFrom('1] a')[0], status: 'failed', retryCount: 2, error: 'x', outputFile: 'y' };
    assert.deepEqual([resetJob(job).status, resetJob(job).retryCount, resetJob(job).error], ['pending', 0, null]);
    assert.equal(resetJob(job, { keepRetries: true }).retryCount, 2);
});

test('buildSummary', () => {
    const jobs = queueFrom('1] a\n7] b\n19] c');
    Object.assign(jobs[0], { status: 'completed', outputFile: '1.mp4' });
    Object.assign(jobs[1], { status: 'failed', error: 'Video generation timeout' });
    Object.assign(jobs[2], { status: 'failed', error: 'Download failed' });
    assert.deepEqual(buildSummary(jobs), {
        total: 3,
        completed: 1,
        failed: 2,
        files: ['1.mp4'],
        failures: [
            { number: 7, error: 'Video generation timeout' },
            { number: 19, error: 'Download failed' }
        ]
    });
});

test('StateManager persists and restores the queue', async () => {
    const storage = new MemoryStorage();
    const a = new StateManager({ storage });
    await a.load();
    await a.update({ jobs: queueFrom('1] a\n2] b'), promptsText: '1] a\n2] b' });
    await a.updateJob(1, { status: 'completed', outputFile: '1.mp4' });

    const b = new StateManager({ storage });
    await b.load();
    assert.equal(b.get().jobs.length, 2);
    assert.equal(b.getJob(1).status, 'completed');
    assert.equal(b.getJob(1).outputFile, '1.mp4');
    assert.equal(b.get().promptsText, '1] a\n2] b');
});

test('large queue stays lightweight (100 jobs < 40 KB serialized)', () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i + 1}] A cinematic shot number ${i + 1}, ultra realistic, 4K`).join('\n');
    const size = JSON.stringify(queueFrom(text)).length;
    assert.ok(size < 40_000, `serialized size ${size}`);
});
