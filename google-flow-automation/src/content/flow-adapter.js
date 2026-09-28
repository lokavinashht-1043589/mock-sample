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

        async checkReady({ prepare = false, signal, elementTimeoutMs = 30000 } = {}) {
            const page = this.detectPage();
            let auth = this.detectAuth();
            if (auth === false) return { ...page, ready: false, authenticated: false, reason: 'Sign-in required' };
            if (this.findPromptInput()) return { ...page, ready: true, authenticated: true };
            if (!prepare) return { ...page, ready: false, authenticated: auth, reason: 'Flow prompt input not found' };

            // Not in a project yet: use Flow's own "New project" / "Create with Google Flow" entry.
            const entry = dom.findFirst(this.sel('newProjectButton')) || dom.findFirst(this.sel('enterWorkspaceButton'));
            if (entry) {
                this.debug(`Opening Flow workspace via ${dom.describeElement(entry)}`);
                dom.click(entry);
                await dom
                    .waitForCondition(() => this.findPromptInput() || dom.findFirst(this.sel('signInIndicator')), { timeout: elementTimeoutMs, signal })
                    .catch((e) => {
                        if (e.code === 'ABORTED') throw e;
                    });
            }
            auth = this.detectAuth();
            if (auth === false) return { ...page, ready: false, authenticated: false, reason: 'Sign-in required' };
            if (this.findPromptInput()) return { ...page, ready: true, authenticated: true };
            return {
                ...page,
                ready: false,
                authenticated: auth,
                reason: 'Flow prompt input not found. Open a Flow project, or update the "promptInput" selector (run Flow Diagnostics).'
            };
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

        async clickGenerate({ signal, timeout = 30000 } = {}) {
            const button = await dom
                .waitForElement(this.sel('generateButton'), { timeout: Math.min(timeout, 10000), signal, filter: dom.isEnabled })
                .catch((e) => {
                    if (e.code === 'ABORTED') throw e;
                    return null;
                });
            if (button) {
                this.debug(`Clicking generate: ${dom.describeElement(button)}`);
                dom.click(button);
                return;
            }
            // Fallback: Enter in the prompt box (the normal keyboard submit).
            const input = this.findPromptInput();
            if (!input) throw new FlowError('Generate control not found (selector "generateButton")', { code: 'UI_NOT_FOUND' });
            this.debug('Generate button not found — submitting with Enter');
            input.focus();
            for (const type of ['keydown', 'keypress', 'keyup']) {
                input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }
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
                progressCount: dom.findAll(this.sel('progressIndicator')).elements.length,
                generateEnabled: dom.isEnabled(dom.findFirst(this.sel('generateButton')))
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

        waitForGenerationStart(baseline, { kind, timeout = 30000, signal } = {}) {
            return dom.waitForCondition(
                () => {
                    this.throwIfFlowError(baseline);
                    if (dom.findAll(this.sel('progressIndicator')).elements.length > baseline.progressCount) return 'progress';
                    if (kind === 'image' && this.newImages(baseline).length) return 'result';
                    if (kind === 'video' && this.newVideos(baseline).length) return 'result';
                    const btn = dom.findFirst(this.sel('generateButton'));
                    if (baseline.generateEnabled && btn && !dom.isEnabled(btn)) return 'generate-disabled';
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
            await this.clickGenerate({ signal, timeout: elementTimeoutMs });
            await this.waitForGenerationStart(baseline, { kind: 'image', timeout: elementTimeoutMs, signal });
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

            let started = await this.waitForGenerationStart(baseline, { kind: 'video', timeout: 4000, signal }).catch((e) => {
                if (e.code !== 'TIMEOUT') throw e;
                return null;
            });
            if (!started) {
                // The image went into the composer as a start frame: submit it.
                const input = this.findPromptInput();
                if (input && (prompt || dom.readInputText(input))) await this.setPrompt(prompt, { signal, timeout: elementTimeoutMs });
                await this.clickGenerate({ signal, timeout: elementTimeoutMs });
                started = await this.waitForGenerationStart(baseline, { kind: 'video', timeout: elementTimeoutMs, signal });
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
            return {
                ...page,
                authenticated: auth,
                signInVisible: Boolean(dom.findFirst(this.sel('signInIndicator'))),
                items,
                errorsOnPage: this.currentErrors()
            };
        }
    }

    ns.FlowAdapter = FlowAdapter;
    ns.FlowError = FlowError;
})();
