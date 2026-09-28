/**
 * Content-script entry point. Connects to the background service worker over a long-lived
 * port and executes adapter commands. Reconnects automatically after the worker restarts.
 *
 * Protocol constants mirror src/utils/messages.js (classic scripts can't import modules).
 */
(function () {
    if (globalThis.__GFA_CONTENT_LOADED__) return;
    globalThis.__GFA_CONTENT_LOADED__ = true;

    const PORT_NAME = 'gfa-flow';
    const SETTINGS_KEY = 'gfa.settings';
    const HEARTBEAT_MS = 15000;

    const ns = globalThis.__GFA__;
    let port = null;
    let debugMode = false;
    let selectorError = null;
    const controllers = new Set();

    const send = (message) => {
        try {
            port?.postMessage(message);
        } catch {
            // port closed; reconnect logic handles it
        }
    };

    const log = (level, message) => {
        if (level === 'debug' && !debugMode) return;
        send({ type: 'LOG', level, message: String(message) });
    };
    ns.debugLog = (message) => log('debug', message);

    const adapter = new ns.FlowAdapter({ selectors: ns.FLOW_SELECTORS, log });

    function applySettings(settings) {
        debugMode = Boolean(settings?.debugMode);
        const { selectors, error } = ns.buildSelectors(settings?.selectorOverrides);
        selectorError = error;
        adapter.setSelectors(selectors);
        if (error) log('warn', error);
    }

    function contextAlive() {
        try {
            return Boolean(chrome.runtime?.id);
        } catch {
            return false;
        }
    }

    function abortAll(reason) {
        for (const controller of controllers) controller.abort(Object.assign(new Error(reason), { code: 'ABORTED' }));
        controllers.clear();
    }

    function connect() {
        if (!contextAlive()) return;
        try {
            port = chrome.runtime.connect({ name: PORT_NAME });
        } catch {
            port = null;
            return; // extension was reloaded/removed: this old content script is orphaned
        }
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(() => {
            void chrome.runtime.lastError;
            port = null;
            // Never keep clicking in the page if nobody is listening for the result.
            abortAll('Connection to the extension was lost');
            if (contextAlive()) setTimeout(connect, 1000);
        });
        send({ type: 'HELLO', url: location.href, hasPrompt: Boolean(adapter.findPromptInput()) });
    }

    async function dispatch(command, args, context) {
        const opts = { ...(args || {}), ...context };
        switch (command) {
            case 'PING':
                return { pong: true, url: location.href };
            case 'CHECK_READY':
                return adapter.checkReady();
            case 'GET_STATUS':
                return adapter.getStatus();
            case 'DIAGNOSE':
                return { ...adapter.diagnose(), selectorError };
            case 'GENERATE_IMAGE':
                return adapter.generateImage(args.prompt, opts);
            case 'ANIMATE_IMAGE':
                return adapter.animateImage(args.image, opts);
            case 'WAIT_FOR_VIDEO':
                return adapter.waitForVideo(args.video, opts);
            case 'GET_VIDEO_INFO':
                return adapter.getVideoInfo(args.video);
            case 'TRIGGER_NATIVE_DOWNLOAD':
                return adapter.triggerNativeDownload(args.video, opts);
            default:
                throw new Error(`Unknown command: ${command}`);
        }
    }

    async function onMessage(message) {
        if (!message || message.type !== 'COMMAND') return;
        const { id, command, args } = message;

        if (command === 'ABORT') {
            abortAll('Aborted by the extension');
            send({ type: 'RESULT', id, ok: true, result: { aborted: true } });
            return;
        }

        const controller = new AbortController();
        controllers.add(controller);
        const heartbeat = setInterval(() => send({ type: 'HEARTBEAT', id }), HEARTBEAT_MS);
        const onProgress = (detail) => send({ type: 'PROGRESS', id, detail });
        try {
            log('debug', `Command ${command}`);
            const result = await dispatch(command, args, { signal: controller.signal, onProgress });
            send({ type: 'RESULT', id, ok: true, result });
        } catch (error) {
            log('debug', `Command ${command} failed: ${error?.message}`);
            send({
                type: 'RESULT',
                id,
                ok: false,
                error: { message: error?.message || String(error), code: error?.code || null, retryable: error?.retryable !== false }
            });
        } finally {
            clearInterval(heartbeat);
            controllers.delete(controller);
        }
    }

    chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
        applySettings(stored[SETTINGS_KEY]);
        connect();
    }, connect);

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SETTINGS_KEY]) applySettings(changes[SETTINGS_KEY].newValue);
    });
})();
