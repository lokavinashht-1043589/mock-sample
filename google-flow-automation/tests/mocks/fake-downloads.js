/**
 * Minimal fake of chrome.downloads that behaves like Chrome for the parts we use:
 * download(), search(), cancel(), onChanged, and onDeterminingFilename (routed to `determine`).
 */
export const EXT_ID = 'test-extension-id';
const DOWNLOADS_DIR = 'C:\\Users\\me\\Downloads';

export class FakeDownloads {
    constructor({ existingFiles = [], mime = 'video/mp4', serverFilename = 'video.mp4', outcome = 'complete', bytes = 1024, completeDelayMs = 5 } = {}) {
        this.items = [];
        this.nextId = 1;
        this.mime = mime;
        this.serverFilename = serverFilename;
        this.outcome = outcome; // 'complete' | 'interrupted' | 'never'
        this.bytes = bytes;
        this.completeDelayMs = completeDelayMs;
        this.listeners = new Set();
        this.determine = null; // set to downloadManager.handleDeterminingFilename.bind(dm)
        this.disk = new Set(existingFiles.map((f) => f.replace(/\//g, '\\')));
        // Pre-existing files Chrome knows about (as download history).
        for (const rel of existingFiles) this.items.push(this.makeItem({ rel, state: 'complete' }));
        this.onChanged = {
            addListener: (fn) => this.listeners.add(fn),
            removeListener: (fn) => this.listeners.delete(fn)
        };
    }

    makeItem({ rel, state = 'in_progress', url = 'https://media.test/x', byExtensionId, referrer }) {
        return {
            id: this.nextId++,
            url,
            finalUrl: url,
            referrer: referrer || '',
            filename: rel ? `${DOWNLOADS_DIR}\\${rel.replace(/\//g, '\\')}` : '',
            mime: this.mime,
            state,
            exists: true,
            bytesReceived: state === 'complete' ? this.bytes : 0,
            totalBytes: this.bytes,
            fileSize: state === 'complete' ? this.bytes : 0,
            byExtensionId
        };
    }

    /** Extension-initiated download (chrome.downloads.download). */
    async download({ url, filename, conflictAction }) {
        const item = this.makeItem({ url, byExtensionId: EXT_ID });
        item.proposed = { filename, conflictAction };
        this.items.push(item);
        this.run(item);
        return item.id;
    }

    /** A download started by the page (e.g. Flow's own download button). */
    pageDownload({ url = 'blob:https://flow.google.com/abc', referrer = 'https://flow.google.com/project/1' } = {}) {
        const item = this.makeItem({ url, referrer });
        this.items.push(item);
        this.run(item);
        return item;
    }

    run(item) {
        setTimeout(() => {
            const apply = (suggestion) => {
                const chosen = suggestion?.filename || item.proposed?.filename || this.serverFilename;
                const conflict = suggestion?.conflictAction || item.proposed?.conflictAction || 'uniquify';
                item.filename = `${DOWNLOADS_DIR}\\${this.uniquify(chosen.replace(/\//g, '\\'), conflict)}`;
                this.finish(item);
            };
            const view = { ...item, filename: this.serverFilename };
            let called = false;
            const suggest = (s) => {
                if (called) return;
                called = true;
                apply(s);
            };
            const async = this.determine ? this.determine(view, suggest) : false;
            if (!async && !called) suggest();
        }, 0);
    }

    uniquify(rel, conflictAction) {
        if (conflictAction === 'overwrite' || !this.disk.has(rel)) {
            this.disk.add(rel);
            return rel;
        }
        const dot = rel.lastIndexOf('.');
        for (let n = 1; ; n++) {
            const candidate = `${rel.slice(0, dot)} (${n})${rel.slice(dot)}`;
            if (!this.disk.has(candidate)) {
                this.disk.add(candidate);
                return candidate;
            }
        }
    }

    finish(item) {
        if (item.state === 'interrupted') return; // cancelled while determining
        if (this.outcome === 'never') return;
        setTimeout(() => {
            if (item.state === 'interrupted') return;
            if (this.outcome === 'interrupted') {
                item.state = 'interrupted';
                item.error = 'NETWORK_FAILED';
                this.emit({ id: item.id, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
                return;
            }
            item.state = 'complete';
            item.bytesReceived = item.fileSize = this.bytes;
            this.emit({ id: item.id, state: { current: 'complete' } });
        }, this.completeDelayMs);
    }

    emit(delta) {
        for (const fn of [...this.listeners]) fn(delta);
    }

    async cancel(id) {
        const item = this.items.find((i) => i.id === id);
        if (item && item.state === 'in_progress') {
            item.state = 'interrupted';
            item.error = 'USER_CANCELED';
            this.emit({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
        }
    }

    async search(query) {
        let result = this.items;
        if (query.id != null) result = result.filter((i) => i.id === query.id);
        if (query.state) result = result.filter((i) => i.state === query.state);
        if (query.filenameRegex) {
            let source = query.filenameRegex;
            let flags = '';
            if (source.startsWith('(?i)')) {
                source = source.slice(4);
                flags = 'i';
            }
            const re = new RegExp(source, flags);
            result = result.filter((i) => re.test(i.filename));
        }
        return result.map((i) => ({ ...i }));
    }
}
