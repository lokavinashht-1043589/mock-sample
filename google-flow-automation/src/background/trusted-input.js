/**
 * Real ("trusted") mouse and keyboard input for the Flow tab via the Chrome DevTools Protocol.
 *
 * Script-created events carry isTrusted=false, and some Flow controls (the arrow submit button)
 * ignore them. chrome.debugger delivers input exactly as a real user would. While attached,
 * Chrome shows its "…started debugging this browser" bar; we detach when the run ends.
 */
const PROTOCOL = '1.3';

export class TrustedInput {
    constructor({ logger }) {
        this.logger = logger;
        this.attached = new Set();
        chrome.debugger.onDetach.addListener((source) => this.attached.delete(source.tabId));
    }

    async ensureAttached(tabId) {
        if (this.attached.has(tabId)) return;
        try {
            await chrome.debugger.attach({ tabId }, PROTOCOL);
        } catch (error) {
            if (!/already attached/i.test(error.message)) {
                throw new Error(`Could not send a real click to the Flow tab (${error.message}). Close DevTools on that tab and try again.`);
            }
        }
        this.attached.add(tabId);
        this.logger.debug(`Attached real-input driver to tab ${tabId}`);
    }

    send(tabId, method, params) {
        return chrome.debugger.sendCommand({ tabId }, method, params);
    }

    /** Left click at viewport CSS-pixel coordinates. */
    async click(tabId, { x, y }) {
        await this.ensureAttached(tabId);
        const base = { x, y, button: 'left', pointerType: 'mouse' };
        await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1, clickCount: 1 });
        await this.send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0, clickCount: 1 });
    }

    /** Types text into the focused element, replacing its current selection. */
    async insertText(tabId, { text }) {
        await this.ensureAttached(tabId);
        await this.send(tabId, 'Input.insertText', { text });
    }

    async pressEnter(tabId) {
        await this.ensureAttached(tabId);
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await this.send(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyDown', text: '\r' });
        await this.send(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
    }

    async run(tabId, action, args = {}) {
        switch (action) {
            case 'click':
                return this.click(tabId, args);
            case 'insertText':
                return this.insertText(tabId, args);
            case 'pressEnter':
                return this.pressEnter(tabId);
            default:
                throw new Error(`Unknown real-input action: ${action}`);
        }
    }

    async detachAll() {
        for (const tabId of [...this.attached]) {
            await chrome.debugger.detach({ tabId }).catch(() => {});
            this.attached.delete(tabId);
        }
    }
}
