/** Popup/options <-> background message types. */
export const MSG = Object.freeze({
    // popup -> background
    START_QUEUE: 'START_QUEUE',
    PAUSE_QUEUE: 'PAUSE_QUEUE',
    RESUME_QUEUE: 'RESUME_QUEUE',
    STOP_QUEUE: 'STOP_QUEUE',
    VALIDATE_PROMPTS: 'VALIDATE_PROMPTS',
    SAVE_PROMPTS: 'SAVE_PROMPTS',
    CLEAR_QUEUE: 'CLEAR_QUEUE',
    RETRY_FAILED: 'RETRY_FAILED',
    RETRY_JOB: 'RETRY_JOB',
    RUN_DIAGNOSTICS: 'RUN_DIAGNOSTICS',
    GET_FLOW_STATUS: 'GET_FLOW_STATUS',
    OPEN_FLOW: 'OPEN_FLOW',
    GET_STATE: 'GET_STATE',
    GET_LOGS: 'GET_LOGS',
    CLEAR_LOGS: 'CLEAR_LOGS',

    // background -> popup (broadcast)
    QUEUE_UPDATE: 'QUEUE_UPDATE',
    JOB_STARTED: 'JOB_STARTED',
    JOB_PROGRESS: 'JOB_PROGRESS',
    JOB_COMPLETED: 'JOB_COMPLETED',
    JOB_FAILED: 'JOB_FAILED',
    DOWNLOAD_STARTED: 'DOWNLOAD_STARTED',
    DOWNLOAD_COMPLETED: 'DOWNLOAD_COMPLETED',
    AUTOMATION_ERROR: 'AUTOMATION_ERROR',
    LOG_ENTRY: 'LOG_ENTRY'
});

/**
 * Background <-> content-script port protocol (port name below).
 * Duplicated as plain strings in src/content/content.js because classic content scripts
 * cannot import ES modules — keep both in sync.
 */
export const PORT_NAME = 'gfa-flow';

export const PORT_MSG = Object.freeze({
    HELLO: 'HELLO', // cs -> bg on connect
    COMMAND: 'COMMAND', // bg -> cs
    RESULT: 'RESULT', // cs -> bg
    HEARTBEAT: 'HEARTBEAT', // cs -> bg while a command runs (keeps the MV3 worker alive)
    PROGRESS: 'PROGRESS', // cs -> bg
    LOG: 'LOG', // cs -> bg
    TRUSTED_INPUT: 'TRUSTED_INPUT', // cs -> bg: perform a real click / typing via chrome.debugger
    TRUSTED_RESULT: 'TRUSTED_RESULT' // bg -> cs
});

export const COMMANDS = Object.freeze({
    PING: 'PING',
    CHECK_READY: 'CHECK_READY',
    GET_STATUS: 'GET_STATUS',
    DIAGNOSE: 'DIAGNOSE',
    SUBMIT_PROMPT: 'SUBMIT_PROMPT',
    WAIT_FOR_VIDEO: 'WAIT_FOR_VIDEO',
    GET_VIDEO_INFO: 'GET_VIDEO_INFO',
    TRIGGER_NATIVE_DOWNLOAD: 'TRIGGER_NATIVE_DOWNLOAD',
    ABORT: 'ABORT'
});
