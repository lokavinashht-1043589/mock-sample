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

    /** One job as the engine runs it: prompt -> wait for the video -> download. */
    async function runJob(prompt) {
        const pending = await adapter.submitPrompt(prompt, opts);
        const video = await adapter.waitForVideo(pending, opts);
        await adapter.triggerNativeDownload(video, opts);
        return video;
    }

    try {
        const ready = adapter.checkReady();
        check('checkReady: ready + authenticated + project open', ready.ready && ready.authenticated && ready.projectOpen, ready);

        const first = 'A cinematic futuristic city, neon lights, rain, 4K';
        const video1 = await runJob(first);
        const readyToDownload = (window.mock.downloadedAt[0] - window.mock.readyAt[0]) / 1000;
        check('downloads within seconds of the video being ready, despite the lingering "100%" label', readyToDownload < 5, { readyToDownloadSeconds: readyToDownload });
        check('prompt 1 submitted exactly from the main prompt box', window.mock.submissions[0]?.prompt === first, window.mock.submissions);
        check('clicked the arrow submit button, not another button', window.mock.decoyClicks === 0 && window.mock.submissions.length === 1, { decoyClicks: window.mock.decoyClicks, submissions: window.mock.submissions.length });
        check('script click ignored -> real click at the arrow position submitted it', window.mock.ignoredClicks === 1 && trustedCalls[0] === 'click', { ignored: window.mock.ignoredClicks, trustedCalls });
        check('waited for the video, then downloaded it (blob -> native download)', window.mock.downloads.length === 1 && adapter.getVideoInfo(video1).isBlob, window.mock.downloads);

        await new Promise((r) => setTimeout(r, 300)); // Flow opens the result viewer after job 1
        check('(setup) Flow opened a result viewer with its own prompt box', window.mock.viewerOpened === 1 && document.querySelector('.viewer'), null);

        const second = 'A cute robot walking through a magical forest';
        await runJob(second);
        check('viewer was closed; prompt 2 went into the SAME main prompt box', window.mock.submissions[1]?.prompt === second && window.mock.viewerSubmissions.length === 0 && !document.querySelector('.viewer'), {
            submissions: window.mock.submissions,
            viewer: window.mock.viewerSubmissions
        });
        check('"Show 1 Videos" was expanded and video 2 downloaded', window.mock.downloads.length === 2, window.mock.downloads);
        check('after one ignored click, real clicks are used directly', window.mock.ignoredClicks === 1 && adapter.preferTrusted, { ignored: window.mock.ignoredClicks });

        // Error path: Flow shows an error toast after submit.
        window.mock.failNext = 'Something went wrong. Please try again.';
        let flowError = null;
        await adapter.submitPrompt('third prompt', opts).then((p) => adapter.waitForVideo(p, opts)).catch((e) => (flowError = e));
        check('Flow error toast is detected as FLOW_ERROR', flowError?.code === 'FLOW_ERROR', flowError?.message);

        document.querySelectorAll('[role=alert]').forEach((n) => n.remove());
        window.mock.failNext = 'This prompt violates our policy';
        let policy = null;
        await adapter.submitPrompt('fourth prompt', opts).then((p) => adapter.waitForVideo(p, opts)).catch((e) => (policy = e));
        check('policy error is non-retryable', policy?.code === 'CONTENT_POLICY' && policy.retryable === false, policy?.message);

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
