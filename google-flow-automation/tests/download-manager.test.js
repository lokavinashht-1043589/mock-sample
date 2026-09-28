import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadManager } from '../src/core/download-manager.js';
import { Logger } from '../src/core/logger.js';
import { normalizeSettings } from '../src/core/settings.js';
import { FakeDownloads, EXT_ID } from './mocks/fake-downloads.js';

function make({ settings = {}, downloads = new FakeDownloads() } = {}) {
    const s = normalizeSettings(settings);
    const logger = new Logger({ debugMode: true });
    const dm = new DownloadManager({ api: downloads, getSettings: () => s, logger, extensionId: EXT_ID, pollMs: 5, nativeClaimTimeoutMs: 200 });
    downloads.determine = (item, suggest) => dm.handleDeterminingFilename(item, suggest);
    return { dm, downloads, logger };
}

test('downloads via URL and names the file <number>.mp4', async () => {
    const { dm } = make();
    const res = await dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 1 }, { timeoutMs: 1000 });
    assert.equal(res.filename, '1.mp4');
});

test('keeps the real extension reported by Chrome (webm) and applies prefix + subfolder', async () => {
    const { dm } = make({ settings: { filenamePrefix: 'flow_', downloadSubfolder: 'batch' }, downloads: new FakeDownloads({ mime: 'video/webm', serverFilename: 'download' }) });
    const res = await dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 10 }, { timeoutMs: 1000 });
    assert.equal(res.filename, 'flow_10.webm');
    assert.match(res.path, /batch\\flow_10\.webm$/);
});

test('mov from server filename', async () => {
    const { dm } = make({ downloads: new FakeDownloads({ mime: 'application/octet-stream', serverFilename: 'clip.mov' }) });
    const res = await dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 3 }, { timeoutMs: 1000 });
    assert.equal(res.filename, '3.mov');
});

test('suffix behavior picks 1_1.mp4 when 1.mp4 exists', async () => {
    const { dm } = make({ settings: { duplicateBehavior: 'suffix' }, downloads: new FakeDownloads({ existingFiles: ['1.mp4'] }) });
    const res = await dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 1 }, { timeoutMs: 1000 });
    assert.equal(res.filename, '1_1.mp4');
});

test('prevent overwrite: pre-check throws and download-time check cancels', async () => {
    const downloads = new FakeDownloads({ existingFiles: ['1.webm'] });
    const { dm } = make({ downloads });
    await assert.rejects(dm.assertOutputAvailable({ number: 1 }), /already exists: 1\.webm/);
    await dm.assertOutputAvailable({ number: 2 });

    const d2 = new FakeDownloads({ existingFiles: ['5.mp4'] });
    const { dm: dm2 } = make({ downloads: d2 });
    await assert.rejects(dm2.downloadVideo({ url: 'https://media.test/abc' }, { number: 5 }, { timeoutMs: 1000 }), /already exists: 5\.mp4/);
});

test('overwrite behavior passes conflictAction overwrite', async () => {
    const downloads = new FakeDownloads({ existingFiles: ['1.mp4'] });
    const { dm } = make({ settings: { duplicateBehavior: 'overwrite' }, downloads });
    const res = await dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 1 }, { timeoutMs: 1000 });
    assert.equal(res.filename, '1.mp4');
});

test('file on disk unknown to Chrome is never overwritten (Chrome uniquifies) and a warning is logged', async () => {
    const downloads = new FakeDownloads();
    downloads.disk.add('1.mp4'); // exists on disk, but not in Chrome's history
    const { dm, logger } = make({ downloads });
    const res = await dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 1 }, { timeoutMs: 1000 });
    assert.equal(res.filename, '1 (1).mp4');
    assert.ok(logger.entries.some((e) => e.level === 'warn' && /NOT overwritten/.test(e.message)));
});

test('interrupted download is reported as failure', async () => {
    const { dm } = make({ downloads: new FakeDownloads({ outcome: 'interrupted' }) });
    await assert.rejects(dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 1 }, { timeoutMs: 1000 }), /Download failed: NETWORK_FAILED/);
});

test('download that never completes times out (never marked complete just because it started)', async () => {
    let started = false;
    const { dm } = make({ downloads: new FakeDownloads({ outcome: 'never' }) });
    await assert.rejects(
        dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 1 }, { timeoutMs: 80, onStarted: () => (started = true) }),
        /Download timed out/
    );
    assert.equal(started, true);
});

test('empty file fails verification', async () => {
    const { dm } = make({ downloads: new FakeDownloads({ bytes: 0 }) });
    await assert.rejects(dm.downloadVideo({ url: 'https://media.test/abc' }, { number: 1 }, { timeoutMs: 1000 }), /file is empty/);
});

test('blob-only video: clicks Flow download button and claims the page download', async () => {
    const downloads = new FakeDownloads({ mime: 'video/mp4', serverFilename: 'flow_video_xyz.mp4' });
    const { dm } = make({ downloads });
    let clicked = false;
    const res = await dm.downloadVideo({ url: null, isBlob: true }, { number: 7 }, {
        timeoutMs: 1000,
        triggerNativeDownload: async () => {
            clicked = true;
            downloads.pageDownload();
        }
    });
    assert.equal(clicked, true);
    assert.equal(res.filename, '7.mp4');
});

test('native download: an unrelated download from another site is not claimed', async () => {
    const downloads = new FakeDownloads({ mime: 'application/pdf', serverFilename: 'invoice.pdf' });
    const { dm } = make({ downloads });
    await assert.rejects(
        dm.downloadVideo({ url: null }, { number: 7 }, {
            timeoutMs: 1000,
            triggerNativeDownload: async () => {
                downloads.pageDownload({ url: 'https://example.com/invoice.pdf', referrer: 'https://example.com/' });
            }
        }),
        /did not start a download/
    );
});

test('generateFilename uses prefix', () => {
    const { dm } = make({ settings: { filenamePrefix: 'flow_' } });
    assert.equal(dm.generateFilename({ number: 10 }, 'mp4'), 'flow_10.mp4');
});
