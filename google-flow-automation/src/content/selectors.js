/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GOOGLE FLOW SELECTORS  —  the ONLY place Flow's DOM structure is described.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * HONESTY NOTE
 *   Entries marked `verified: true` were checked against the live site (2026-09-28,
 *   signed-out pages only). Everything else is an UNVERIFIED best guess: the Flow
 *   workspace (prompt box, video cards, download controls) sits behind
 *   Google sign-in, which this extension's author could not automate or inspect.
 *   Run "Flow Diagnostics" in the popup while signed in to see which ones match, then
 *   fix the misses either here or — without touching code — in
 *   Options → "Selector overrides (JSON)".
 *
 * STRATEGY FORMAT (tried in order; the first strategy that matches wins)
 *   { css: 'selector' }                      CSS selector
 *   { aria: 'regex' }                        aria-label matches (case-insensitive)
 *   { role: 'button', name: 'regex' }        [role] or implicit role + accessible name
 *   { placeholder: 'regex' }                 placeholder / aria-placeholder
 *   { text: 'regex', tag: 'button,a' }       visible text of given tags (Flow uses Material
 *                                            Symbols, so icon names like "download" are text)
 *   { xpath: '//...' }                       last resort only
 *   Optional on any strategy: verified, note.
 * All regexes are plain strings (JSON-safe) compiled with the "i" flag. Nothing is eval'd.
 */
(function () {
    const FLOW_SELECTORS = {
        // ── page / auth ─────────────────────────────────────────────────────
        signInIndicator: [
            { css: 'a[aria-label="Sign in"]', verified: true, note: 'Signed-out header link on flow.google.com' },
            { css: 'a[href*="accounts.google.com/ServiceLogin"]', verified: true }
        ],
        accountIndicator: [
            { css: 'a[href*="accounts.google.com/SignOutOptions"]', note: 'Standard Google account menu link' },
            { aria: '^Google Account' },
            { css: 'img[alt*="profile" i]' }
        ],

        // ── prompt + generate ────────────────────────────────────────────────
        promptInput: [
            { css: '#PINHOLE_TEXT_AREA_ELEMENT_ID', note: 'id seen in older Flow builds' },
            { placeholder: 'prompt|describe|create|generate|what do you want|imagine' },
            { css: 'textarea' },
            { css: '[contenteditable="true"][role="textbox"]' },
            { css: '[contenteditable="true"]' }
        ],
        // Searched outward from the prompt box only (see FlowAdapter.findGenerateButton): the
        // page has other "Create…" buttons, and a page-wide first match clicked the wrong one.
        // If none of these match, the right-pointing arrow icon beside the prompt is found by shape.
        generateButton: [
            { text: '^\\s*(arrow_forward|arrow_right_alt|arrow_upward|send|north_east)', tag: 'button,[role="button"]', note: 'Composer submit: arrow icon (Material Symbols ligature)' },
            { aria: '^\\s*(create|generate|send|submit|run)\\b' },
            { text: '^\\s*(create|generate|send|submit)\\s*$', tag: 'button,[role="button"]' },
            { css: 'button[type="submit"]' }
        ],

        // ── progress / errors ────────────────────────────────────────────────
        progressIndicator: [
            { role: 'progressbar' },
            { css: '[aria-busy="true"]' },
            { text: '^\\s*\\d{1,3}\\s*%\\s*$', tag: 'div,span,p' }
        ],
        errorMessage: [
            { role: 'alert' },
            { css: '[aria-live="assertive"]' },
            { css: '[aria-live="polite"]' }
        ],

        // ── results ─────────────────────────────────────────────────────────
        generatedVideo: [{ css: 'video' }],
        // Flow's chat view can collapse finished clips behind "Show 10 Videos" (inline toggle).
        showVideosButton: [{ text: '^\\s*show\\s+(all\\s+)?\\d*\\s*videos?\\s*$', tag: 'button,[role="button"]' }],
        // Closes a result viewer/dialog (searched inside the open dialog only).
        closeButton: [
            { aria: '^\\s*(close|back|done|exit)\\b' },
            { text: '^\\s*(close|arrow_back)\\s*$', tag: 'button,[role="button"]' }
        ],
        resultCard: [
            { css: '[data-index]' },
            { css: '[role="listitem"]' },
            { css: '[role="gridcell"]' }
        ],

        cardMoreButton: [
            { aria: '^(more|more options|more actions)' },
            { text: '^\\s*more_(vert|horiz)\\s*$', tag: 'button' }
        ],
        downloadButton: [
            { aria: '^\\s*download' },
            { text: '^\\s*download\\s*$', tag: 'button,[role="button"]' }
        ],
        downloadMenuOption: [
            { role: 'menuitem', name: 'original|720p|mp4|download video' },
            { role: 'menuitem', name: 'download' }
        ]
    };

    /** Visible text that, when it appears after we start, means Flow reported a failure. */
    const ERROR_TEXT_PATTERN =
        "(failed|couldn.?t (generate|create)|could not (generate|create)|unable to (generate|create)|something went wrong|violat|policy|not allowed|try again later|quota|limit reached|out of credits|insufficient credits)";

    /** Ignore thumbnails/icons/avatars smaller than this (px). */
    const MIN_MEDIA_SIZE = 96;

    /** Keys shown by Flow Diagnostics, in order, with the label used in the report. */
    const DIAGNOSTIC_KEYS = [
        ['promptInput', 'Prompt input'],
        ['generateButton', 'Generate control'],
        ['generatedVideo', 'Generated video'],
        ['downloadButton', 'Download control'],
        ['progressIndicator', 'Progress indicator (only during generation)'],
        ['cardMoreButton', 'Card "more" menu (optional)']
    ];

    const ns = (globalThis.__GFA__ = globalThis.__GFA__ || {});
    ns.FLOW_SELECTORS = FLOW_SELECTORS;
    ns.ERROR_TEXT_PATTERN = ERROR_TEXT_PATTERN;
    ns.MIN_MEDIA_SIZE = MIN_MEDIA_SIZE;
    ns.DIAGNOSTIC_KEYS = DIAGNOSTIC_KEYS;

    /** Merge user overrides ({ key: [strategies] }) over the defaults. Unknown keys are allowed. */
    ns.buildSelectors = function buildSelectors(overridesJson) {
        const merged = { ...FLOW_SELECTORS };
        if (!overridesJson || !String(overridesJson).trim()) return { selectors: merged, error: null };
        try {
            const overrides = JSON.parse(overridesJson);
            if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Top level must be an object');
            for (const [key, value] of Object.entries(overrides)) {
                if (!Array.isArray(value)) throw new Error(`"${key}" must be an array of strategies`);
                merged[key] = value;
            }
            return { selectors: merged, error: null };
        } catch (error) {
            return { selectors: merged, error: `Selector overrides ignored: ${error.message}` };
        }
    };
})();
