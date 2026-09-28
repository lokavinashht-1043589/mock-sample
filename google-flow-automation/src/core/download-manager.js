import {
    getOutputFilename,
    withSubfolder,
    detectVideoExtension,
    resolveOutputFilename,
    KNOWN_VIDEO_EXTENSIONS,
    OutputExistsError
} from '../utils/filename.js';
import { TimeoutError, AbortedError } from '../utils/helpers.js';

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const basename = (p) => String(p || '').split(/[\\/]/).pop();

/**
 * Downloads a finished video under <prefix><number>.<ext> using chrome.downloads only.
 *
 * Two paths:
 *   1. The page exposes an http(s) URL for the video -> chrome.downloads.download(url).
 *      Chrome sends the user's own cookies, exactly like a normal download; nothing is extracted.
 *   2. Only a blob: URL / no URL -> click Flow's own download button (via the adapter) and claim
 *      the download Chrome starts from the Flow tab.
 * In both cases the final name is assigned in chrome.downloads.onDeterminingFilename, where
 * Chrome tells us the real MIME type / server filename, so the true extension is preserved.
 *
 * `api` is chrome.downloads (or a fake in tests): { download, search, cancel, onChanged }.
 */
export class DownloadManager {
    constructor({ api, getSettings, logger, extensionId, pollMs = 2000, nativeClaimTimeoutMs = 60_000, onDownloadRoot = null }) {
        this.api = api;
        this.onDownloadRoot = onDownloadRoot; // (absolutePath) => void — Chrome's download folder, for Settings
        this.getSettings = getSettings;
        this.logger = logger;
        this.extensionId = extensionId;
        this.pollMs = pollMs;
        this.nativeClaimTimeoutMs = nativeClaimTimeoutMs;
        this.pending = null;
    }

    generateFilename(job, extension) {
        return getOutputFilename(job, extension, { prefix: this.getSettings().filenamePrefix });
    }

    /** Does Chrome's download history contain an existing file at Downloads/<relPath>? */
    async fileExists(relPath) {
        const pattern = `(?i)(^|[\\\\/])${relPath.split('/').map(escapeRegex).join('[\\\\/]')}$`;
        const items = await this.api.search({ filenameRegex: pattern, state: 'complete' });
        return items.some((item) => item.exists !== false);
    }

    /**
     * "Prevent overwrite" check done BEFORE generating, so no generation quota is spent on a
     * job whose output would be refused anyway. Checks every known video extension.
     */
    async assertOutputAvailable(job) {
        const { duplicateBehavior, filenamePrefix, downloadSubfolder } = this.getSettings();
        if (duplicateBehavior !== 'prevent') return;
        for (const ext of KNOWN_VIDEO_EXTENSIONS) {
            const rel = withSubfolder(getOutputFilename(job, ext, { prefix: filenamePrefix }), downloadSubfolder);
            if (await this.fileExists(rel)) throw new OutputExistsError(rel);
        }
    }

    async downloadVideo(videoInfo, job, { signal, timeoutMs, triggerNativeDownload, onStarted, onCompleted } = {}) {
        if (this.pending) throw new Error('Another download is already in progress');
        const url = videoInfo?.url || null;
        const canFetchDirectly = url && /^(https?:|data:)/i.test(url);

        let claimResolve;
        let claimReject;
        const claim = new Promise((resolve, reject) => {
            claimResolve = resolve;
            claimReject = reject;
        });
        claim.catch(() => {});
        this.pending = { job, hint: videoInfo?.mimeHint || null, source: canFetchDirectly ? 'extension' : 'native', claimedId: null, claimResolve, claimReject, target: null };

        try {
            let downloadId;
            if (canFetchDirectly) {
                const ext = detectVideoExtension({ url, hint: this.pending.hint });
                const provisional = withSubfolder(this.generateFilename(job, ext), this.getSettings().downloadSubfolder);
                try {
                    downloadId = await this.api.download({ url, filename: provisional, conflictAction: 'uniquify', saveAs: false });
                    this.pending.claimedId ??= downloadId;
                } catch (error) {
                    if (!triggerNativeDownload) throw error;
                    this.logger.warn(`Direct download failed (${error.message}); falling back to Flow's download button`);
                    this.pending.source = 'native';
                }
            }
            if (downloadId == null) {
                if (!triggerNativeDownload) throw new Error('No downloadable video URL and no native download action available');
                this.logger.info(`Job ${job.number}: using Flow's download button`);
                await triggerNativeDownload();
                downloadId = await raceWithTimeout(claim, this.nativeClaimTimeoutMs, signal, "Flow's download button did not start a download");
            }

            await onStarted?.({ downloadId });
            try {
                await this.waitForDownload(downloadId, { timeoutMs, signal });
            } catch (error) {
                throw this.pending.error || error; // e.g. OutputExistsError that made us cancel it
            }
            const item = await this.verifyDownload(downloadId);
            const filename = basename(item.filename);
            if (this.pending.target) {
                const root = downloadRoot(item.filename, this.pending.target);
                if (root) this.onDownloadRoot?.(root);
            }
            const target = this.pending.target ? basename(this.pending.target) : null;
            if (target && filename !== target) {
                this.logger.warn(`Chrome saved "${filename}" instead of "${target}" because a file with that name already existed on disk (it was NOT overwritten)`);
            }
            onCompleted?.({ filename, downloadId });
            return { downloadId, filename, path: item.filename };
        } finally {
            this.pending = null;
        }
    }

    /**
     * Wire to chrome.downloads.onDeterminingFilename (registered at the top level of the
     * service worker). Returns true when it will call suggest() asynchronously.
     */
    handleDeterminingFilename(item, suggest) {
        const p = this.pending;
        if (!p) return false;
        const fromUs = item.byExtensionId === this.extensionId;
        if (p.source === 'extension') {
            if (!fromUs || (p.claimedId != null && p.claimedId !== item.id)) return false;
        } else {
            if (fromUs || p.claimedId != null || !this.looksLikeFlowDownload(item)) return false;
        }
        p.claimedId = item.id;

        const settings = this.getSettings();
        const ext = detectVideoExtension({ filename: item.filename, mime: item.mime, url: item.finalUrl || item.url, hint: p.hint });
        resolveOutputFilename(p.job, ext, {
            prefix: settings.filenamePrefix,
            subfolder: settings.downloadSubfolder,
            behavior: settings.duplicateBehavior,
            exists: (rel) => this.fileExists(rel)
        })
            .then(({ filename, conflictAction }) => {
                p.target = filename;
                this.logger.debug(`Assigning filename ${filename} (mime=${item.mime || '?'}, conflict=${conflictAction})`);
                suggest({ filename, conflictAction });
                p.claimResolve(item.id);
            })
            .catch((error) => {
                p.error = error;
                suggest();
                Promise.resolve(this.api.cancel?.(item.id)).catch(() => {});
                p.claimReject(error);
            });
        return true;
    }

    looksLikeFlowDownload(item) {
        const hosts = [safeHost(this.getSettings().flowUrl), 'flow.google.com', 'labs.google'].filter(Boolean);
        const sources = [item.referrer, item.url, item.finalUrl].filter(Boolean).map((u) => String(u).replace(/^blob:/, ''));
        const fromFlow = sources.some((u) => hosts.some((h) => safeHost(u) === h));
        const isVideo = /^video\//i.test(item.mime || '') || KNOWN_VIDEO_EXTENSIONS.includes(detectVideoExtension({ filename: item.filename, mime: item.mime }));
        return fromFlow || (isVideo && sources.some((u) => /google/i.test(safeHost(u) || '')));
    }

    waitForDownload(downloadId, { timeoutMs = 5 * 60_000, signal } = {}) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(poller);
                this.api.onChanged.removeListener(onChanged);
                signal?.removeEventListener('abort', onAbort);
                fn(value);
            };
            const check = (state, error) => {
                if (state === 'complete') finish(resolve, true);
                else if (state === 'interrupted') finish(reject, Object.assign(new Error(`Download failed: ${error || 'interrupted'}`), { code: 'DOWNLOAD_FAILED' }));
            };
            const onChanged = (delta) => {
                if (delta.id !== downloadId) return;
                check(delta.state?.current, delta.error?.current);
            };
            const onAbort = () => finish(reject, new AbortedError('Download wait aborted'));
            const timer = setTimeout(() => finish(reject, new TimeoutError(`Download timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
            // Polling covers missed events and keeps the MV3 worker active during long downloads.
            const poller = setInterval(async () => {
                const [item] = await this.api.search({ id: downloadId }).catch(() => []);
                if (!item) return finish(reject, new Error('Download disappeared from Chrome history'));
                check(item.state, item.error);
            }, this.pollMs);
            this.api.onChanged.addListener(onChanged);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        });
    }

    /** A job is only completed when Chrome confirms the file exists and has bytes. */
    async verifyDownload(downloadId) {
        const [item] = await this.api.search({ id: downloadId });
        if (!item) throw new Error('Download could not be verified: not found in Chrome history');
        if (item.state !== 'complete') throw new Error(`Download could not be verified: state is "${item.state}"`);
        if (item.exists === false) throw new Error('Download could not be verified: file no longer exists');
        const bytes = Math.max(item.bytesReceived || 0, item.fileSize || 0, item.totalBytes || 0);
        if (bytes <= 0) throw new Error('Download could not be verified: file is empty');
        return item;
    }

    /** Used on restart: was a previously started download actually finished? */
    async lookupCompleted(downloadId) {
        const [item] = await this.api.search({ id: downloadId });
        if (item && item.state === 'complete' && item.exists !== false) return { filename: basename(item.filename) };
        return null;
    }
}

/**
 * Chrome's download folder = the saved file's absolute path minus the relative path we asked
 * for (D:\Videos\flow\1.mp4 minus flow/1.mp4 -> D:\Videos). Null if they don't line up
 * (e.g. Chrome renamed the file to "1 (1).mp4").
 */
export function downloadRoot(absolutePath, relativeTarget) {
    const abs = String(absolutePath || '');
    const sep = abs.includes('\\') ? '\\' : '/';
    const rel = String(relativeTarget || '').split('/').join(sep);
    if (!rel || !abs.toLowerCase().endsWith(sep + rel.toLowerCase())) return null;
    return abs.slice(0, abs.length - rel.length - 1);
}

function safeHost(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

function raceWithTimeout(promise, ms, signal, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
        const onAbort = () => reject(new AbortedError());
        signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        });
    });
}
