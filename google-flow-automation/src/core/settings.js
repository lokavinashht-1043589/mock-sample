/** Single source of truth for settings and their defaults. */

// The ONE place the Flow URL default lives. labs.google/fx/tools/flow redirects here (verified 2026-09).
export const DEFAULT_FLOW_URL = 'https://flow.google.com/';

export const DEFAULT_SETTINGS = Object.freeze({
    flowUrl: DEFAULT_FLOW_URL,
    maxRetries: 2,
    videoGenerationTimeoutMs: 10 * 60 * 1000,
    downloadTimeoutMs: 5 * 60 * 1000,
    elementTimeoutMs: 30 * 1000,
    delayBetweenJobsMs: 0, // pause after a prompt reaches 100% before typing the next one
    filenamePrefix: '',
    downloadSubfolder: '',
    duplicateBehavior: 'prevent', // prevent | suffix | overwrite
    autoResume: false,
    debugMode: false,
    selectorOverrides: '' // JSON string, see README "Updating selectors"
});

const clampInt = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
};

/** Coerce anything read from storage / the options form into a valid settings object. */
export function normalizeSettings(input = {}) {
    const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
    const d = DEFAULT_SETTINGS;
    let flowUrl = String(s.flowUrl || '').trim();
    try {
        const u = new URL(flowUrl);
        if (u.protocol !== 'https:') throw new Error('https only');
        flowUrl = u.href;
    } catch {
        flowUrl = d.flowUrl;
    }
    return {
        flowUrl,
        maxRetries: clampInt(s.maxRetries, 0, 10, d.maxRetries),
        videoGenerationTimeoutMs: clampInt(s.videoGenerationTimeoutMs, 10_000, 2 * 60 * 60_000, d.videoGenerationTimeoutMs),
        downloadTimeoutMs: clampInt(s.downloadTimeoutMs, 10_000, 60 * 60_000, d.downloadTimeoutMs),
        elementTimeoutMs: clampInt(s.elementTimeoutMs, 1_000, 10 * 60_000, d.elementTimeoutMs),
        delayBetweenJobsMs: clampInt(s.delayBetweenJobsMs, 0, 60 * 60_000, d.delayBetweenJobsMs),
        filenamePrefix: String(s.filenamePrefix ?? ''),
        downloadSubfolder: String(s.downloadSubfolder ?? ''),
        duplicateBehavior: ['prevent', 'suffix', 'overwrite'].includes(s.duplicateBehavior) ? s.duplicateBehavior : d.duplicateBehavior,
        autoResume: Boolean(s.autoResume),
        debugMode: Boolean(s.debugMode),
        selectorOverrides: String(s.selectorOverrides ?? '')
    };
}

export const STORAGE_KEYS = Object.freeze({
    SETTINGS: 'gfa.settings',
    STATE: 'gfa.state',
    LOGS: 'gfa.logs',
    DOWNLOAD_ROOT: 'gfa.downloadRoot', // Chrome's download folder, learned from our last saved video
    SESSION_MARKER: 'gfa.sessionAlive' // chrome.storage.session
});
