/** Small, dependency-free helpers shared by background, popup and tests. */

export const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(signal));
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, Math.max(0, ms));
        function onAbort() {
            clearTimeout(timer);
            reject(abortError(signal));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });

export class AbortedError extends Error {
    constructor(message = 'Operation aborted') {
        super(message);
        this.name = 'AbortedError';
        this.code = 'ABORTED';
    }
}

function abortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new AbortedError();
}

export function isAbortError(error) {
    return error?.code === 'ABORTED' || error?.name === 'AbortedError' || error?.name === 'AbortError';
}

export class TimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
        this.code = 'TIMEOUT';
    }
}

export function withTimeout(promise, ms, message = `Timed out after ${ms} ms`) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new TimeoutError(message)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

export function formatClock(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function truncate(text, max = 40) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Serialize an unknown error into a plain object that survives chrome messaging / storage. */
export function serializeError(error) {
    if (!error) return { message: 'Unknown error' };
    if (typeof error === 'string') return { message: error };
    return {
        message: error.message || String(error),
        code: error.code || null,
        retryable: error.retryable !== false
    };
}

export function toError(serialized) {
    const err = new Error(serialized?.message || 'Unknown error');
    if (serialized?.code) err.code = serialized.code;
    if (serialized?.retryable === false) err.retryable = false;
    return err;
}
