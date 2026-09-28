/**
 * Generic DOM helpers. Nothing here knows about Google Flow — selectors are passed in.
 */
(function () {
    const ns = (globalThis.__GFA__ = globalThis.__GFA__ || {});

    class DomTimeoutError extends Error {
        constructor(message) {
            super(message);
            this.name = 'TimeoutError';
            this.code = 'TIMEOUT';
        }
    }

    class DomAbortError extends Error {
        constructor(message = 'Aborted') {
            super(message);
            this.name = 'AbortedError';
            this.code = 'ABORTED';
        }
    }

    const regexCache = new Map();
    function rx(source) {
        if (source instanceof RegExp) return source;
        if (!regexCache.has(source)) {
            try {
                regexCache.set(source, new RegExp(source, 'i'));
            } catch {
                regexCache.set(source, /$^/); // invalid user regex never matches
            }
        }
        return regexCache.get(source);
    }

    const normalizeText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        if (el.getClientRects().length === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function isEnabled(el) {
        return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    }

    const IMPLICIT_ROLES = {
        button: 'button,[role="button"]',
        textbox: 'textarea,input[type="text"],input:not([type]),[contenteditable="true"],[role="textbox"]',
        combobox: 'select,[role="combobox"],[aria-haspopup="listbox"]',
        option: 'option,[role="option"]',
        menuitem: '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]',
        progressbar: 'progress,[role="progressbar"]',
        alert: '[role="alert"]',
        listitem: 'li,[role="listitem"]'
    };

    function accessibleName(el) {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
            const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
            if (normalizeText(text)) return normalizeText(text);
        }
        return normalizeText(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '');
    }

    function describeStrategy(s) {
        return JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'note' && k !== 'verified')));
    }

    /** Elements matching ONE strategy inside root. */
    function queryStrategy(strategy, root = document) {
        let found = [];
        try {
            if (strategy.css) {
                found = [...root.querySelectorAll(strategy.css)];
            } else if (strategy.aria) {
                const re = rx(strategy.aria);
                found = [...root.querySelectorAll('[aria-label]')].filter((el) => re.test(el.getAttribute('aria-label')));
            } else if (strategy.role) {
                const sel = IMPLICIT_ROLES[strategy.role] || `[role="${strategy.role}"]`;
                const re = strategy.name ? rx(strategy.name) : null;
                found = [...root.querySelectorAll(sel)].filter((el) => !re || re.test(accessibleName(el)));
            } else if (strategy.placeholder) {
                const re = rx(strategy.placeholder);
                found = [...root.querySelectorAll('[placeholder],[aria-placeholder],[data-placeholder]')].filter((el) =>
                    re.test(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || '')
                );
            } else if (strategy.text) {
                const re = rx(strategy.text);
                found = [...root.querySelectorAll(strategy.tag || 'button')].filter((el) => re.test(normalizeText(el.innerText || el.textContent)));
            } else if (strategy.xpath) {
                const doc = root.ownerDocument || root;
                const snap = doc.evaluate(strategy.xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < snap.snapshotLength; i++) found.push(snap.snapshotItem(i));
            }
        } catch (error) {
            ns.debugLog?.(`Selector error ${describeStrategy(strategy)}: ${error.message}`);
            return [];
        }
        return found;
    }

    /**
     * All elements for the FIRST strategy that yields visible matches.
     * @returns {{elements: Element[], strategy: object|null}}
     */
    function findAll(strategies, { root = document, visibleOnly = true, filter = null } = {}) {
        for (const strategy of strategies || []) {
            let elements = queryStrategy(strategy, root);
            if (visibleOnly) elements = elements.filter(isVisible);
            if (filter) elements = elements.filter(filter);
            if (elements.length) return { elements, strategy };
        }
        return { elements: [], strategy: null };
    }

    function findFirst(strategies, options) {
        return findAll(strategies, options).elements[0] || null;
    }

    /** Re-evaluate `fn` on DOM mutations and on an interval until truthy. */
    function waitForCondition(fn, { timeout = 30000, interval = 500, signal, message, root = document.documentElement } = {}) {
        return new Promise((resolve, reject) => {
            let done = false;
            let scheduled = false;
            const finish = (err, value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                clearInterval(ticker);
                observer.disconnect();
                signal?.removeEventListener('abort', onAbort);
                err ? reject(err) : resolve(value);
            };
            const evaluate = () => {
                scheduled = false;
                if (done) return;
                try {
                    const value = fn();
                    if (value) finish(null, value);
                } catch (error) {
                    finish(error);
                }
            };
            const observer = new MutationObserver(() => {
                if (!scheduled) {
                    scheduled = true;
                    setTimeout(evaluate, 100); // throttle bursts of mutations
                }
            });
            const onAbort = () => finish(signal.reason?.code ? signal.reason : new DomAbortError());
            const timer = setTimeout(() => finish(new DomTimeoutError(message || `Condition not met within ${Math.round(timeout / 1000)}s`)), timeout);
            const ticker = setInterval(evaluate, interval);
            observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) return onAbort();
            evaluate();
        });
    }

    function waitForElement(strategies, { timeout = 30000, root = document, signal, filter, message } = {}) {
        return waitForCondition(() => findFirst(strategies, { root, filter }), {
            timeout,
            signal,
            message: message || `Element not found within ${Math.round(timeout / 1000)}s`
        });
    }

    function waitForElementToDisappear(strategies, { timeout = 30000, root = document, signal, message } = {}) {
        return waitForCondition(() => !findFirst(strategies, { root }), {
            timeout,
            signal,
            message: message || `Element still present after ${Math.round(timeout / 1000)}s`
        });
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            signal?.addEventListener(
                'abort',
                () => {
                    clearTimeout(t);
                    reject(new DomAbortError());
                },
                { once: true }
            );
        });
    }

    // ── input ────────────────────────────────────────────────────────────

    function readInputText(el) {
        if (!el) return '';
        if ('value' in el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return el.value;
        return el.innerText ?? el.textContent ?? '';
    }

    /** React/Angular-safe value set for <textarea>/<input>: use the prototype setter, then fire input. */
    function setNativeValue(el, value) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(el, value) : (el.value = value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Focus, select all, clear, insert text, fire events. Text is inserted as plain text only
     * (never as HTML) so a prompt can never inject markup or script.
     */
    function replaceText(el, text) {
        el.focus();
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            el.select?.();
            setNativeValue(el, '');
            setNativeValue(el, text);
            return;
        }
        // contenteditable (rich editors listen for beforeinput/input)
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        // execCommand is deprecated but is still the only way to go through the editor's own
        // input pipeline (undo stack, framework state) for contenteditable.
        const deleted = document.execCommand('delete', false);
        const inserted = text ? document.execCommand('insertText', false, text) : true;
        if (!deleted || !inserted || normalizeText(readInputText(el)) !== normalizeText(text)) {
            el.textContent = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
    }

    // ── pointer ──────────────────────────────────────────────────────────

    /**
     * Plain-text paste into a rich (contenteditable) editor. Editors like Slate/Lexical keep their
     * own model and may ignore execCommand/textContent changes, but they all handle paste.
     */
    function pasteText(el, text) {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
        const data = new DataTransfer();
        data.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }

    function pressKey(el, key, code = key) {
        const keyCode = { Enter: 13, ' ': 32, End: 35 }[key] || 0;
        for (const type of ['keydown', 'keypress', 'keyup']) {
            el.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
        }
    }

    function pointerInit(el) {
        const r = el.getBoundingClientRect();
        return {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            view: window,
            button: 0,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
        };
    }

    function hover(el) {
        if (!el) return;
        const init = pointerInit(el);
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
            const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Ctor(type, init));
        }
    }

    function click(el) {
        if (!el) throw new Error('Cannot click: element missing');
        el.scrollIntoView({ block: 'center', inline: 'center' });
        hover(el);
        const init = pointerInit(el);
        el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
        el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
        el.focus?.({ preventScroll: true });
        el.dispatchEvent(new PointerEvent('pointerup', init));
        el.dispatchEvent(new MouseEvent('mouseup', init));
        el.click();
    }

    /** Short path like "main > div.card > button[aria-label=Download]" for debug logs. */
    function describeElement(el) {
        if (!el) return '(none)';
        const parts = [];
        let node = el;
        for (let i = 0; node && node.nodeType === 1 && i < 4; i++, node = node.parentElement) {
            let part = node.tagName.toLowerCase();
            if (node.id) part += `#${node.id}`;
            const label = node.getAttribute('aria-label');
            if (label) part += `[aria-label="${label.slice(0, 30)}"]`;
            parts.unshift(part);
        }
        return parts.join(' > ');
    }

    ns.dom = {
        DomTimeoutError,
        DomAbortError,
        rx,
        normalizeText,
        isVisible,
        isEnabled,
        accessibleName,
        describeStrategy,
        queryStrategy,
        findAll,
        findFirst,
        waitForCondition,
        waitForElement,
        waitForElementToDisappear,
        sleep,
        readInputText,
        setNativeValue,
        replaceText,
        pasteText,
        pressKey,
        hover,
        click,
        describeElement
    };
})();
