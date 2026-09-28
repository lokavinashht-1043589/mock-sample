/**
 * Output filename helpers. Pure functions — no Chrome APIs — so they are unit-testable.
 */

export const KNOWN_VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', 'gif'];

const MIME_TO_EXTENSION = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-m4v': 'm4v',
    'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi',
    'image/gif': 'gif'
};

export const DEFAULT_EXTENSION = 'mp4';

// Characters Windows/macOS/Linux reject in filenames, plus control chars.
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;

export function sanitizeFilenamePart(value) {
    return String(value ?? '').replace(ILLEGAL_FILENAME_CHARS, '').replace(/^\.+/, '').trim();
}

/** Subfolder inside Downloads, e.g. "flow/batch 1". Rejects ".." and absolute paths. */
export function sanitizeSubfolder(value) {
    return String(value ?? '')
        .split(/[\\/]+/)
        .map((part) => sanitizeFilenamePart(part))
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/');
}

export function normalizeExtension(extension) {
    const ext = String(extension ?? '').trim().replace(/^\.+/, '').toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : DEFAULT_EXTENSION;
}

/**
 * getOutputFilename({ number: 10 }, "mp4") -> "10.mp4"
 * getOutputFilename({ number: 10 }, "webm", { prefix: "flow_" }) -> "flow_10.webm"
 *
 * Uses job.label (the digits exactly as the user typed them, e.g. "007") when present,
 * otherwise job.number.
 */
export function getOutputFilename(job, extension, options = {}) {
    const prefix = sanitizeFilenamePart(options.prefix ?? '');
    const id = job.label ?? String(job.number);
    const suffix = options.suffix ? `_${options.suffix}` : '';
    return `${prefix}${id}${suffix}.${normalizeExtension(extension)}`;
}

/** Prepend an optional Downloads subfolder: ("flow", "1.mp4") -> "flow/1.mp4". */
export function withSubfolder(filename, subfolder) {
    const folder = sanitizeSubfolder(subfolder);
    return folder ? `${folder}/${filename}` : filename;
}

function extensionFromPath(value) {
    if (!value) return null;
    let path = String(value);
    try {
        path = new URL(path).pathname;
    } catch {
        // Not a URL — treat as a plain path.
    }
    const match = /\.([a-z0-9]{2,5})$/i.exec(path.split(/[\\/]/).pop() || '');
    if (!match) return null;
    const ext = match[1].toLowerCase();
    return KNOWN_VIDEO_EXTENSIONS.includes(ext) ? ext : null;
}

export function extensionFromMime(mime) {
    if (!mime) return null;
    return MIME_TO_EXTENSION[String(mime).split(';')[0].trim().toLowerCase()] ?? null;
}

/**
 * Work out the real extension of a download. Order of trust:
 *   1. the filename Chrome/the server proposed
 *   2. the MIME type Chrome reports
 *   3. the URL path
 *   4. a hint from the page (e.g. <source type>)
 *   5. "mp4"
 */
export function detectVideoExtension({ filename, mime, url, hint } = {}) {
    return (
        extensionFromPath(filename) ||
        extensionFromMime(mime) ||
        extensionFromPath(url) ||
        extensionFromMime(hint) ||
        (hint && KNOWN_VIDEO_EXTENSIONS.includes(normalizeExtension(hint)) ? normalizeExtension(hint) : null) ||
        DEFAULT_EXTENSION
    );
}

export const DUPLICATE_BEHAVIOR = Object.freeze({
    PREVENT: 'prevent',
    SUFFIX: 'suffix',
    OVERWRITE: 'overwrite'
});

export class OutputExistsError extends Error {
    constructor(filename) {
        super(`Output file already exists: ${filename}. Change "Duplicate file behavior" in settings or move the existing file.`);
        this.name = 'OutputExistsError';
        this.code = 'OUTPUT_EXISTS';
        this.retryable = false;
    }
}

/**
 * Decide the final relative filename given the duplicate behavior.
 * @param {object} job
 * @param {string} extension
 * @param {{prefix?:string, subfolder?:string, behavior?:string, exists:(relPath:string)=>Promise<boolean>|boolean, maxSuffix?:number}} options
 * @returns {Promise<{filename:string, conflictAction:'uniquify'|'overwrite'}>}
 */
export async function resolveOutputFilename(job, extension, options) {
    const { prefix = '', subfolder = '', behavior = DUPLICATE_BEHAVIOR.PREVENT, exists, maxSuffix = 999 } = options;
    const base = withSubfolder(getOutputFilename(job, extension, { prefix }), subfolder);

    if (behavior === DUPLICATE_BEHAVIOR.OVERWRITE) {
        return { filename: base, conflictAction: 'overwrite' };
    }

    if (!(await exists(base))) {
        // 'uniquify' is a filesystem safety net: if a file Chrome doesn't know about is
        // already there, Chrome renames ours instead of overwriting it.
        return { filename: base, conflictAction: 'uniquify' };
    }

    if (behavior === DUPLICATE_BEHAVIOR.SUFFIX) {
        for (let n = 1; n <= maxSuffix; n++) {
            const candidate = withSubfolder(getOutputFilename(job, extension, { prefix, suffix: n }), subfolder);
            if (!(await exists(candidate))) return { filename: candidate, conflictAction: 'uniquify' };
        }
    }

    throw new OutputExistsError(base);
}
