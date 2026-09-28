import { STORAGE_KEYS } from './settings.js';

export const RUN_STATUS = Object.freeze({
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSING: 'pausing', // pause requested, finishing current job
    PAUSED: 'paused',
    WAITING_AUTH: 'waiting_auth',
    STOPPING: 'stopping',
    STOPPED: 'stopped',
    COMPLETED: 'completed',
    ERROR: 'error'
});

export function createInitialState() {
    return {
        version: 1,
        promptsText: '',
        jobs: [],
        currentJobNumber: null,
        runStatus: RUN_STATUS.IDLE,
        statusMessage: 'Ready',
        scope: null, // null = all jobs; { numbers: [...] } = retry subset
        summary: null,
        flowTabId: null,
        updatedAt: Date.now()
    };
}

/** In-memory storage with the chrome.storage.local shape, for tests. */
export class MemoryStorage {
    constructor(initial = {}) {
        this.data = { ...initial };
    }
    async get(key) {
        return key in this.data ? { [key]: structuredClone(this.data[key]) } : {};
    }
    async set(items) {
        for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
    }
}

/**
 * Owns the persisted automation state. Every mutation goes through update() which
 * persists (debounced for frequent, cheap updates) and notifies subscribers.
 */
export class StateManager {
    constructor({ storage, key = STORAGE_KEYS.STATE, persistDelayMs = 0 } = {}) {
        this.storage = storage;
        this.key = key;
        this.persistDelayMs = persistDelayMs;
        this.state = createInitialState();
        this.listeners = new Set();
        this.pendingPersist = null;
    }

    async load() {
        const stored = (await this.storage.get(this.key))[this.key];
        if (stored && typeof stored === 'object' && Array.isArray(stored.jobs)) {
            this.state = { ...createInitialState(), ...stored };
        }
        return this.state;
    }

    get() {
        return this.state;
    }

    getJob(number) {
        return this.state.jobs.find((j) => j.number === number) || null;
    }

    /** Shallow-merge a patch (object or fn(state) => patch) and persist. */
    async update(patch, { immediate = true } = {}) {
        const delta = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = { ...this.state, ...delta, updatedAt: Date.now() };
        this.emit();
        await this.persist(immediate);
        return this.state;
    }

    async updateJob(number, patch) {
        return this.update((state) => ({
            jobs: state.jobs.map((job) =>
                job.number === number ? { ...job, ...(typeof patch === 'function' ? patch(job) : patch) } : job
            )
        }));
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit() {
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch {
                // ignore listener errors
            }
        }
    }

    async persist(immediate) {
        if (immediate || !this.persistDelayMs) {
            clearTimeout(this.pendingPersist);
            this.pendingPersist = null;
            await this.storage.set({ [this.key]: this.state });
            return;
        }
        if (this.pendingPersist) return;
        this.pendingPersist = setTimeout(() => {
            this.pendingPersist = null;
            this.storage.set({ [this.key]: this.state }).catch(() => {});
        }, this.persistDelayMs);
    }
}
