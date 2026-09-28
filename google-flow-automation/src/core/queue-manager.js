/**
 * Pure queue logic: building jobs, choosing the next job, stats, summaries.
 * No Chrome APIs here, so everything is unit-testable.
 */

export const JOB_STATUS = Object.freeze({
    PENDING: 'pending',
    GENERATING_IMAGE: 'generating_image',
    IMAGE_READY: 'image_ready',
    ANIMATING: 'animating',
    GENERATING_VIDEO: 'generating_video',
    VIDEO_READY: 'video_ready',
    DOWNLOADING: 'downloading',
    COMPLETED: 'completed',
    FAILED: 'failed',
    PAUSED: 'paused' // interrupted mid-flight (stop/restart); resumes as a retry
});

export const ACTIVE_STATUSES = new Set([
    JOB_STATUS.GENERATING_IMAGE,
    JOB_STATUS.IMAGE_READY,
    JOB_STATUS.ANIMATING,
    JOB_STATUS.GENERATING_VIDEO,
    JOB_STATUS.VIDEO_READY,
    JOB_STATUS.DOWNLOADING
]);

export const RUNNABLE_STATUSES = new Set([JOB_STATUS.PENDING, JOB_STATUS.PAUSED]);

export const STATUS_LABELS = Object.freeze({
    pending: 'Pending',
    generating_image: 'Generating image',
    image_ready: 'Image ready',
    animating: 'Animating',
    generating_video: 'Generating video',
    video_ready: 'Video ready',
    downloading: 'Downloading',
    completed: 'Completed',
    failed: 'Failed',
    paused: 'Paused'
});

export function createJob({ number, label, prompt }) {
    return {
        number,
        label: label ?? String(number),
        prompt,
        status: JOB_STATUS.PENDING,
        retryCount: 0,
        error: null,
        outputFile: null,
        downloadId: null,
        startedAt: null,
        finishedAt: null
    };
}

export function buildQueue(parsedPrompts) {
    return parsedPrompts.map(createJob);
}

/**
 * Re-validating the same prompts must not throw away finished work.
 * A completed job is kept when its number AND prompt are unchanged; everything else is fresh.
 */
export function mergeQueue(existingJobs, parsedPrompts) {
    const previous = new Map((existingJobs || []).map((job) => [job.number, job]));
    return parsedPrompts.map((p) => {
        const old = previous.get(p.number);
        if (old && old.prompt === p.prompt && old.status === JOB_STATUS.COMPLETED) {
            return { ...old, label: p.label ?? old.label };
        }
        return createJob(p);
    });
}

/** Next job to run: first runnable job (queue order) inside the optional scope. */
export function getNextJob(jobs, scope = null) {
    const allowed = scope && Array.isArray(scope.numbers) ? new Set(scope.numbers) : null;
    return jobs.find((job) => RUNNABLE_STATUSES.has(job.status) && (!allowed || allowed.has(job.number))) || null;
}

export function getStats(jobs, currentNumber = null) {
    const stats = { total: jobs.length, completed: 0, failed: 0, pending: 0, active: 0, current: currentNumber };
    for (const job of jobs) {
        if (job.status === JOB_STATUS.COMPLETED) stats.completed++;
        else if (job.status === JOB_STATUS.FAILED) stats.failed++;
        else if (ACTIVE_STATUSES.has(job.status)) stats.active++;
        else stats.pending++;
    }
    stats.done = stats.completed + stats.failed;
    return stats;
}

export function resetJob(job, { keepRetries = false } = {}) {
    return {
        ...job,
        status: JOB_STATUS.PENDING,
        retryCount: keepRetries ? job.retryCount : 0,
        error: null,
        outputFile: keepRetries ? job.outputFile : null,
        downloadId: null,
        finishedAt: null
    };
}

/**
 * After a browser/extension restart, a job that was mid-flight cannot be resumed at the exact
 * DOM step (the page state is gone), so it is parked as PAUSED. When processing resumes it
 * runs again and that counts as a retry — this is the only case where the same prompt is
 * submitted twice, and it's because the previous submission's result is unrecoverable.
 */
export function markInterrupted(jobs, reason = 'Interrupted') {
    return jobs.map((job) =>
        ACTIVE_STATUSES.has(job.status)
            ? { ...job, status: JOB_STATUS.PAUSED, error: `${reason} during "${STATUS_LABELS[job.status]}"`, interruptedStage: job.status }
            : job
    );
}

export function buildSummary(jobs) {
    const completed = jobs.filter((j) => j.status === JOB_STATUS.COMPLETED);
    const failed = jobs.filter((j) => j.status === JOB_STATUS.FAILED);
    return {
        total: jobs.length,
        completed: completed.length,
        failed: failed.length,
        files: completed.map((j) => j.outputFile).filter(Boolean),
        failures: failed.map((j) => ({ number: j.number, error: j.error || 'Unknown error' }))
    };
}

export function isQueueFinished(jobs, scope = null) {
    return getNextJob(jobs, scope) === null;
}
