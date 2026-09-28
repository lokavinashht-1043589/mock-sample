import { MSG } from '../utils/messages.js';
import { parsePrompts, summarizeParse } from '../utils/prompt-parser.js';
import { STATUS_LABELS, ACTIVE_STATUSES } from '../core/queue-manager.js';
import { Logger } from '../core/logger.js';
import { truncate } from '../utils/helpers.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text; // textContent only — prompts are never parsed as HTML
    return node;
};

const RUN_LABELS = {
    idle: 'Idle',
    running: 'Running',
    pausing: 'Pausing…',
    paused: 'Paused',
    waiting_auth: 'Login needed',
    stopping: 'Stopping…',
    stopped: 'Stopped',
    completed: 'Complete',
    error: 'Error'
};

const STATUS_ICONS = { completed: '✓', failed: '✗', pending: '○', paused: '⏸' };

let view = { state: null, stats: null, running: false, settings: null };
const expandedJobs = new Set();

async function send(type, payload = {}) {
    try {
        const response = await chrome.runtime.sendMessage({ type, ...payload });
        if (response && response.ok === false) throw new Error(response.error);
        return response || {};
    } catch (error) {
        setStatus(`Error: ${error.message}`);
        throw error;
    }
}

function setStatus(text) {
    $('statusLine').textContent = text;
}

// ───────────────────────────── rendering ─────────────────────────────

function render() {
    const { state, stats } = view;
    if (!state) return;
    const runStatus = state.runStatus;

    $('runPill').textContent = RUN_LABELS[runStatus] || runStatus;
    $('runPill').dataset.status = runStatus;

    const done = stats.completed + stats.failed;
    const pct = stats.total ? Math.round((done / stats.total) * 100) : 0;
    $('progressFill').style.width = `${pct}%`;
    $('progressBar').setAttribute('aria-valuenow', String(pct));
    $('progressLabel').textContent = `${done} / ${stats.total}`;
    $('progressLabel').title = `${done} of ${stats.total} jobs finished (completed or failed)`;
    $('statCompleted').textContent = stats.completed;
    $('statFailed').textContent = stats.failed;
    $('statPending').textContent = stats.pending + stats.active;
    $('statCurrent').textContent = state.currentJobNumber ?? '–';
    $('statTotal').textContent = stats.total;
    $('queueCount').textContent = stats.total;

    const current = state.jobs.find((j) => j.number === state.currentJobNumber);
    $('currentBox').hidden = !current;
    if (current) $('currentPrompt').textContent = current.prompt;
    setStatus(state.statusMessage || '');

    const running = view.running;
    const hasRunnable = state.jobs.some((j) => j.status === 'pending' || j.status === 'paused');
    $('btnStart').disabled = running;
    $('btnPause').disabled = !running || runStatus === 'pausing' || runStatus === 'stopping';
    $('btnResume').disabled = running ? runStatus !== 'pausing' : !hasRunnable || !['paused', 'stopped', 'error', 'idle'].includes(runStatus) || state.jobs.length === 0;
    $('btnStop').disabled = !running && runStatus !== 'paused';
    $('btnRetryFailed').disabled = running || stats.failed === 0;
    $('btnResetQueue').disabled = running || stats.total === 0;

    renderQueue(state);
    renderSummary(state);
}

function renderQueue(state) {
    const list = $('queueList');
    const fragment = document.createDocumentFragment();
    for (const job of state.jobs) {
        const active = ACTIVE_STATUSES.has(job.status);
        const item = el('li', `job ${job.status}${active ? ' active' : ''}${job.number === state.currentJobNumber ? ' current' : ''}`);
        item.dataset.number = job.number;
        item.title = job.prompt;
        item.append(
            el('span', 'icon', active ? '▶' : STATUS_ICONS[job.status] || '•'),
            el('span', 'num', job.label ?? String(job.number)),
            el('span', 'text', truncate(job.prompt, 60)),
            el('span', 'st', job.status === 'completed' && job.outputFile ? job.outputFile : `${STATUS_LABELS[job.status] || job.status}${job.retryCount ? ` · retry ${job.retryCount}` : ''}`)
        );
        if (job.status === 'failed' && expandedJobs.has(job.number)) {
            const detail = el('div', 'detail');
            const text = el('div');
            text.append(el('b', null, `✗ ${job.number} — Failed`), document.createTextNode(`\n\nError:\n${job.error || 'Unknown error'}`));
            const retry = el('button', 'btn small', 'Retry Job');
            retry.dataset.retry = job.number;
            retry.disabled = view.running;
            detail.append(text, retry);
            item.append(detail);
        }
        fragment.append(item);
    }
    list.replaceChildren(fragment);
    $('queueEmpty').hidden = state.jobs.length > 0;
}

function renderSummary(state) {
    const box = $('summary');
    const s = state.summary;
    if (!s || state.runStatus !== 'completed') {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    const title = el('h2', null, 'Automation Complete');
    const counts = el('div', null, `Total: ${s.total}   Completed: ${s.completed}   Failed: ${s.failed}`);
    const nodes = [title, counts];
    if (s.files.length) {
        nodes.push(el('div', 'label', 'Downloaded'), el('div', 'files', s.files.join('\n')));
        nodes.at(-1).style.whiteSpace = 'pre-line';
    }
    if (s.failures.length) {
        const f = el('div', 'failures', `${s.failures.length} job${s.failures.length === 1 ? '' : 's'} failed.\n\nFailed:\n${s.failures.map((x) => `${x.number} — ${x.error}`).join('\n')}`);
        f.style.whiteSpace = 'pre-line';
        nodes.push(f);
    }
    box.replaceChildren(...nodes);
}

function showValidation(parse, extra) {
    const box = $('validation');
    box.hidden = false;
    box.className = `validation ${parse.valid ? 'ok' : 'bad'}`;
    if (parse.valid) {
        box.textContent = `${parse.summary}${extra ? `\n${extra}` : ''}`;
        return;
    }
    const list = el('ul');
    for (const error of parse.errors.slice(0, 20)) list.append(el('li', null, error.message));
    if (parse.errors.length > 20) list.append(el('li', null, `…and ${parse.errors.length - 20} more`));
    box.replaceChildren(el('strong', null, parse.summary), list);
    if (extra) box.append(el('div', null, extra));
}

function localParse(text) {
    const result = parsePrompts(text);
    return { valid: result.isValid, count: result.prompts.length, errors: result.errors, summary: summarizeParse(result) };
}

// ───────────────────────────── log ─────────────────────────────

function appendLog(entry) {
    const box = $('logBox');
    const nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    const line = el('div', entry.level, Logger.format(entry));
    box.append(line);
    while (box.childElementCount > 1000) box.firstElementChild.remove();
    if (nearBottom) box.scrollTop = box.scrollHeight;
}

async function loadLogs() {
    const { entries = [] } = await send(MSG.GET_LOGS);
    $('logBox').replaceChildren();
    entries.forEach(appendLog);
    $('debugHint').textContent = view.settings?.debugMode ? 'Debug mode ON' : 'Debug mode off (enable in Settings for detail)';
}

// ───────────────────────────── diagnostics ─────────────────────────────

function renderDiagnostics(d) {
    const box = $('diagnostics');
    const rows = [];
    const row = (label, ok, reason) => {
        const r = el('div', 'diag-row');
        r.append(el('span', null, label), el('span', ok ? 'yes' : 'no', ok ? 'YES' : ok === null ? '?' : 'NO'));
        if (reason) r.append(el('span', 'reason', reason));
        rows.push(r);
    };
    if (!d.connected) {
        row('Flow page detected', false, d.reason || 'Open Google Flow in a tab and try again.');
        if (d.authRequired) row('Authentication detected', false, 'Log in to Google Flow manually.');
        box.replaceChildren(...rows);
        return;
    }
    row('Flow page detected', d.isFlowPage, d.isFlowPage ? d.url : `Unexpected page: ${d.url}`);
    row('Authentication detected', d.authenticated === true ? true : d.authenticated === false ? false : null, d.authenticated === false ? 'Sign-in link is visible — log in manually.' : d.authenticated === null ? 'Could not tell (no prompt box or account menu found).' : null);
    for (const item of d.items) {
        const reason = item.found
            ? `${item.count} match${item.count === 1 ? '' : 'es'} via ${item.strategy || 'media scan'}${item.verified ? ' (verified selector)' : ''}`
            : `Possible reason: Google Flow UI changed or the selector "${item.key}" needs updating.${/image|video|animate|download|progress|more/i.test(item.key) ? ' (Needs a generated result on screen.)' : ''}`;
        row(item.label, item.found, reason);
    }
    if (d.errorsOnPage?.length) row('Error messages on page', false, d.errorsOnPage.join('\n'));
    if (d.selectorError) row('Selector overrides', false, d.selectorError);
    box.replaceChildren(...rows);
}

// ───────────────────────────── events ─────────────────────────────

function switchTab(name) {
    for (const tab of document.querySelectorAll('.tab')) {
        const active = tab.dataset.tab === name;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${name}`;
    if (name === 'log') loadLogs().catch(() => {});
}

let saveTimer = null;
function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => send(MSG.SAVE_PROMPTS, { text: $('prompts').value }).catch(() => {}), 400);
}

async function refresh() {
    view = await send(MSG.GET_STATE);
    render();
}

function bind() {
    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('prompts').addEventListener('input', saveDraft);

    $('btnValidate').addEventListener('click', async () => {
        const text = $('prompts').value;
        const local = localParse(text);
        if (!local.valid) return showValidation(local);
        const res = await send(MSG.VALIDATE_PROMPTS, { text });
        showValidation(res.parse, res.note);
        await refresh();
    });

    $('btnClear').addEventListener('click', () => {
        $('prompts').value = '';
        $('validation').hidden = true;
        saveDraft();
    });

    $('btnImport').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const text = await file.text();
        $('prompts').value = text;
        saveDraft();
        const local = localParse(text);
        showValidation(local, local.count ? `${local.count} prompt${local.count === 1 ? '' : 's'} loaded from ${file.name}` : null);
    });

    $('btnStart').addEventListener('click', async () => {
        const text = $('prompts').value;
        const local = localParse(text);
        if (!local.valid) {
            switchTab('prompts');
            return showValidation(local);
        }
        const res = await send(MSG.START_QUEUE, { text });
        if (!res.started) {
            showValidation(res.parse || local, res.note);
            return;
        }
        switchTab('queue');
        await refresh();
    });

    $('btnPause').addEventListener('click', () => send(MSG.PAUSE_QUEUE).then(refresh));
    $('btnResume').addEventListener('click', () => send(MSG.RESUME_QUEUE).then((r) => (r.note ? setStatus(r.note) : refresh())));
    $('btnStop').addEventListener('click', () => send(MSG.STOP_QUEUE).then(refresh));

    $('btnRetryFailed').addEventListener('click', () => send(MSG.RETRY_FAILED).then((r) => (r.note ? setStatus(r.note) : refresh())));
    $('btnResetQueue').addEventListener('click', async () => {
        if (!confirm('Reset the queue? Job statuses (including completed ones) will be cleared. Downloaded files are not touched.')) return;
        await send(MSG.CLEAR_QUEUE);
        await refresh();
    });

    $('queueList').addEventListener('click', (event) => {
        const retry = event.target.closest('[data-retry]');
        if (retry) {
            event.stopPropagation();
            send(MSG.RETRY_JOB, { number: Number(retry.dataset.retry) }).then(refresh);
            return;
        }
        const item = event.target.closest('.job.failed');
        if (!item) return;
        const n = Number(item.dataset.number);
        expandedJobs.has(n) ? expandedJobs.delete(n) : expandedJobs.add(n);
        render();
    });

    $('btnCopyLog').addEventListener('click', async () => {
        const { text } = await send(MSG.GET_LOGS);
        await navigator.clipboard.writeText(text || '');
        setStatus('Debug log copied to clipboard');
    });
    $('btnClearLog').addEventListener('click', async () => {
        await send(MSG.CLEAR_LOGS);
        $('logBox').replaceChildren();
    });

    $('btnDiagnostics').addEventListener('click', async () => {
        $('diagnostics').replaceChildren(el('p', 'hint', 'Running diagnostics…'));
        try {
            const { diagnostics } = await send(MSG.RUN_DIAGNOSTICS);
            renderDiagnostics(diagnostics);
        } catch (error) {
            $('diagnostics').replaceChildren(el('p', 'hint', `Diagnostics failed: ${error.message}`));
        }
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === MSG.QUEUE_UPDATE) {
            view = { ...view, state: message.state, stats: message.stats, running: message.running };
            render();
        } else if (message?.type === MSG.LOG_ENTRY && !$('tab-log').hidden) {
            appendLog(message.entry);
        }
    });
}

(async function main() {
    bind();
    await refresh();
    $('prompts').value = view.state?.promptsText || '';
    if (view.state?.jobs.length) switchTab('queue');
})();
