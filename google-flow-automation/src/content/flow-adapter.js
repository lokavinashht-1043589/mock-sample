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
        constructor({ selectors, log }) {
            this.selectors = selectors;
            this.log = log || (() => {});
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
        findPromptInput() {
            return dom.findFirst(this.sel('promptInput'), { filter: (el) => dom.isEnabled(el) && !el.readOnly });
        }

        async setPrompt(text, { signal, timeout = 30000 } = {}) {
            const input = await dom.waitForElement(this.sel('promptInput'), {
                timeout,
                signal,
                filter: (el) => dom.isEnabled(el) && !el.readOnly,
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

        /** One way of submitting the composer. Returns a description for the log. */
        async pressGenerate(method, { text, signal, timeout }) {
            const input = this.findPromptInput();
            if (method === 'enter') {
                if (!input) return null;
                input.focus();
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
                if (!(await waitEnabled(4000))) this.log('warn', `Generate button stays disabled (${dom.describeElement(button)}); clicking anyway`);
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
            const methods = ['click', 'enter', 'click'];
            for (let i = 0; i < methods.length; i++) {
                const last = i === methods.length - 1;
                const result = await this.pressGenerate(methods[i], { text, signal, timeout: Math.max(1000, deadline - Date.now()) });
                if (!result) continue;
                const { button = null, how } = typeof result === 'string' ? { how: result } : result;
                const windowMs = last ? Math.max(deadline - Date.now(), 3000) : Math.min(6000, Math.max(deadline - Date.now(), 3000));
                const started = await this.waitForGenerationStart(baseline, { kind, button, promptSet: Boolean(text), timeout: windowMs, signal }).catch((e) => {
                    if (e.code !== 'TIMEOUT') throw e;
                    return null;
                });
                if (started) {
                    this.debug(`Generation started (${started}) after ${how}`);
                    return started;
                }
                if (!last) this.log('warn', `Flow did not start generating after ${how}; trying again`);
            }
            throw new FlowError('Flow did not start generating: the Create button next to the prompt did not respond. Run Flow Diagnostics and check the "generateButton" selector.', {
                code: 'UI_NOT_FOUND'
            });
        }

        async ensureImageMode({ signal } = {}) {
            const trigger = dom.findFirst(this.sel('imageModeTrigger'));
            if (!trigger) {
                this.debug('Image-mode selector not found; assuming Flow is already in an image mode');
                return;
            }
            if (/image/i.test(dom.accessibleName(trigger))) return;
            dom.click(trigger);
            const option = await dom.waitForElement(this.sel('imageModeOption'), { timeout: 5000, signal }).catch(() => null);
            if (option) {
                this.debug(`Selecting image mode: ${dom.accessibleName(option)}`);
                dom.click(option);
                await dom.sleep(500, signal);
            } else {
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                this.log('warn', 'Could not switch Flow to image mode (selector "imageModeOption"); continuing in current mode');
            }
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
            const images = this.collectMedia('generatedImage');
            const videos = [...document.querySelectorAll('video')];
            return {
                imageEls: new WeakSet(images),
                imageKeys: new Set(images.map((el) => this.mediaKey(el)).filter(Boolean)),
                videoEls: new WeakSet(videos),
                videoKeys: new Set(videos.map((el) => this.mediaKey(el)).filter(Boolean)),
                errors: new Set(this.currentErrors()),
                progressCount: dom.findAll(this.sel('progressIndicator')).elements.length
            };
        }

        newImages(baseline) {
            return this.collectMedia('generatedImage').filter((el) => {
                const key = this.mediaKey(el);
                return key && !baseline.imageEls.has(el) && !baseline.imageKeys.has(key);
            });
        }

        newVideos(baseline) {
            return this.collectMedia('generatedVideo').filter((el) => {
                const key = this.mediaKey(el);
                return key && !baseline.videoEls.has(el) && !baseline.videoKeys.has(key);
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

        progressIn(root) {
            return dom.findAll(this.sel('progressIndicator'), { root }).elements.length;
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
                    if (dom.findAll(this.sel('progressIndicator')).elements.length > baseline.progressCount) return 'progress';
                    if (kind === 'image' && this.newImages(baseline).length) return 'result';
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
            return dom.waitForCondition(
                () => {
                    this.throwIfFlowError(baseline);
                    const progress = this.progressText();
                    if (progress && progress !== lastProgress) {
                        lastProgress = progress;
                        onProgress?.(`progress ${progress}`);
                    }
                    const items = pick();
                    if (!items.length) return false;
                    if (items.some((el) => this.progressIn(this.findCard(el)) > 0)) {
                        stableSince = 0;
                        return false;
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
        async generateImage(prompt, { timeoutMs = 300000, elementTimeoutMs = 30000, signal, onProgress } = {}) {
            await this.ensureImageMode({ signal });
            const baseline = this.snapshot();
            await this.setPrompt(prompt, { signal, timeout: elementTimeoutMs });
            onProgress?.('Prompt entered');
            await this.submit(baseline, { kind: 'image', text: prompt, signal, timeout: elementTimeoutMs });
            onProgress?.('Image generation started');

            const images = await this.waitForStableMedia(
                baseline,
                () => this.newImages(baseline).filter((img) => img.complete && img.naturalWidth > 0),
                {
                    timeout: timeoutMs,
                    signal,
                    onProgress: (p) => onProgress?.(`Generating image… ${p}`),
                    message: 'Image generation timed out (no new finished image appeared). Check that Flow is in an image mode — run Flow Diagnostics.'
                }
            );
            if (images.length > 1) this.log('info', `${images.length} new images appeared; using the first one`);
            const image = images[0];
            this.debug(`New image: ${dom.describeElement(image)} src=${this.mediaKey(image).slice(0, 80)}`);
            return { ref: this.register(image, 'image'), count: images.length };
        }

        async findAnimateControl(image, { signal }) {
            const card = this.findCard(image);
            image.scrollIntoView({ block: 'center' });
            dom.hover(card);
            dom.hover(image);
            await dom.sleep(400, signal);
            let control = dom.findFirst(this.sel('animateButton'), { root: card });
            if (control) return control;

            // Select the image (some layouts show actions only for the selected item).
            dom.click(image);
            await dom.sleep(700, signal);
            dom.hover(image);
            control = dom.findFirst(this.sel('animateButton'), { root: card }) || dom.findFirst(this.sel('animateButton'));
            if (control) return control;

            const more = dom.findFirst(this.sel('cardMoreButton'), { root: card });
            if (more) {
                dom.click(more);
                control = await dom.waitForElement(this.sel('animateMenuItem'), { timeout: 5000, signal }).catch(() => null);
            }
            // Controls revealed only by CSS :hover exist in the DOM but can't be made visible by
            // synthetic events; clicking them directly still runs their handler.
            return control || dom.findFirst(this.sel('animateButton'), { root: card, visibleOnly: false });
        }

        async animateImage(imageRef, { prompt = '', elementTimeoutMs = 30000, signal, onProgress } = {}) {
            const image = this.resolve(imageRef, 'image');
            const baseline = this.snapshot();
            const control = await this.findAnimateControl(image, { signal });
            if (!control) {
                throw new FlowError('Animate control not found for the generated image (selector "animateButton" may need updating)', { code: 'UI_NOT_FOUND' });
            }
            this.debug(`Clicking animate: ${dom.describeElement(control)}`);
            dom.click(control);
            onProgress?.('Animate clicked');

            const started = await this.waitForGenerationStart(baseline, { kind: 'video', timeout: 4000, signal }).catch((e) => {
                if (e.code !== 'TIMEOUT') throw e;
                return null;
            });
            if (!started) {
                // The image went into the composer as a start frame: submit it.
                const input = this.findPromptInput();
                if (input && (prompt || dom.readInputText(input))) await this.setPrompt(prompt, { signal, timeout: elementTimeoutMs });
                await this.submit(baseline, { kind: 'video', text: prompt, signal, timeout: elementTimeoutMs });
            }
            onProgress?.('Video generation started');
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
            return { clicked: true };
        }

        // ── diagnostics ──────────────────────────────────────────────────
        diagnose() {
            const page = this.detectPage();
            const auth = this.detectAuth();
            // Hover-only controls live on result cards: probe a few of the first/last image and
            // video cards (newest may be at either end). Hover only — diagnostics never click.
            const edge = (list) => [...list.slice(0, 3), ...list.slice(-3)];
            const cards = [...new Set([...edge(this.collectMedia('generatedVideo')), ...edge(this.collectMedia('generatedImage'))].map((m) => this.findCard(m)))];
            cards.forEach((c) => dom.hover(c));
            const items = ns.DIAGNOSTIC_KEYS.map(([key, label]) => {
                const media = key === 'generatedImage' || key === 'generatedVideo';
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
