/**
 * Numbered prompt parser.
 *
 * Input format (one job per line):
 *   <number>] <prompt>
 *
 * The prompt text is passed through untouched except for:
 *   - the numeric prefix "<number>]" and the whitespace right after it
 *   - trailing whitespace / carriage returns (invisible, never meaningful)
 * Nothing else is rewritten, translated, or re-punctuated.
 */

export const PROMPT_LINE_PATTERN = /^\s*(\d+)\]\s*(.*)$/;

export const EXPECTED_FORMAT = '<number>] <prompt>';

/**
 * @param {string} text
 * @returns {{ prompts: Array<{number:number,label:string,prompt:string,line:number}>,
 *             errors: Array<{line:number,type:string,number?:number,message:string}>,
 *             isValid: boolean }}
 */
export function parsePrompts(text) {
    const prompts = [];
    const errors = [];
    const seen = new Map(); // number -> first line

    const lines = String(text ?? '').split(/\r\n|\r|\n/);

    lines.forEach((rawLine, index) => {
        const lineNo = index + 1;
        if (rawLine.trim() === '') return;

        const match = PROMPT_LINE_PATTERN.exec(rawLine);
        if (!match) {
            errors.push({
                line: lineNo,
                type: 'invalid',
                message: `Invalid prompt on line ${lineNo}.\n\nExpected format:\n\n${EXPECTED_FORMAT}`
            });
            return;
        }

        const label = match[1];
        const number = Number.parseInt(label, 10);
        const prompt = match[2].replace(/\s+$/, '');

        if (prompt === '') {
            errors.push({
                line: lineNo,
                type: 'empty',
                number,
                message: `Empty prompt on line ${lineNo} (number ${label}).\n\nExpected format:\n\n${EXPECTED_FORMAT}`
            });
            return;
        }

        if (seen.has(number)) {
            errors.push({
                line: lineNo,
                type: 'duplicate',
                number,
                message: `Duplicate prompt number: ${number}\n\nPlease use unique numbers.`
            });
            return;
        }

        seen.set(number, lineNo);
        prompts.push({ number, label, prompt, line: lineNo });
    });

    return { prompts, errors, isValid: errors.length === 0 && prompts.length > 0 };
}

/** Short human summary used by the popup ("✓ 25 valid prompts" / "✗ 2 errors found"). */
export function summarizeParse(result) {
    if (result.errors.length > 0) {
        const n = result.errors.length;
        return `✗ ${n} error${n === 1 ? '' : 's'} found`;
    }
    if (result.prompts.length === 0) return '✗ No prompts found';
    const n = result.prompts.length;
    return `✓ ${n} valid prompt${n === 1 ? '' : 's'}`;
}
