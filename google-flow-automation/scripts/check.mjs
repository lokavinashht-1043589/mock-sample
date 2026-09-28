// Static "build" check: manifest integrity, syntax of every JS file, relative imports resolve,
// HTML asset references exist, and forbidden patterns are absent. No dependencies.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (msg) => problems.push(msg);
const rel = (p) => relative(root, p).replace(/\\/g, '/');

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        statSync(p).isDirectory() ? walk(p, out) : out.push(p);
    }
    return out;
}

// ── manifest ──
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
const allowedPermissions = new Set(['storage', 'downloads', 'scripting', 'debugger']); // debugger: real clicks (src/background/trusted-input.js)
for (const p of manifest.permissions || []) if (!allowedPermissions.has(p)) fail(`Unexpected permission: ${p}`);
for (const h of manifest.host_permissions || []) if (/<all_urls>|^\*:|:\/\/\*\//.test(h)) fail(`Over-broad host permission: ${h}`);
const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((c) => c.js)
];
for (const f of referenced) if (!existsSync(join(root, f))) fail(`manifest references missing file: ${f}`);
for (const cs of manifest.content_scripts) {
    for (const m of cs.matches) if (!manifest.host_permissions.includes(m)) fail(`content script match not in host_permissions: ${m}`);
}

// ── JS syntax + imports + forbidden patterns ──
const jsFiles = walk(root).filter((f) => /\.(m?js)$/.test(f) && !rel(f).startsWith('scripts/'));
const forbidden = [
    [/\beval\s*\(/, 'eval()'],
    [/new\s+Function\s*\(/, 'new Function()'],
    [/document\.cookie/, 'document.cookie access'],
    [/chrome\.cookies/, 'chrome.cookies API'],
    [/<all_urls>/, '<all_urls>'],
    [/\.innerHTML\s*=/, 'innerHTML assignment']
];
for (const file of jsFiles) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
        fail(`Syntax error in ${rel(file)}:\n${error.stderr?.toString()}`);
    }
    const source = readFileSync(file, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [re, label] of forbidden) {
        if (rel(file).startsWith('tests/')) continue;
        if (re.test(code)) fail(`Forbidden pattern ${label} in ${rel(file)}`);
    }
    for (const m of source.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
        const target = resolve(dirname(file), m[1]);
        if (!existsSync(target)) fail(`${rel(file)} imports missing ${m[1]}`);
    }
}

// Content scripts are classic scripts: no import/export allowed.
for (const f of manifest.content_scripts.flatMap((c) => c.js)) {
    const src = readFileSync(join(root, f), 'utf8');
    if (/^\s*(import|export)\s/m.test(src)) fail(`${f} is a classic content script but uses import/export`);
}

// ── HTML references ──
for (const html of walk(join(root, 'src')).filter((f) => f.endsWith('.html'))) {
    const src = readFileSync(html, 'utf8');
    for (const m of src.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
        if (!existsSync(resolve(dirname(html), m[1]))) fail(`${rel(html)} references missing ${m[1]}`);
    }
}

if (problems.length) {
    console.error(`✗ ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
}
console.log(`✓ manifest OK, ${jsFiles.length} JS files parsed, imports and HTML references resolve, no forbidden patterns`);
