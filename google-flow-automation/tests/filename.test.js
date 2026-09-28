import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    getOutputFilename,
    detectVideoExtension,
    resolveOutputFilename,
    withSubfolder,
    sanitizeSubfolder,
    DUPLICATE_BEHAVIOR,
    OutputExistsError
} from '../src/utils/filename.js';

test('number -> filename', () => {
    assert.equal(getOutputFilename({ number: 1 }, 'mp4'), '1.mp4');
    assert.equal(getOutputFilename({ number: 10 }, 'mp4'), '10.mp4');
    assert.equal(getOutputFilename({ number: 100 }, 'mp4'), '100.mp4');
});

test('prefix', () => {
    assert.equal(getOutputFilename({ number: 10 }, 'mp4', { prefix: 'flow_' }), 'flow_10.mp4');
    assert.equal(getOutputFilename({ number: 10 }, 'mp4', { prefix: '' }), '10.mp4');
    assert.equal(getOutputFilename({ number: 3 }, 'mp4', { prefix: 'a/b:c*' }), 'abc3.mp4', 'illegal chars stripped');
});

test('extensions are preserved', () => {
    assert.equal(getOutputFilename({ number: 10 }, 'mp4'), '10.mp4');
    assert.equal(getOutputFilename({ number: 10 }, 'webm'), '10.webm');
    assert.equal(getOutputFilename({ number: 10 }, 'mov'), '10.mov');
    assert.equal(getOutputFilename({ number: 10 }, '.MOV'), '10.mov');
    assert.equal(getOutputFilename({ number: 10 }, ''), '10.mp4', 'fallback');
});

test('label (typed digits) wins over number', () => {
    assert.equal(getOutputFilename({ number: 7, label: '007' }, 'mp4'), '007.mp4');
});

test('suffix', () => {
    assert.equal(getOutputFilename({ number: 1 }, 'mp4', { suffix: 2 }), '1_2.mp4');
});

test('detectVideoExtension priority and fallbacks', () => {
    assert.equal(detectVideoExtension({ filename: 'C:\\Downloads\\abc.webm', mime: 'video/mp4' }), 'webm');
    assert.equal(detectVideoExtension({ filename: 'download', mime: 'video/quicktime' }), 'mov');
    assert.equal(detectVideoExtension({ url: 'https://x.test/v/clip.mp4?sig=1' }), 'mp4');
    assert.equal(detectVideoExtension({ url: 'https://x.test/media/123', hint: 'video/webm' }), 'webm');
    assert.equal(detectVideoExtension({ url: 'blob:https://flow.google.com/uuid' }), 'mp4');
    assert.equal(detectVideoExtension({ filename: 'page.html' }), 'mp4', 'non-video extension ignored');
    assert.equal(detectVideoExtension(), 'mp4');
});

test('subfolder handling', () => {
    assert.equal(withSubfolder('1.mp4', 'flow'), 'flow/1.mp4');
    assert.equal(withSubfolder('1.mp4', ''), '1.mp4');
    assert.equal(sanitizeSubfolder('../evil/./x'), 'evil/x');
    assert.equal(sanitizeSubfolder('C:\\abs\\path'), 'C/abs/path');
});

test('duplicate: prevent overwrite throws when file exists', async () => {
    const existing = new Set(['1.mp4']);
    await assert.rejects(
        resolveOutputFilename({ number: 1 }, 'mp4', { behavior: DUPLICATE_BEHAVIOR.PREVENT, exists: (f) => existing.has(f) }),
        OutputExistsError
    );
    const ok = await resolveOutputFilename({ number: 2 }, 'mp4', { behavior: 'prevent', exists: (f) => existing.has(f) });
    assert.deepEqual(ok, { filename: '2.mp4', conflictAction: 'uniquify' });
});

test('duplicate: suffix finds next free name', async () => {
    const existing = new Set(['1.mp4', '1_1.mp4']);
    const r = await resolveOutputFilename({ number: 1 }, 'mp4', { behavior: 'suffix', exists: (f) => existing.has(f) });
    assert.equal(r.filename, '1_2.mp4');
});

test('duplicate: overwrite', async () => {
    const r = await resolveOutputFilename({ number: 1 }, 'mp4', { behavior: 'overwrite', exists: () => true });
    assert.deepEqual(r, { filename: '1.mp4', conflictAction: 'overwrite' });
});

test('duplicate check respects prefix and subfolder', async () => {
    const seen = [];
    await resolveOutputFilename({ number: 4 }, 'webm', {
        prefix: 'flow_',
        subfolder: 'batch',
        exists: (f) => (seen.push(f), false)
    });
    assert.deepEqual(seen, ['batch/flow_4.webm']);
});
