// Drives the real FlowAdapter against mock-flow.html and stores results in window.__RESULT__.
// Open http://localhost:8787/tests/browser/mock-flow.html (npm run serve) and read the
// result from the page title / console, or window.__RESULT__.
(async function () {
    const ns = globalThis.__GFA__;
    const logs = [];
    // Stand-in for the background's chrome.debugger input (src/background/trusted-input.js).
    const trustedCalls = [];
    const trusted = async (action, args) => {
        trustedCalls.push(action);
        if (action === 'click') {
            window.mock.realClick = true;
            try { document.elementFromPoint(args.x, args.y)?.closest('button')?.click(); } finally { window.mock.realClick = false; }
        }
    };
    const adapter = new ns.FlowAdapter({ selectors: ns.FLOW_SELECTORS, log: (level, m) => logs.push(`${level}: ${m}`), trusted });
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
    const opts = { timeoutMs: 15000, elementTimeoutMs: 5000, onProgress: (p) => logs.push(`progress: ${typeof p === 'string' ? p : JSON.stringify(p)}`) };

    // Same scheduling as the engine: generation one at a time; at 100% the next prompt goes,
    // and downloads run in a background chain whose page clicks never overlap typing.
    let pageLock = Promise.resolve();
    const withPage = (fn) => {
        const run = pageLock.then(fn, fn);
        pageLock = run.catch(() => {});
        return run;
    };
    let downloadChain = Promise.resolve();
    const events = [];
    const times = {};
    async function runJob(prompt, n) {
        const pending = await withPage(() => adapter.submitPrompt(prompt, opts));
        events.push(`submit:${n}`);
        times[`submit:${n}`] = Date.now();
        await adapter.waitForGenerated(pending, opts);
        events.push(`100%:${n}`);
        times[`100%:${n}`] = Date.now();
        downloadChain = downloadChain.then(async () => {
            const video = await adapter.waitForVideo(pending, opts);
            await withPage(() => adapter.triggerNativeDownload(video, opts));
            events.push(`downloaded:${n}`);
        });
    }

    try {
        const ready = adapter.checkReady();
        check('checkReady: ready + authenticated + project open', ready.ready && ready.authenticated && ready.projectOpen, ready);

        const prompts = ['A cinematic futuristic city, neon lights, rain, 4K', 'A cute robot walking through a magical forest', 'An astronaut exploring an alien planet'];
        for (const [i, p] of prompts.entries()) await runJob(p, i + 1);
        await downloadChain;

        check('all 3 prompts submitted exactly, in order, from the main prompt box', prompts.every((p, i) => window.mock.submissions[i]?.prompt === p) && window.mock.viewerSubmissions.length === 0, {
            submissions: window.mock.submissions.map((s) => s.prompt),
            viewer: window.mock.viewerSubmissions
        });
        check('prompt 2 was sent at 100% of prompt 1, before video 1 was even downloaded', events.indexOf('submit:2') < events.indexOf('downloaded:1'), events);
        check('each download is the video of its own prompt (no mix-ups)', window.mock.downloads.length === 3 && window.mock.downloads.every((src, i) => src === window.mock.submissions[i].src), {
            downloads: window.mock.downloads,
            srcs: window.mock.submissions.map((s) => s.src)
        });
        check('clicked the arrow submit button, not another button', window.mock.decoyClicks === 0, { decoyClicks: window.mock.decoyClicks });
        check('script click ignored once -> real clicks used from then on', window.mock.ignoredClicks === 1 && adapter.preferTrusted && trustedCalls[0] === 'click', { ignored: window.mock.ignoredClicks, trustedCalls });
        check('"Show 1 Videos" was expanded for the collapsed result', !/Show 1 Videos/.test(document.body.innerText), null);
        const nextPromptGaps = [2, 3].map((n) => (times[`submit:${n}`] - times[`100%:${n - 1}`]) / 1000);
        check('the next prompt is sent within 3s of the previous one reaching 100%', nextPromptGaps.every((g) => g < 3), { secondsAfter100: nextPromptGaps });
        check('the chat panel that was open from the start was kept (not closed as a viewer)', document.getElementById('panel')?.isConnected, null);
        const gaps = window.mock.downloadedAt.map((d, k) => (d - window.mock.readyAt[k]) / 1000);
        check('downloads start within seconds of each video appearing', gaps.length === 3 && gaps.every((g) => g < 8), { gapsSeconds: gaps });

        // Error path: Flow shows an error toast after submit.
        window.mock.failNext = 'Something went wrong. Please try again.';
        let flowError = null;
        await adapter.submitPrompt('fourth prompt', opts).then((p) => adapter.waitForGenerated(p, opts)).catch((e) => (flowError = e));
        check('Flow error toast is detected as FLOW_ERROR', flowError?.code === 'FLOW_ERROR', flowError?.message);

        document.querySelectorAll('[role=alert]').forEach((n) => n.remove());
        window.mock.failNext = 'This prompt violates our policy';
        let policy = null;
        await adapter.submitPrompt('fifth prompt', opts).then((p) => adapter.waitForGenerated(p, opts)).catch((e) => (policy = e));
        check('policy error is non-retryable', policy?.code === 'CONTENT_POLICY' && policy.retryable === false, policy?.message);

        check('the result viewer Flow opened was closed before the next prompt, and never got a prompt', window.mock.viewerOpened === 1 && !document.querySelector('.viewer') && window.mock.viewerSubmissions.length === 0, {
            opened: window.mock.viewerOpened,
            viewer: window.mock.viewerSubmissions
        });

        const stale = await adapter.waitForVideo({ token: 'nope' }, opts).catch((e) => e);
        check('lost state after reload -> STATE_LOST', stale.code === 'STATE_LOST', stale.message);

        const diag = adapter.diagnose();
        const missing = diag.items.filter((i) => !i.found).map((i) => i.key);
        check('diagnostics find the core controls', ['promptInput', 'generateButton', 'generatedVideo', 'downloadButton'].every((k) => !missing.includes(k)), { missing, diag });
    } catch (error) {
        check('unexpected exception', false, `${error.code || ''} ${error.message}`);
    }

    const passed = checks.filter((c) => c.ok).length;
    window.__RESULT__ = { passed, total: checks.length, checks, logs };
    document.title = `ADAPTER ${passed}/${checks.length}`;
    console.log('ADAPTER RESULT', JSON.stringify(window.__RESULT__, null, 2));
})();
