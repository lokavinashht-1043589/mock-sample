import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrompts, summarizeParse } from '../src/utils/prompt-parser.js';

const simplify = (result) => result.prompts.map(({ number, prompt }) => ({ number, prompt }));

test('parses basic numbered prompts including multi-digit numbers', () => {
    const result = parsePrompts('1] First prompt\n2] Second prompt\n10] Tenth prompt');
    assert.equal(result.isValid, true);
    assert.deepEqual(simplify(result), [
        { number: 1, prompt: 'First prompt' },
        { number: 2, prompt: 'Second prompt' },
        { number: 10, prompt: 'Tenth prompt' }
    ]);
});

test('accepts no space and extra spaces after the bracket', () => {
    const result = parsePrompts('1]prompt\n2]   prompt\n3]prompt');
    assert.deepEqual(simplify(result), [
        { number: 1, prompt: 'prompt' },
        { number: 2, prompt: 'prompt' },
        { number: 3, prompt: 'prompt' }
    ]);
});

test('supports 100+ and preserves user numbers without renumbering', () => {
    const result = parsePrompts('10] First prompt\n20] Second prompt\n30] Third prompt\n100] prompt 100');
    assert.deepEqual(result.prompts.map((p) => p.number), [10, 20, 30, 100]);
});

test('keeps the prompt text exactly (punctuation, commas, casing) and strips only the prefix', () => {
    const text = '1] A highly detailed cinematic shot of a futuristic city, neon lights, rain, 4K';
    const [job] = parsePrompts(text).prompts;
    assert.equal(job.prompt, 'A highly detailed cinematic shot of a futuristic city, neon lights, rain, 4K');
    assert.ok(!job.prompt.includes('1]'));
});

test('does not treat brackets inside the prompt as a prefix', () => {
    const [job] = parsePrompts('5] A sign that says "3] open" — weird: yes! [x]').prompts;
    assert.equal(job.number, 5);
    assert.equal(job.prompt, 'A sign that says "3] open" — weird: yes! [x]');
});

test('ignores blank and whitespace-only lines, handles CRLF', () => {
    const result = parsePrompts('\r\n1] one\r\n\r\n   \r\n2] two\r\n\n');
    assert.equal(result.isValid, true);
    assert.deepEqual(simplify(result), [
        { number: 1, prompt: 'one' },
        { number: 2, prompt: 'two' }
    ]);
});

test('reports invalid line with its line number', () => {
    const result = parsePrompts('1] First prompt\n2] Second prompt\nINVALID PROMPT\n4] Fourth prompt');
    assert.equal(result.isValid, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].line, 3);
    assert.equal(result.errors[0].type, 'invalid');
    assert.equal(result.errors[0].message, 'Invalid prompt on line 3.\n\nExpected format:\n\n<number>] <prompt>');
});

test('rejects other malformed prefixes', () => {
    for (const line of ['1) prompt', '1. prompt', 'a] prompt', '[1] prompt', '-1] prompt', '1 ] prompt']) {
        const result = parsePrompts(line);
        assert.equal(result.isValid, false, `expected "${line}" to be invalid`);
        assert.equal(result.errors[0].type, 'invalid');
    }
});

test('reports duplicate numbers', () => {
    const result = parsePrompts('1] First prompt\n1] Second prompt\n2] Third prompt');
    assert.equal(result.isValid, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].type, 'duplicate');
    assert.equal(result.errors[0].number, 1);
    assert.equal(result.errors[0].line, 2);
    assert.equal(result.errors[0].message, 'Duplicate prompt number: 1\n\nPlease use unique numbers.');
});

test('"01" and "1" count as the same number (duplicate)', () => {
    const result = parsePrompts('01] a\n1] b');
    assert.equal(result.errors[0].type, 'duplicate');
});

test('keeps the typed digits as label', () => {
    const [job] = parsePrompts('007] spy').prompts;
    assert.equal(job.number, 7);
    assert.equal(job.label, '007');
});

test('reports empty prompts', () => {
    const result = parsePrompts('1] ok\n2]\n3]    ');
    assert.equal(result.isValid, false);
    assert.deepEqual(result.errors.map((e) => [e.line, e.type]), [[2, 'empty'], [3, 'empty']]);
});

test('empty input is not valid and has no errors', () => {
    const result = parsePrompts('   \n\n');
    assert.equal(result.isValid, false);
    assert.equal(result.errors.length, 0);
    assert.equal(summarizeParse(result), '✗ No prompts found');
});

test('summary strings', () => {
    assert.equal(summarizeParse(parsePrompts('1] a\n2] b')), '✓ 2 valid prompts');
    assert.equal(summarizeParse(parsePrompts('x\ny')), '✗ 2 errors found');
});

test('handles a large list (500 prompts)', () => {
    const text = Array.from({ length: 500 }, (_, i) => `${i + 1}] prompt number ${i + 1}`).join('\n');
    const result = parsePrompts(text);
    assert.equal(result.isValid, true);
    assert.equal(result.prompts.length, 500);
    assert.equal(result.prompts[499].number, 500);
});
