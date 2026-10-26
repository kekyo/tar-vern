// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'test-results/browser');
const mcp = join(
  dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))),
  'cli.js'
);
const engines = process.argv.slice(2);
if (!engines.length) engines.push('chromium', 'firefox', 'webkit');
for (const engine of engines)
  assert.ok(
    ['chromium', 'firefox', 'webkit'].includes(engine),
    `Unknown browser: ${engine}`
  );

await mkdir(output, { recursive: true });
const fixtures = await mkdtemp(join(output, 'fixtures-'));
const files = [
  { name: '日本語.txt', content: new TextEncoder().encode('日本語の内容\n') },
  { name: 'empty.bin', content: new Uint8Array() },
  { name: 'binary.bin', content: new Uint8Array([0, 1, 127, 128, 255]) },
];
const filePaths = [];
for (const file of files) {
  const path = join(fixtures, file.name);
  await writeFile(path, file.content);
  filePaths.push(path);
}
const expectedBytes =
  files.reduce(
    (sum, file) => sum + 512 + Math.ceil(file.content.length / 512) * 512,
    0
  ) + 1024;
const expectedRows = files.map(
  (file) => `${file.name}: ${file.content.length} bytes`
);

const server = await createServer({
  configFile: join(root, 'examples/browser/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0 },
});

try {
  await server.listen();
  const url = server.resolvedUrls.local[0];

  for (const engine of engines) {
    console.log(
      `[${engine}] Checking the browser example through Playwright MCP`
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        mcp,
        '--browser',
        engine,
        '--headless',
        '--isolated',
        '--output-dir',
        output,
        '--image-responses',
        'omit',
      ],
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined)
      ),
      stderr: 'inherit',
    });
    const client = new Client({
      name: 'tar-vern-browser-test',
      version: '1.0.0',
    });
    const call = async (name, args) => {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 60_000 }
      );
      const text = result.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('\n');
      assert.ok(!result.isError, `[${engine}] ${name}: ${text}`);
      return text;
    };
    const evaluate = async (body) => {
      const text = await call('browser_evaluate', {
        function: `async () => { ${body} }`,
      });
      const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/);
      assert.ok(match, `[${engine}] Missing evaluation result: ${text}`);
      return JSON.parse(match[1]);
    };
    // Wait for observable state changes, without relying on file size or timing.
    const finished = async () =>
      await evaluate(`
        const status = document.querySelector('#status');
        const complete = () => /^(Complete:|Cancelled|Error:)/.test(status.textContent);
        if (!complete()) await new Promise(resolve => {
          const observer = new MutationObserver(() => {
            if (complete()) { observer.disconnect(); resolve(); }
          });
          observer.observe(status, { childList: true, characterData: true, subtree: true });
        });
        return status.textContent;
      `);

    try {
      await client.connect(transport);
      await call('browser_navigate', { url });
      const checks = await evaluate(`
        const { runBrowserChecks } = await import('/browser-checks.ts');
        return await runBrowserChecks();
      `);
      console.log(`[${engine}] API checks: ${JSON.stringify(checks)}`);

      await call('browser_click', { target: '#files' });
      await call('browser_file_upload', { paths: filePaths });
      await call('browser_click', { target: '#pack' });
      assert.equal(
        await finished(),
        `Complete: ${files.length} files, ${expectedBytes} archive bytes`
      );

      await call('browser_click', { target: '#download' });
      assert.equal(
        await finished(),
        `Complete: ${files.length} files, ${expectedBytes} archive bytes`
      );
      const archive = await evaluate(`
        const save = document.querySelector('#save');
        if (save.hidden || save.download !== 'archive.tar') throw new Error('Missing archive download');
        const response = await fetch(save.href);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return btoa(String.fromCharCode(...bytes));
      `);
      const archivePath = join(fixtures, `${engine}.tar`);
      await writeFile(archivePath, Buffer.from(archive, 'base64'));

      await call('browser_click', { target: '#archive' });
      await call('browser_file_upload', { paths: [archivePath] });
      await call('browser_click', { target: '#extract' });
      assert.equal(await finished(), `Complete: ${files.length} entries`);
      assert.deepEqual(
        await evaluate(
          `return Array.from(document.querySelectorAll('#entries li'), row => row.textContent);`
        ),
        expectedRows
      );

      // Keep one input pending so cancellation is deterministic on every engine.
      await evaluate(`
        globalThis.browserTestSourceCancelled = false;
        Object.defineProperty(document.querySelector('#files').files[0], 'stream', {
          configurable: true,
          value: () => new ReadableStream({
            cancel() { globalThis.browserTestSourceCancelled = true; }
          })
        });
        return true;
      `);
      await call('browser_click', { target: '#pack' });
      await call('browser_click', { target: '#cancel' });
      assert.equal(await finished(), 'Cancelled');
      assert.equal(
        await evaluate(`
          delete document.querySelector('#files').files[0].stream;
          return globalThis.browserTestSourceCancelled;
        `),
        true
      );

      // Restore a completed result for the screenshot and check that reuse works.
      await call('browser_click', { target: '#pack' });
      assert.equal(
        await finished(),
        `Complete: ${files.length} files, ${expectedBytes} archive bytes`
      );
      await call('browser_take_screenshot', {
        filename: join(output, `${engine}.png`),
        fullPage: true,
        scale: 'css',
      });
      console.log(
        `[${engine}] File selection, tar round-trip, download and cancellation passed`
      );
    } finally {
      await client.close();
    }
  }
} finally {
  await server.close();
  await rm(fixtures, { recursive: true, force: true });
}
