/**
 * Flow Adapter (content-script side). The only code that drives Google Flow's DOM.
 * It uses selector keys from selectors.js and generic helpers from dom-utils.js.
 *
 * Elements can't cross extension messaging, so results are returned as small reference
 * objects ({ ref: 'img-3' }) that this adapter resolves back to elements later. After a page
 * reload those refs are gone, and callers get a STATE_LOST error (-> retry by the engine).
 */
(function () {
    const ns = globalThis.__GFA__;
    const dom = ns.dom;

    const POLICY_PATTERN = '(policy|violat|not allowed|unsafe|prohibited|guidelines)';
    const QUOTA_PATTERN = '(quota|limit reached|daily limit|rate limit|too many requests|out of credits|insufficient credits|no credits)';
    const STABILITY_MS = 2000;
    const PROGRESS_GRACE_MS = 45000; // max wait for a lingering progress indicator once the video is there

    class FlowError extends Error {
        constructor(message, { code = 'FLOW_ERROR', retryable = true } = {}) {
            super(message);
            this.name = 'FlowError';
            this.code = code;
            this.retryable = retryable;
        }
    }

    function classifyFlowMessage(text) {
        if (dom.rx(QUOTA_PATTERN).test(text)) return new FlowError(`Flow: ${text}`, { code: 'QUOTA_EXCEEDED', retryable: false });
        if (dom.rx(POLICY_PATTERN).test(text)) return new FlowError(`Flow content policy: ${text}`, { code: 'CONTENT_POLICY', retryable: false });
        return new FlowError(`Flow error: ${text}`);
    }

    class FlowAdapter {
        constructor({ selectors, log, trusted = null }) {
            this.selectors = selectors;
            this.log = log || (() => {});
            this.trusted = trusted; // (action, args) => Promise: real input via the background
            this.preferTrusted = false; // set once Flow has ignored a script click
            this.refs = new Map();
            this.pendingVideos = new Map();
            this.seq = 0;
        }

        setSelectors(selectors) {
            this.selectors = selectors;
        }

        sel(key) {
            return this.selectors[key] || [];
        }

        debug(message) {
            this.log('debug', message);
        }

        // ── references ────────────────────────────────────────────────────
        register(el, kind) {
            const ref = `${kind}-${++this.seq}`;
            this.refs.set(ref, el);
            if (this.refs.size > 50) this.refs.delete(this.refs.keys().next().value); // keep it light
            return ref;
        }

        resolve(refObj, kind) {
            const el = refObj && this.refs.get(refObj.ref);
            if (!el || !el.isConnected) {
                throw new FlowError(`The generated ${kind} is no longer on the page (page reloaded or UI re-rendered)`, { code: 'STATE_LOST' });
            }
            return el;
        }

        // ── page / auth ──────────────────────────────────────────────────
        detectPage() {
            const host = location.hostname;
            return { isFlowPage: host === 'flow.google.com' || (host === 'labs.google' && location.pathname.includes('/flow')), url: location.href };
        }

        detectAuth() {
            if (dom.findFirst(this.sel('signInIndicator'))) return false;
            if (this.findPromptInput() || dom.findFirst(this.sel('accountIndicator'))) return true;
            return null; // unknown
        }

        /**
         * Where the user is in Flow. The user opens (or creates) the project themselves; the
         * extension never navigates Flow for them. A project is open when the URL is a project
         * page (/project/<id>) or, for UI variants without one, the prompt box is on screen.
         */
        getStatus() {
            const page = this.detectPage();
            const authenticated = this.detectAuth();
            const projectId = location.pathname.match(/\/project\/([^/?#]+)/)?.[1] || null;
            const promptFound = Boolean(this.findPromptInput());
            const projectOpen = authenticated !== false && (Boolean(projectId) || promptFound);
            const title = dom.normalizeText(document.title.replace(/\s*[-|–—]\s*(Google\s+)?Flow\b.*$/i, ''));
            return {
                ...page,
                authenticated: promptFound ? true : authenticated,
                projectOpen,
                projectId,
                projectName: projectOpen && title && !/^(google\s+)?flow$/i.test(title) ? title : null,
                promptFound
            };
        }

        checkReady() {
            const status = this.getStatus();
            if (status.authenticated === false) return { ...status, ready: false, reason: 'Sign-in required' };
            if (!status.projectOpen) return { ...status, ready: false, reason: 'No project is open in Google Flow. Open or create a project there.' };
            if (!status.promptFound) {
                return { ...status, ready: false, reason: 'The Flow project is open but its prompt box was not found (still loading, or update the "promptInput" selector — run Flow Diagnostics).' };
            }
            return { ...status, ready: true };
        }

        // ── prompt ───────────────────────────────────────────────────────
        /** The project's main prompt box — never the one inside an opened result viewer/dialog. */
        findPromptInput() {
            return dom.findFirst(this.sel('promptInput'), { filter: (el) => dom.isEnabled(el) && !el.readOnly && !this.inOverlay(el) });
        }

        inOverlay(el) {
            return Boolean(el.closest('[role="dialog"],[aria-modal="true"]'));
        }

        async setPrompt(text, { signal, timeout = 30000 } = {}) {
            const input = await dom.waitForElement(this.sel('promptInput'), {
                timeout,
                signal,
                filter: (el) => dom.isEnabled(el) && !el.readOnly && !this.inOverlay(el),
                message: 'Prompt input not found (selector "promptInput")'
            });
            for (let attempt = 1; attempt <= 2; attempt++) {
                dom.replaceText(input, text);
                await dom.sleep(200, signal);
                const actual = dom.normalizeText(dom.readInputText(input));
                if (actual === dom.normalizeText(text)) {
                    this.debug(`Prompt entered (${text.length} chars)`);
                    return input;
                }
                this.debug(`Prompt verification failed (attempt ${attempt}); UI shows: "${actual.slice(0, 80)}"`);
            }
            throw new FlowError('Prompt did not appear correctly in the Flow input');
        }

        /**
         * The submit button of the prompt's own composer: search outward from the prompt box so
         * other "Create…" buttons on the page (new project, collections, mode menus) never win.
         */
        findGenerateButton(input = this.findPromptInput()) {
            const candidate = (el) => el.matches('button,[role="button"]') && !el.hasAttribute('aria-haspopup') && !(input && el.contains(input));
            if (!input) return dom.findFirst(this.sel('generateButton'), { filter: candidate });
            let node = input.parentElement;
            for (let depth = 0; node && node !== document.body && depth < 10; depth++, node = node.parentElement) {
                const hit = dom.findFirst(this.sel('generateButton'), { root: node, filter: candidate }) || this.findArrowButton(node, input);
                if (hit) return hit;
            }
            // Never fall back to a page-wide match: that is how a different "Create…" button got clicked.
            return null;
        }

        /**
         * Flow's submit is an icon-only button (a right-pointing arrow, often an SVG with no text
         * or label), so selectors can't name it. Pick the icon button in the composer that sits
         * to the right of / below the prompt, skipping ones whose name says they do something else.
         */
        findArrowButton(root, input) {
            const OTHER = /(add|attach|upload|image|photo|media|frame|ingredient|mic|voice|setting|tune|option|more|menu|close|cancel|delete|remove|clear|expand|collapse|model|mode|aspect|count|help)/i;
            const ARROW = /(arrow|send|submit|create|generate|north|east|forward|right)/i;
            const box = input.getBoundingClientRect();
            let best = null;
            for (const el of root.querySelectorAll('button,[role="button"]')) {
                if (el.contains(input) || el.hasAttribute('aria-haspopup') || !dom.isVisible(el)) continue;
                const name = dom.accessibleName(el);
                const iconOnly = name.length <= 30 && (!name || /^[a-z0-9_]+$/.test(name) || Boolean(el.querySelector('svg,img,i,mat-icon,[class*="icon" i],[class*="symbol" i]')));
                if (!iconOnly) continue;
                if (name && OTHER.test(name) && !ARROW.test(name)) continue;
                const r = el.getBoundingClientRect();
                const rightOrBelow = r.left >= box.left + box.width / 2 || r.top >= box.bottom - 4;
                if (!rightOrBelow) continue;
                const score = (ARROW.test(name) ? 10 : 0) + (el.querySelector('svg') || /arrow/i.test(name) ? 2 : 0) + r.right / 10000 + r.bottom / 100000;
                if (!best || score > best.score) best = { el, score };
            }
            return best?.el || null;
        }

        /** Re-announce the prompt to the page's framework so it enables its submit button. */
        nudgePrompt(input, text) {
            if (!input || !text) return;
            if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
                dom.replaceText(input, text);
            } else {
                dom.pasteText(input, text);
                if (dom.normalizeText(dom.readInputText(input)) !== dom.normalizeText(text)) dom.replaceText(input, text);
            }
            dom.pressKey(input, 'End');
        }

        /** Viewport centre of an element, for real (debugger) clicks. */
        centerOf(el) {
            el.scrollIntoView({ block: 'center', inline: 'center' });
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }

        /** Retype the prompt as real keyboard input so Flow's editor state definitely has it. */
        async typePromptTrusted(input, text) {
            if (!this.trusted || !input || !text) return false;
            input.focus();
            if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
                input.select();
            } else {
                const range = document.createRange();
                range.selectNodeContents(input);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
            await this.trusted('insertText', { text });
            await dom.sleep(300);
            return dom.normalizeText(dom.readInputText(input)) === dom.normalizeText(text);
        }

        /** One way of submitting the composer. Returns a description for the log. */
        async pressGenerate(method, { text, signal, timeout }) {
            const input = this.findPromptInput();
            if (method === 'enter' || method === 'trusted-enter') {
                if (!input) return null;
                input.focus();
                if (method === 'trusted-enter') {
                    if (!this.trusted) return null;
                    await this.trusted('pressEnter');
                    return 'pressing Enter (real key press)';
                }
                dom.pressKey(input, 'Enter');
                return 'pressing Enter in the prompt box';
            }
            const button = await dom
                .waitForCondition(() => this.findGenerateButton(input), { timeout: Math.min(timeout, 10000), signal })
                .catch((e) => {
                    if (e.code === 'ABORTED') throw e;
                    return null;
                });
            if (!button) return null;

            // Flow enables the button only once its own state has seen the prompt.
            const enabled = () => dom.isEnabled(button) && button.isConnected;
            const waitEnabled = (ms) =>
                dom.waitForCondition(enabled, { timeout: ms, signal, interval: 200 }).catch((e) => {
                    if (e.code === 'ABORTED') throw e;
                    return false;
                });
            if (!(await waitEnabled(4000))) {
                this.debug('Generate button is still disabled — re-entering the prompt so Flow registers it');
                this.nudgePrompt(input, text);
                if (!(await waitEnabled(3000)) && (await this.typePromptTrusted(input, text).catch(() => false))) {
                    this.debug('Retyped the prompt with real key presses');
                    await waitEnabled(3000);
                }
                if (!enabled()) this.log('warn', `Generate button stays disabled (${dom.describeElement(button)}); clicking anyway`);
            }
            if (method === 'trusted-click') {
                if (!this.trusted) return null;
                this.debug(`Real click on generate: ${dom.describeElement(button)}`);
                await this.trusted('click', this.centerOf(button));
                return { button, how: `a real click on ${dom.describeElement(button)}` };
            }
            this.debug(`Clicking generate: ${dom.describeElement(button)}`);
            dom.click(button);
            return { button, how: `clicking ${dom.describeElement(button)}` };
        }

        /**
         * Submit the composer and CONFIRM Flow started generating. If it didn't react, try a
         * different method instead of carrying on (the old behaviour left the prompt unsent).
         */
        async submit(baseline, { kind, text = '', signal, timeout = 30000 }) {
            const deadline = Date.now() + timeout;
            // Script click first; Flow's arrow may ignore script events, so then a real click.
            // Once a real click was needed, go straight to it for the rest of the session.
            const methods = this.trusted
                ? this.preferTrusted
                    ? ['trusted-click', 'trusted-enter', 'trusted-click']
                    : ['click', 'trusted-click', 'trusted-enter']
                : ['click', 'enter', 'click'];
            for (let i = 0; i < methods.length; i++) {
                const last = i === methods.length - 1;
                let result;
                try {
                    result = await this.pressGenerate(methods[i], { text, signal, timeout: Math.max(1000, deadline - Date.now()) });
                } catch (error) {
                    if (error.code === 'ABORTED') throw error;
                    this.log('warn', `Could not submit by ${methods[i]}: ${error.message}`);
                    continue;
                }
                if (!result) continue;
                const { button = null, how } = typeof result === 'string' ? { how: result } : result;
                const windowMs = last ? Math.max(deadline - Date.now(), 3000) : Math.min(6000, Math.max(deadline - Date.now(), 3000));
                const started = await this.waitForGenerationStart(baseline, { kind, button, promptSet: Boolean(text), timeout: windowMs, signal }).catch((e) => {
                    if (e.code !== 'TIMEOUT') throw e;
                    return null;
                });
                if (started) {
                    this.debug(`Generation started (${started}) after ${how}`);
                    if (methods[i].startsWith('trusted') && !this.preferTrusted) {
                        this.preferTrusted = true;
                        this.log('info', 'Flow only accepts real clicks — using them from now on');
                    }
                    return started;
                }
                if (!last) this.log('warn', `Flow did not start generating after ${how}; trying again`);
            }
            throw new FlowError('Flow did not start generating: the Create button next to the prompt did not respond. Run Flow Diagnostics and check the "generateButton" selector.', {
                code: 'UI_NOT_FOUND'
            });
        }

        // ── media tracking ───────────────────────────────────────────────
        mediaKey(el) {
            if (el.tagName === 'VIDEO') return el.currentSrc || el.src || el.querySelector('source[src]')?.src || '';
            return el.currentSrc || el.src || '';
        }

        bigEnough(el) {
            const r = el.getBoundingClientRect();
            return r.width >= ns.MIN_MEDIA_SIZE && r.height >= ns.MIN_MEDIA_SIZE;
        }

        /** Union of all strategies (not first-match) so new media is found whatever its src type. */
        collectMedia(key) {
            const set = new Set();
            for (const strategy of this.sel(key)) {
                for (const el of dom.queryStrategy(strategy)) if (dom.isVisible(el) && this.bigEnough(el)) set.add(el);
            }
            return [...set];
        }

        snapshot() {
            const videos = [...document.querySelectorAll('video')];
            return {
                videoEls: new WeakSet(videos),
                videoKeys: new Set(videos.map((el) => this.mediaKey(el)).filter(Boolean)),
                errors: new Set(this.currentErrors()),
                progressCount: this.activeProgress().length
            };
        }

        newVideos(baseline) {
            return this.collectMedia('generatedVideo').filter((el) => {
                const key = this.mediaKey(el);
                return key && !baseline.videoEls.has(el) && !baseline.videoKeys.has(key) && !this.inOverlay(el);
            });
        }

        /** Nearest ancestor that looks like a result card (holds the media + its action buttons). */
        findCard(el) {
            for (const strategy of this.sel('resultCard')) {
                if (strategy.css) {
                    const card = el.closest(strategy.css);
                    if (card) return card;
                }
            }
            const viewportArea = window.innerWidth * window.innerHeight;
            let node = el.parentElement;
            for (let i = 0; node && i < 8; i++, node = node.parentElement) {
                const r = node.getBoundingClientRect();
                if (r.width * r.height > viewportArea * 0.6) break;
                if (node.querySelector('button,[role="button"]')) return node;
            }
            return el.parentElement || el;
        }

        /** Progress value 0–100 shown by an indicator, or null if it shows none. */
        progressValue(el) {
            const now = Number(el.getAttribute('aria-valuenow'));
            if (el.hasAttribute('aria-valuenow') && Number.isFinite(now)) {
                const max = Number(el.getAttribute('aria-valuemax')) || 100;
                return (now / max) * 100;
            }
            const match = (el.innerText || el.textContent || '').match(/(\d{1,3})\s*%/);
            return match ? Number(match[1]) : null;
        }

        /**
         * Indicators of work still in progress. Flow leaves a finished tile's "100%" label on
         * screen for a while; counting it made the run wait long after the video was done.
         */
        activeProgress(root = document) {
            return dom.findAll(this.sel('progressIndicator'), { root }).elements.filter((el) => {
                const value = this.progressValue(el);
                return value === null || value < 100;
            });
        }

        progressIn(root) {
            return this.activeProgress(root).length;
        }

        currentErrors() {
            const re = dom.rx(ns.ERROR_TEXT_PATTERN);
            const texts = [];
            for (const strategy of this.sel('errorMessage')) {
                for (const el of dom.queryStrategy(strategy)) {
                    const text = dom.normalizeText(el.innerText || el.textContent);
                    if (text && re.test(text) && dom.isVisible(el)) texts.push(text.slice(0, 300));
                }
            }
            return texts;
        }

        detectGenerationError(baseline) {
            return this.currentErrors().find((t) => !baseline.errors.has(t)) || null;
        }

        throwIfFlowError(baseline) {
            const text = this.detectGenerationError(baseline);
            if (text) throw classifyFlowMessage(text);
        }

        progressText() {
            const el = dom.findAll(this.sel('progressIndicator')).elements.find((e) => /\d+\s*%/.test(e.innerText || e.getAttribute('aria-valuenow') || ''));
            if (!el) return null;
            const now = el.getAttribute('aria-valuenow');
            return now ? `${now}%` : dom.normalizeText(el.innerText);
        }

        /**
         * Signs that Flow accepted the submit: a new progress indicator or result, the clicked
         * button turning disabled/removed, or (when we typed a prompt) the composer being cleared.
         */
        waitForGenerationStart(baseline, { kind, button = null, promptSet = false, timeout = 30000, signal } = {}) {
            return dom.waitForCondition(
                () => {
                    this.throwIfFlowError(baseline);
                    if (this.activeProgress().length > baseline.progressCount) return 'progress';
                    if (kind === 'video' && this.newVideos(baseline).length) return 'result';
                    if (button && (!button.isConnected || !dom.isEnabled(button))) return 'generate-disabled';
                    if (promptSet) {
                        const input = this.findPromptInput();
                        if (input && !dom.normalizeText(dom.readInputText(input))) return 'prompt-cleared';
                    }
                    return false;
                },
                { timeout, signal, interval: 500, message: 'Generation did not start after clicking Generate' }
            );
        }

        /** Resolve once `pick()` returns the same non-empty set of finished media for STABILITY_MS. */
        waitForStableMedia(baseline, pick, { timeout, signal, onProgress, message }) {
            let lastSignature = '';
            let stableSince = 0;
            let lastProgress = '';
            let foundAt = 0;
            let loggedBusy = false;
            const revealed = new WeakSet();
            return dom.waitForCondition(
                () => {
                    this.throwIfFlowError(baseline);
                    const progress = this.progressText();
                    if (progress && progress !== lastProgress) {
                        lastProgress = progress;
                        onProgress?.(`progress ${progress}`);
                    }
                    const items = pick();
                    if (!items.length) {
                        // Flow can collapse finished videos behind a "Show N videos" button (inline, not a viewer).
                        const show = dom.findAll(this.sel('showVideosButton')).elements.find((el) => !revealed.has(el) && !this.inOverlay(el));
                        if (show) {
                            revealed.add(show);
                            this.debug(`Revealing videos: ${dom.describeElement(show)}`);
                            dom.click(show);
                        }
                        return false;
                    }
                    // Still generating (more clips of this prompt, or this tile not finished)? Wait,
                    // but only for so long once the video is there: an indicator that never clears
                    // (unrelated tile, stuck label) must not hold the download back.
                    foundAt ||= Date.now();
                    const busy = this.activeProgress().length > baseline.progressCount || items.some((el) => this.progressIn(this.findCard(el)) > 0);
                    if (busy && Date.now() - foundAt < PROGRESS_GRACE_MS) {
                        if (!loggedBusy) {
                            loggedBusy = true;
                            this.debug('Video is on the page; waiting for Flow to finish its progress indicator');
                        }
                        stableSince = 0;
                        return false;
                    }
                    if (busy && Date.now() - foundAt >= PROGRESS_GRACE_MS && stableSince === 0) {
                        this.log('warn', `A progress indicator is still showing ${Math.round(PROGRESS_GRACE_MS / 1000)}s after the video appeared; downloading anyway`);
                    }
                    const signature = items.map((el) => this.mediaKey(el)).join('|');
                    if (signature !== lastSignature) {
                        lastSignature = signature;
                        stableSince = Date.now();
                        return false;
                    }
                    return Date.now() - stableSince >= STABILITY_MS ? items : false;
                },
                { timeout, signal, interval: 1000, message }
            );
        }

        // ── high-level steps ─────────────────────────────────────────────
        /**
         * The project page the run works on. Every prompt is typed into THIS page's main prompt
         * box; result viewers (a different URL, or a dialog) are closed before each prompt.
         */
        rememberHome() {
            if (this.homePath) return;
            const project = location.pathname.match(/^(.*\/project\/[^/?#]+)/);
            this.homePath = project ? project[1] : location.pathname.replace(/\/$/, '');
            this.debug(`Working in ${this.homePath}`);
        }

        isAwayFromHome() {
            return Boolean(this.homePath) && location.pathname.replace(/\/$/, '') !== this.homePath;
        }

        openOverlay() {
            return [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].find((el) => dom.isVisible(el)) || null;
        }

        /** Close any opened result viewer / dialog so we are back at the main prompt box. */
        async returnToComposer({ signal } = {}) {
            for (let attempt = 1; attempt <= 4; attempt++) {
                const overlay = this.openOverlay();
                const away = this.isAwayFromHome();
                if (!overlay && !away) return;
                if (overlay) {
                    const close = dom.findFirst(this.sel('closeButton'), { root: overlay });
                    this.debug(`Closing ${close ? dom.describeElement(close) : 'the open viewer (Escape)'} to get back to the main prompt box`);
                    if (close) dom.click(close);
                    else for (const target of [document.activeElement || document.body, overlay]) dom.pressKey(target, 'Escape');
                } else {
                    this.debug(`On ${location.pathname} — going back to the project page ${this.homePath}`);
                    history.back();
                }
                await dom.sleep(1000, signal);
            }
            if (this.openOverlay() || this.isAwayFromHome()) {
                throw new FlowError("Couldn't get back to the project's main prompt box (a result viewer stayed open). Close it in the Flow tab.", { code: 'UI_NOT_FOUND' });
            }
        }

        /** Type the prompt into the main prompt box and submit it. Returns a pending-video token. */
        async submitPrompt(prompt, { elementTimeoutMs = 30000, signal, onProgress } = {}) {
            this.rememberHome();
            await this.returnToComposer({ signal });
            const baseline = this.snapshot();
            await this.setPrompt(prompt, { signal, timeout: elementTimeoutMs });
            onProgress?.('Prompt entered');
            await this.submit(baseline, { kind: 'video', text: prompt, signal, timeout: elementTimeoutMs });
            onProgress?.('Generating video…');
            const token = `pv-${++this.seq}`;
            this.pendingVideos.set(token, baseline);
            return { token };
        }

        async waitForVideo(pending, { timeoutMs = 600000, signal, onProgress } = {}) {
            const baseline = pending && this.pendingVideos.get(pending.token);
            if (!baseline) throw new FlowError('Video generation state was lost (page reloaded)', { code: 'STATE_LOST' });
            const videos = await this.waitForStableMedia(baseline, () => this.newVideos(baseline), {
                timeout: timeoutMs,
                signal,
                onProgress: (p) => onProgress?.(`Generating video… ${p}`),
                message: 'Video generation timed out'
            });
            this.pendingVideos.delete(pending.token);
            const video = videos[0];
            this.debug(`New video: ${dom.describeElement(video)} src=${this.mediaKey(video).slice(0, 80)}`);
            return { ref: this.register(video, 'video'), count: videos.length };
        }

        getLatestGeneratedVideo(baseline) {
            return this.newVideos(baseline)[0] || null;
        }

        getVideoInfo(videoRef) {
            const video = this.resolve(videoRef, 'video');
            const url = this.mediaKey(video);
            const mimeHint = video.querySelector('source[type]')?.type || null;
            if (!url || url.startsWith('blob:')) return { url: null, isBlob: Boolean(url), mimeHint };
            return { url, isBlob: false, mimeHint };
        }

        async triggerNativeDownload(videoRef, { signal } = {}) {
            const video = this.resolve(videoRef, 'video');
            const card = this.findCard(video);
            video.scrollIntoView({ block: 'center' });
            dom.hover(card);
            dom.hover(video);
            await dom.sleep(400, signal);
            let control = dom.findFirst(this.sel('downloadButton'), { root: card });
            if (!control) {
                const more = dom.findFirst(this.sel('cardMoreButton'), { root: card });
                if (more) {
                    dom.click(more);
                    control = await dom.waitForElement(this.sel('downloadMenuOption'), { timeout: 4000, signal }).catch(() => null);
                }
            }
            if (!control) control = dom.findFirst(this.sel('downloadButton'), { root: card, visibleOnly: false }); // CSS-:hover-only controls
            if (!control) control = dom.findFirst(this.sel('downloadButton'));
            if (!control) throw new FlowError('Download control not found (selector "downloadButton")', { code: 'UI_NOT_FOUND' });
            this.debug(`Clicking download: ${dom.describeElement(control)}`);
            dom.click(control);
            // Many UIs open a size/format menu — pick the first matching option if one appears.
            const option = await dom.waitForElement(this.sel('downloadMenuOption'), { timeout: 3000, signal }).catch(() => null);
            if (option) {
                this.debug(`Choosing download option: ${dom.accessibleName(option)}`);
                dom.click(option);
            }
            await dom.sleep(300, signal);
            if (dom.findFirst([{ css: '[role="menu"]' }])) dom.pressKey(document.activeElement || document.body, 'Escape');
            return { clicked: true };
        }

        // ── diagnostics ──────────────────────────────────────────────────
        diagnose() {
            const page = this.detectPage();
            const auth = this.detectAuth();
            // Hover-only controls live on result cards: probe a few of the first/last video cards
            // (newest may be at either end). Hover only — diagnostics never click.
            const edge = (list) => [...list.slice(0, 3), ...list.slice(-3)];
            const cards = [...new Set(edge(this.collectMedia('generatedVideo')).map((m) => this.findCard(m)))];
            cards.forEach((c) => dom.hover(c));
            const items = ns.DIAGNOSTIC_KEYS.map(([key, label]) => {
                const media = key === 'generatedVideo';
                if (key === 'generateButton') {
                    // Report the button a run would actually click (the composer's own).
                    const button = this.findGenerateButton();
                    const strategy = button && this.sel(key).find((s) => dom.queryStrategy(s).includes(button));
                    return {
                        key,
                        label,
                        found: Boolean(button),
                        count: button ? 1 : 0,
                        strategy: strategy ? dom.describeStrategy(strategy) : button ? 'the arrow icon beside the prompt' : null,
                        verified: Boolean(strategy?.verified),
                        sample: button ? `${dom.describeElement(button)}${dom.isEnabled(button) ? '' : ' (disabled until a prompt is entered)'}` : null
                    };
                }
                const elements = media ? this.collectMedia(key) : dom.findAll(this.sel(key)).elements;
                let scoped = [];
                let match = media || !elements.length ? null : dom.findAll(this.sel(key)).strategy;
                if (!elements.length && !media) {
                    for (const c of cards) {
                        const hit = dom.findAll(this.sel(key), { root: c, visibleOnly: false });
                        if (hit.elements.length) {
                            scoped = hit.elements;
                            match = hit.strategy;
                            break;
                        }
                    }
                }
                const all = elements.length ? elements : scoped;
                return {
                    key,
                    label,
                    found: all.length > 0,
                    count: all.length,
                    strategy: match ? dom.describeStrategy(match) : null,
                    verified: Boolean(match?.verified),
                    sample: all[0] ? dom.describeElement(all[0]) : null
                };
            });
            const status = this.getStatus();
            return {
                ...page,
                authenticated: auth,
                projectOpen: status.projectOpen,
                projectName: status.projectName,
                signInVisible: Boolean(dom.findFirst(this.sel('signInIndicator'))),
                items,
                errorsOnPage: this.currentErrors()
            };
        }
    }

    ns.FlowAdapter = FlowAdapter;
    ns.FlowError = FlowError;
})();
