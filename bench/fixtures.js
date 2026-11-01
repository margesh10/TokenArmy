'use strict';
// Deterministic, realistic tool outputs for the benchmark.
// They are synthetic (generated here, not captured from one machine) so anyone can
// reproduce the numbers exactly. Shapes follow real jest / npm / git / tsc / pytest / docker output.

const fs = require('fs');
const path = require('path');

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

const MODULES = ['auth', 'billing', 'cart', 'checkout', 'search', 'profile', 'orders', 'inventory', 'payments', 'notifications', 'session', 'api'];
const VERBS = ['handles', 'returns', 'validates', 'rejects', 'renders', 'computes', 'caches', 'retries', 'parses', 'formats'];
const NOUNS = ['empty input', 'large payloads', 'unicode names', 'expired tokens', 'null values', 'pagination', 'currency rounding', 'timezone offsets', 'duplicate ids', 'concurrent writes'];

function jest() {
  const out = [];
  for (const m of MODULES) {
    out.push(`PASS src/${m}/${m}.test.ts (${(rnd() * 3 + 0.4).toFixed(2)} s)`);
    out.push(`  ${m}`);
    for (let i = 0; i < 20; i++) out.push(`    ✓ ${pick(VERBS)} ${pick(NOUNS)} (${Math.floor(rnd() * 40 + 1)} ms)`);
    out.push('');
  }
  out.push('FAIL src/checkout/total.test.ts');
  out.push('  checkout › total');
  out.push('    ✕ applies discount before tax (12 ms)');
  out.push('');
  out.push('  ● checkout › total › applies discount before tax');
  out.push('');
  out.push('    expect(received).toBe(expected) // Object.is equality');
  out.push('');
  out.push('    Expected: 107.1');
  out.push('    Received: 108.0');
  out.push('');
  out.push('      42 |   const t = total(cart, { discount: 0.1, tax: 0.19 });');
  out.push('    > 43 |   expect(t).toBe(107.1);');
  out.push('         |             ^');
  out.push('      44 | });');
  out.push('');
  out.push('      at Object.<anonymous> (src/checkout/total.test.ts:43:13)');
  out.push('');
  out.push('Test Suites: 1 failed, 12 passed, 13 total');
  out.push('Tests:       1 failed, 240 passed, 241 total');
  out.push('Snapshots:   0 total');
  out.push('Time:        18.442 s');
  out.push('Ran all test suites.');
  return { cmd: 'npx jest', text: out.join('\n') };
}

function npmInstall() {
  const pk = ['react', 'react-dom', 'lodash', 'zod', 'axios', 'express', 'typescript', 'eslint', 'vite', 'esbuild', 'rollup', 'postcss', 'tailwindcss', 'prettier', 'jest', 'ts-node', 'chalk', 'debug', 'semver', 'glob'];
  const out = [];
  for (let i = 0; i < 380; i++) {
    const p = pick(pk) + (rnd() > 0.5 ? '-' + pick(['core', 'utils', 'plugin', 'types', 'cli', 'parser']) : '');
    out.push(`npm http fetch GET 200 https://registry.npmjs.org/${p}/-/${p}-${Math.floor(rnd() * 9)}.${Math.floor(rnd() * 20)}.${Math.floor(rnd() * 30)}.tgz ${Math.floor(rnd() * 900 + 20)}ms (cache miss)`);
    if (i % 60 === 0) out.push(`npm timing reifyNode:node_modules/${p} Completed in ${Math.floor(rnd() * 900)}ms`);
  }
  out.push('npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory.');
  out.push('npm WARN deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported');
  out.push('');
  out.push('added 412 packages, and audited 413 packages in 21s');
  out.push('');
  out.push('98 packages are looking for funding');
  out.push('  run `npm fund` for details');
  out.push('');
  out.push('2 moderate severity vulnerabilities');
  out.push('');
  out.push('To address all issues, run:');
  out.push('  npm audit fix');
  return { cmd: 'npm install', text: out.join('\n') };
}

function gitLog() {
  const out = [];
  const msgs = ['Fix race in session refresh', 'Add pagination to orders API', 'Bump deps', 'Refactor cart totals', 'Handle unicode in search', 'Speed up CI cache', 'Add retry to payment webhook', 'Docs: update README', 'Remove dead feature flag', 'Tighten zod schemas'];
  for (let i = 0; i < 60; i++) {
    out.push(`commit ${hex(40)}`);
    out.push(`Author: ${pick(['Margesh', 'Alex Chen', 'Priya Nair', 'Sam Lee'])} <dev${i % 4}@example.com>`);
    out.push(`Date:   ${pick(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])} Oct ${30 - (i % 28)} ${String(9 + (i % 9)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00 2026 -0400`);
    out.push('');
    out.push(`    ${pick(msgs)}`);
    if (rnd() > 0.6) {
      out.push('');
      out.push('    Longer explanation of the change that most agents do not need to');
      out.push('    read when they only want to know what happened recently.');
    }
    out.push('');
  }
  return { cmd: 'git log', text: out.join('\n') };
}

function gitStatus() {
  const out = ['On branch feature/checkout-v2', "Your branch is ahead of 'origin/feature/checkout-v2' by 3 commits.", '  (use "git push" to publish your local commits)', '', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)'];
  for (let i = 0; i < 6; i++) out.push(`\tmodified:   src/${pick(MODULES)}/index.ts`);
  out.push('', 'Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)');
  for (let i = 0; i < 18; i++) out.push(`\tmodified:   src/${pick(MODULES)}/${pick(['service', 'routes', 'model', 'utils'])}.ts`);
  out.push('', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
  for (let i = 0; i < 8; i++) out.push(`\tsrc/${pick(MODULES)}/new-${i}.ts`);
  out.push('');
  return { cmd: 'git status', text: out.join('\n') };
}

function tsc() {
  const kinds = [
    ['TS2322', "Type 'string | undefined' is not assignable to type 'string'."],
    ['TS2532', "Object is possibly 'undefined'."],
    ['TS7006', "Parameter 'e' implicitly has an 'any' type."],
  ];
  const out = [];
  for (let i = 0; i < 90; i++) {
    const [code, msg] = kinds[i % 3];
    out.push(`src/${pick(MODULES)}/${pick(['service', 'routes', 'model', 'utils'])}.ts(${Math.floor(rnd() * 300 + 1)},${Math.floor(rnd() * 40 + 1)}): error ${code}: ${msg}`);
  }
  out.push('');
  out.push('Found 90 errors in 31 files.');
  return { cmd: 'npx tsc --noEmit', text: out.join('\n') };
}

function pytest() {
  const out = ['============================= test session starts ==============================', 'platform linux -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0', 'rootdir: /app', 'collected 301 items', ''];
  for (let i = 0; i < 300; i++) out.push(`tests/test_${pick(MODULES)}.py::test_${pick(VERBS)}_${pick(NOUNS).replace(/ /g, '_')}_${i} PASSED${' '.repeat(10)}[${String(Math.floor((i / 301) * 100)).padStart(3)}%]`);
  out.push('tests/test_orders.py::test_refund_partial FAILED                         [100%]');
  out.push('', '=================================== FAILURES ===================================', '____________________________ test_refund_partial _____________________________', '', '    def test_refund_partial():', '        order = make_order(total=100)', '>       assert refund(order, 30).remaining == 70', 'E       AssertionError: assert 100 == 70', '', 'tests/test_orders.py:88: AssertionError', '=========================== short test summary info ============================', 'FAILED tests/test_orders.py::test_refund_partial - AssertionError: assert 100 == 70', '======================== 1 failed, 300 passed in 9.81s =========================');
  return { cmd: 'pytest -v', text: out.join('\n') };
}

function docker() {
  const out = [];
  let n = 1;
  for (const step of ['[internal] load build definition from Dockerfile', '[internal] load metadata for docker.io/library/node:20-alpine', '[1/6] FROM docker.io/library/node:20-alpine', '[2/6] WORKDIR /app', '[3/6] COPY package*.json ./', '[4/6] RUN npm ci', '[5/6] COPY . .', '[6/6] RUN npm run build']) {
    out.push(`#${n} ${step}`);
    const k = step.includes('npm') ? 70 : 4;
    for (let i = 0; i < k; i++) out.push(`#${n} ${(rnd() * 20).toFixed(3)} ${step.includes('npm ci') ? `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} ${Math.floor(rnd() * 300)}ms` : step.includes('build') ? `vite v5.4.0 transforming (${i * 13}) src/${pick(MODULES)}/index.ts` : `sha256:${hex(64)} ${Math.floor(rnd() * 90)}MB / 90MB`}`);
    out.push(`#${n} DONE ${(rnd() * 30).toFixed(1)}s`);
    out.push('');
    n++;
  }
  out.push(`#${n} exporting to image`, `#${n} writing image sha256:${hex(64)} done`, `#${n} naming to docker.io/library/shop:latest done`, `#${n} DONE 1.2s`);
  return { cmd: 'docker build .', text: out.join('\n') };
}

function sloppyClaudeMd() {
  const text = `# Project Guidelines

<!-- Maintainer note: last reviewed by the platform team. -->

Welcome! In today's fast-paced world of software development, it's important to note that following these guidelines is crucial.

## Overview

This project is a **robust**, **seamless**, cutting-edge e-commerce platform. We leverage TypeScript and utilize a wide range of tools in order to deliver a world-class experience.

## Rules

- You must always run the tests before committing.
- You must always run the tests before committing.
- Please make sure to use "pnpm" instead of npm.
- You should never commit secrets.
- It should be noted that we use ESLint and Prettier.
- Please note that all API handlers live in \`src/api\`.
- Due to the fact that we deploy on Fly.io, please make sure that you test with \`fly deploy --dry-run\`.

---

## Architecture

Basically, the app is split into modules. Each module essentially has a service, routes and a model. At the end of the day, the service layer is where business logic lives.

\`\`\`json
{
  "modules": ["auth", "billing", "cart", "checkout"],
  "runtime": "node20",
  "deploy": "fly.io"
}
\`\`\`

## Final Notes

Needless to say, code quality matters. Feel free to ask if anything is unclear. I hope this helps! Happy coding!
`;
  return { text };
}

function writeAll(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const all = { jest: jest(), npmInstall: npmInstall(), gitLog: gitLog(), gitStatus: gitStatus(), tsc: tsc(), pytest: pytest(), docker: docker(), claudeMd: sloppyClaudeMd() };
  for (const [k, v] of Object.entries(all)) fs.writeFileSync(path.join(dir, `${k}.txt`), v.text);
  return all;
}

module.exports = { writeAll };
