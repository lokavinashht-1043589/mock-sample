import { MSG } from '../utils/messages.js';
import { parsePrompts, summarizeParse } from '../utils/prompt-parser.js';
import { normalizeSettings, DEFAULT_SETTINGS, STORAGE_KEYS } from '../core/settings.js';
import { Logger } from '../core/logger.js';
import { StateManager, RUN_STATUS } from '../core/state-manager.js';
import { mergeQueue, getStats, getNextJob } from '../core/queue-manager.js';
import { DownloadManager } from '../core/download-manager.js';
import { FlowAutomationEngine } from '../core/automation-engine.js';
import { FlowConnection } from './flow-connection.js';
import { RemoteFlowAdapter } from './remote-flow-adapter.js';
import { TrustedInput } from './trusted-input.js';

// ───────────────────────────── wiring ─────────────────────────────

let settings = { ...DEFAULT_SETTINGS };
const getSettings = () => settings;

const logger = new Logger({
    maxEntries: 1000,
    persist: (entries) => chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: entries })
});
const stateManager = new StateManager({ storage: chrome.storage.local, persistDelayMs: 1500 });
const trustedInput = new TrustedInput({ logger });
const connection = new FlowConnection({
    getSettings,
    logger,
    trustedInput,
    onTabChanged: (tabId) => stateManager.update({ flowTabId: tabId }, { immediate: false })
});
const adapter = new RemoteFlowAdapter(connection, getSettings);
const downloadManager = new DownloadManager({ api: chrome.downloads, getSettings, logger, extensionId: chrome.runtime.id });
const engine = new FlowAutomationEngine({ stateManager, adapter, downloadManager, logger, getSettings, emit: broadcast });

// ───────────────────── top-level listeners (MV3 needs these registered synchronously) ─────────────────────

chrome.runtime.onConnect.addListener((port) => connection.attach(port));

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => downloadManager.handleDeterminingFilename(item, suggest));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message?.type) return false;
    ready
        .then(() => handleMessage(message))
        .then(
            (result) => sendResponse({ ok: true, ...result }),
            (error) => sendResponse({ ok: false, error: error?.message || String(error) })
        );
    return true; // async response
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.SETTINGS]) {
        settings = normalizeSettings(changes[STORAGE_KEYS.SETTINGS].newValue);
        logger.setDebugMode(settings.debugMode);
        logger.info('Settings updated');
    }
});

// Broadcast state to any open popup (throttled; the popup may be closed — that's fine).
let broadcastTimer = null;
stateManager.subscribe(() => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        broadcast(MSG.QUEUE_UPDATE, snapshot());
    }, 200);
});
logger.onEntry((entry) => broadcast(MSG.LOG_ENTRY, { entry }));

function broadcast(type, payload = {}) {
    chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

// ───────────────────── keep-alive while running ─────────────────────
// Content-script heartbeats keep the worker alive during Flow steps; this covers the rest
// (download waits, delays). It is the pattern documented for MV3 long-running work.
let keepAliveTimer = null;
stateManager.subscribe((state) => {
    const active = [RUN_STATUS.RUNNING, RUN_STATUS.PAUSING, RUN_STATUS.WAITING_AUTH, RUN_STATUS.WAITING_PROJECT, RUN_STATUS.STOPPING].includes(state.runStatus);
    if (active && !keepAliveTimer) keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
    // Real clicks keep Chrome's "debugging this browser" bar up; drop it once the run is over.
    if (!active) trustedInput.detachAll();
    if (!active && keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
});

// ───────────────────── startup / restore ─────────────────────

const ready = init().catch((error) => logger.error(`Initialisation failed: ${error.message}`));

async function init() {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.LOGS]);
    settings = normalizeSettings(stored[STORAGE_KEYS.SETTINGS]);
    logger.setDebugMode(settings.debugMode);
    logger.load(stored[STORAGE_KEYS.LOGS]);
    await stateManager.load();
    connection.setTabId(stateManager.get().flowTabId);

    // storage.session survives worker restarts but not browser restarts / extension reloads.
    // Present => the worker was merely recycled mid-run, so carry on. Absent => a fresh
    // browser session, where only Auto Resume may restart work.
    const marker = (await chrome.storage.session.get(STORAGE_KEYS.SESSION_MARKER))[STORAGE_KEYS.SESSION_MARKER];
    await chrome.storage.session.set({ [STORAGE_KEYS.SESSION_MARKER]: true });
    const workerRecycled = Boolean(marker);
    await engine.restore({ resume: workerRecycled || settings.autoResume });
}

// ───────────────────── message handling ─────────────────────

const isFlowReady = (flow) => Boolean(flow?.connected && flow.authenticated !== false && flow.projectOpen && flow.promptFound);

function describeFlowStatus(flow) {
    if (!flow?.connected) {
        if (flow?.noTab) return 'Google Flow is not open. Open Google Flow and open (or create) a project, then press Start.';
        if (flow?.authRequired) return 'Sign in to Google Flow in its tab, open a project, then press Start.';
        return `Can't reach the Google Flow tab: ${flow?.reason || 'unknown error'}`;
    }
    if (flow.authenticated === false) return 'Sign in to Google Flow in its tab, open a project, then press Start.';
    if (!flow.projectOpen) return 'Google Flow is open, but no project is. Open (or create) a project in Flow, then press Start.';
    if (!flow.promptFound) return "The Flow project is open but its prompt box wasn't found yet. Wait for it to load, then press Start.";
    return 'Connected to your Flow project.';
}

function snapshot() {
    const state = stateManager.get();
    return { state, stats: getStats(state.jobs, state.currentJobNumber), running: engine.isRunning };
}

function parseResponse(result) {
    return {
        valid: result.isValid,
        count: result.prompts.length,
        errors: result.errors,
        summary: summarizeParse(result)
    };
}

async function applyPrompts(text) {
    const result = parsePrompts(text);
    if (!result.isValid) return { result, applied: false };
    const jobs = mergeQueue(stateManager.get().jobs, result.prompts);
    await stateManager.update({ promptsText: text, jobs, summary: null, scope: null });
    return { result, applied: true };
}

async function handleMessage(message) {
    switch (message.type) {
        case MSG.GET_STATE:
            return { ...snapshot(), settings };

        case MSG.SAVE_PROMPTS:
            await stateManager.update({ promptsText: String(message.text ?? '') }, { immediate: false });
            return {};

        case MSG.VALIDATE_PROMPTS: {
            if (engine.isRunning) return { parse: parseResponse(parsePrompts(message.text)), note: 'Queue not changed while automation is running' };
            const { result } = await applyPrompts(String(message.text ?? ''));
            return { parse: parseResponse(result), ...snapshot() };
        }

        case MSG.START_QUEUE: {
            if (engine.isRunning) throw new Error('Automation is already running');
            const { result, applied } = await applyPrompts(String(message.text ?? ''));
            if (!applied) return { started: false, parse: parseResponse(result) };
            if (!getNextJob(stateManager.get().jobs)) {
                return { started: false, parse: parseResponse(result), note: 'Every job is already completed. Use "Reset queue" to run them again.' };
            }
            // Only start creating once the user has a Flow project open (they open it themselves).
            const flow = await adapter.getStatus().catch((e) => ({ connected: false, reason: e.message }));
            if (!isFlowReady(flow)) return { started: false, parse: parseResponse(result), flow, note: describeFlowStatus(flow) };
            await engine.start({ scope: null });
            return { started: true, parse: parseResponse(result) };
        }

        case MSG.PAUSE_QUEUE:
            await engine.pause();
            return {};

        case MSG.RESUME_QUEUE:
            if (!engine.isRunning && !getNextJob(stateManager.get().jobs, stateManager.get().scope)) {
                return { started: false, note: 'Nothing left to resume' };
            }
            await engine.resume();
            return {};

        case MSG.STOP_QUEUE:
            engine.stop().catch((e) => logger.error(`Stop failed: ${e.message}`));
            return {};

        case MSG.CLEAR_QUEUE:
            if (engine.isRunning) throw new Error('Stop the automation before resetting the queue');
            await stateManager.update({ jobs: [], summary: null, currentJobNumber: null, scope: null, runStatus: RUN_STATUS.IDLE, statusMessage: 'Queue cleared' });
            logger.info('Queue cleared');
            return snapshot();

        case MSG.RETRY_FAILED: {
            const numbers = await engine.retryFailed();
            if (!numbers.length) return { note: 'No failed jobs to retry' };
            logger.info(`Retrying failed jobs: ${numbers.join(', ')}`);
            if (!engine.isRunning) await engine.start({ scope: { numbers } });
            return { numbers };
        }

        case MSG.RETRY_JOB: {
            const number = Number(message.number);
            await engine.retryJob(number);
            if (!engine.isRunning) await engine.start({ scope: { numbers: [number] } });
            return {};
        }

        case MSG.GET_FLOW_STATUS:
            // While a run owns the tab, don't switch tabs or inject scripts from a popup poll.
            if (engine.isRunning) return { flow: { connected: true, running: true } };
            return { flow: await adapter.getStatus().catch((e) => ({ connected: false, reason: e.message })) };

        case MSG.OPEN_FLOW:
            await connection.focusFlowTab();
            return {};

        case MSG.RUN_DIAGNOSTICS:
            logger.info('Running Flow diagnostics');
            return { diagnostics: await adapter.diagnose() };

        case MSG.GET_LOGS:
            return { entries: logger.entries, text: logger.toText() };

        case MSG.CLEAR_LOGS:
            logger.clear();
            return {};

        default:
            throw new Error(`Unknown message type: ${message.type}`);
    }
}
