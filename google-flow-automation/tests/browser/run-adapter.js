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

    try {
        const ready = adapter.checkReady();
        check('checkReady: ready + authenticated + project open', ready.ready && ready.authenticated && ready.projectOpen, ready);

        const prompt = 'A cinematic futuristic city, neon lights, rain, 4K';
        const image = await adapter.generateImage(prompt, opts);
        check('image mode was selected', window.mock.submissions[0].mode === 'Create Image', window.mock.submissions[0]);
        check('prompt submitted exactly', window.mock.submissions[0].prompt === prompt, window.mock.submissions[0].prompt);
        check('clicked the arrow submit button, not another button', window.mock.decoyClicks === 0 && window.mock.submissions.length === 1, { decoyClicks: window.mock.decoyClicks, submissions: window.mock.submissions.length });
        check('script click ignored -> real click at the arrow position submitted it', window.mock.ignoredClicks === 1 && trustedCalls[0] === 'click', { ignored: window.mock.ignoredClicks, trustedCalls });
        check('new image found (not the old one)', image.ref && adapter.refs.get(image.ref).alt === 'generated', image);

        const pending = await adapter.animateImage(image, { ...opts, prompt });
        check('animate + submit produced a video submission with the frame', window.mock.submissions[1]?.frame === true, window.mock.submissions[1]);

        check('after one ignored click, real clicks are used directly', window.mock.ignoredClicks === 1 && adapter.preferTrusted, { ignored: window.mock.ignoredClicks });
        const video = await adapter.waitForVideo(pending, opts);
        const info = adapter.getVideoInfo(video);
        check('video detected, blob URL reported as not directly downloadable', info.isBlob && info.url === null, info);

        await adapter.triggerNativeDownload(video, opts);
        check('native download button + menu option clicked', window.mock.downloads.length === 1, window.mock.downloads);

        // Error path: Flow shows an error toast after submit.
        window.mock.failNext = 'Something went wrong. Please try again.';
        let flowError = null;
        await adapter.generateImage('second prompt', opts).catch((e) => (flowError = e));
        check('Flow error toast is detected as FLOW_ERROR', flowError?.code === 'FLOW_ERROR', flowError?.message);

        document.querySelectorAll('[role=alert]').forEach((n) => n.remove());
        window.mock.failNext = 'This prompt violates our policy';
        let policy = null;
        await adapter.generateImage('third prompt', opts).catch((e) => (policy = e));
        check('policy error is non-retryable', policy?.code === 'CONTENT_POLICY' && policy.retryable === false, policy?.message);

        const stale = await adapter.waitForVideo({ token: 'nope' }, opts).catch((e) => e);
        check('lost state after reload -> STATE_LOST', stale.code === 'STATE_LOST', stale.message);

        const diag = adapter.diagnose();
        const missing = diag.items.filter((i) => !i.found).map((i) => i.key);
        check('diagnostics find the core controls', ['promptInput', 'generateButton', 'generatedImage', 'animateButton', 'generatedVideo', 'downloadButton'].every((k) => !missing.includes(k)), { missing, diag });
    } catch (error) {
        check('unexpected exception', false, `${error.code || ''} ${error.message}`);
    }

    const passed = checks.filter((c) => c.ok).length;
    window.__RESULT__ = { passed, total: checks.length, checks, logs };
    document.title = `ADAPTER ${passed}/${checks.length}`;
    console.log('ADAPTER RESULT', JSON.stringify(window.__RESULT__, null, 2));
})();
