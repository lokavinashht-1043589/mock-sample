import { DEFAULT_SETTINGS, normalizeSettings, STORAGE_KEYS } from '../core/settings.js';
import { getOutputFilename, withSubfolder } from '../utils/filename.js';

const $ = (id) => document.getElementById(id);

const EXAMPLE_OVERRIDES = {
    promptInput: [{ css: 'textarea[placeholder*="prompt" i]' }],
    generateButton: [{ aria: '^Send$' }],
    downloadMenuOption: [{ role: 'menuitem', name: 'Original size' }]
};

const MIN = 60_000;
const SEC = 1000;

function fill(s) {
    $('flowUrl').value = s.flowUrl;
    $('maxRetries').value = s.maxRetries;
    $('delayBetweenJobs').value = s.delayBetweenJobsMs / SEC;
    $('videoTimeout').value = s.videoGenerationTimeoutMs / MIN;
    $('downloadTimeout').value = s.downloadTimeoutMs / MIN;
    $('elementTimeout').value = s.elementTimeoutMs / SEC;
    $('filenamePrefix').value = s.filenamePrefix;
    $('downloadSubfolder').value = s.downloadSubfolder;
    document.querySelector(`input[name="duplicateBehavior"][value="${s.duplicateBehavior}"]`).checked = true;
    $('autoResume').checked = s.autoResume;
    $('debugMode').checked = s.debugMode;
    $('selectorOverrides').value = s.selectorOverrides;
    updatePreview();
    checkOverrides();
}

function read() {
    return normalizeSettings({
        flowUrl: $('flowUrl').value,
        maxRetries: $('maxRetries').value,
        delayBetweenJobsMs: Number($('delayBetweenJobs').value) * SEC,
        videoGenerationTimeoutMs: Number($('videoTimeout').value) * MIN,
        downloadTimeoutMs: Number($('downloadTimeout').value) * MIN,
        elementTimeoutMs: Number($('elementTimeout').value) * SEC,
        filenamePrefix: $('filenamePrefix').value,
        downloadSubfolder: $('downloadSubfolder').value,
        duplicateBehavior: document.querySelector('input[name="duplicateBehavior"]:checked')?.value,
        autoResume: $('autoResume').checked,
        debugMode: $('debugMode').checked,
        selectorOverrides: $('selectorOverrides').value
    });
}

function updatePreview() {
    const s = read();
    const names = [1, 2, 10].map((n) => withSubfolder(getOutputFilename({ number: n }, 'mp4', { prefix: s.filenamePrefix }), s.downloadSubfolder));
    $('filenamePreview').textContent = names.join(', ');
    renderSavePath(s);
}

// ── save location ──
// Extensions can't read Chrome's download folder directly; it is learned from the last video
// the extension saved (service worker stores it), or guessed from Chrome's latest download.
let downloadRoot = null;
let rootIsGuess = false;

async function loadDownloadRoot() {
    downloadRoot = (await chrome.storage.local.get(STORAGE_KEYS.DOWNLOAD_ROOT))[STORAGE_KEYS.DOWNLOAD_ROOT] || null;
    rootIsGuess = false;
    if (!downloadRoot) {
        const [latest] = await chrome.downloads.search({ orderBy: ['-startTime'], state: 'complete', limit: 1 }).catch(() => []);
        const path = latest?.filename || '';
        const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
        if (cut > 0) {
            downloadRoot = path.slice(0, cut);
            rootIsGuess = true;
        }
    }
    renderSavePath(read());
}

function renderSavePath(s) {
    const sep = downloadRoot?.includes('/') && !downloadRoot.includes('\\') ? '/' : '\\';
    const rel = withSubfolder(getOutputFilename({ number: 1 }, 'mp4', { prefix: s.filenamePrefix }), s.downloadSubfolder).split('/').join(sep);
    $('savePath').textContent = downloadRoot ? `${downloadRoot}${sep}${rel}` : `<Chrome's download folder>${sep}${rel}`;
    $('savePathNote').textContent = !downloadRoot
        ? 'The exact folder is shown here after the first video is saved.'
        : rootIsGuess
          ? "Folder taken from Chrome's most recent download; confirmed after the first video is saved."
          : 'If you change Chrome\'s download folder, this updates after the next video is saved.';
}

function checkOverrides() {
    const text = $('selectorOverrides').value.trim();
    const status = $('overrideStatus');
    if (!text) {
        status.textContent = 'Using built-in selectors';
        status.className = 'muted';
        return true;
    }
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('top level must be an object');
        for (const [key, strategies] of Object.entries(value)) {
            if (!Array.isArray(strategies)) throw new Error(`"${key}" must be an array`);
        }
        status.textContent = `✓ Valid — overrides ${Object.keys(value).length} key(s)`;
        status.className = 'ok';
        return true;
    } catch (error) {
        status.textContent = `✗ Invalid JSON: ${error.message}`;
        status.className = 'err';
        return false;
    }
}

async function save(event) {
    event?.preventDefault();
    if (!checkOverrides()) {
        $('saveStatus').textContent = 'Fix the selector overrides JSON first.';
        return;
    }
    const url = $('flowUrl').value.trim();
    if (!/^https:\/\/(flow\.google\.com|labs\.google\/fx)(\/|$)/i.test(url)) {
        $('saveStatus').textContent = 'Note: URLs outside flow.google.com / labs.google/fx are not covered by the extension permissions.';
    }
    const settings = read();
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    fill(settings);
    $('saveStatus').textContent = `Saved ✓ ${new Date().toLocaleTimeString()}`;
}

(async function main() {
    const stored = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
    fill(normalizeSettings(stored));
    $('form').addEventListener('submit', save);
    $('btnChromeFolder').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://settings/downloads' }));
    loadDownloadRoot();
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[STORAGE_KEYS.DOWNLOAD_ROOT]) loadDownloadRoot();
    });
    $('form').addEventListener('input', updatePreview);
    $('selectorOverrides').addEventListener('input', checkOverrides);
    $('btnDefaults').addEventListener('click', () => {
        fill({ ...DEFAULT_SETTINGS });
        $('saveStatus').textContent = 'Defaults loaded — click Save to apply.';
    });
    $('btnExample').addEventListener('click', () => {
        $('selectorOverrides').value = JSON.stringify(EXAMPLE_OVERRIDES, null, 2);
        checkOverrides();
    });
})();
