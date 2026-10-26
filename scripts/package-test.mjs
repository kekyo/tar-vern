// Verify the tarball in an independent consumer, including without Node.js type definitions.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const { stdout: metadata } = await execute(
  'npm',
  ['exec', '--', 'screw-up', 'dump'],
  {
    cwd: root,
  }
);
const manifest = JSON.parse(metadata);
assert.ok(manifest.git.version, 'The package version must be derived from Git');
assert.equal(manifest.version, manifest.git.version);
const consumer = await mkdtemp(join(tmpdir(), 'tar-vern-consumer-'));
try {
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  await execute(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      join(root, `artifacts/tar-vern-${manifest.version}.tgz`),
    ],
    { cwd: consumer }
  );
  const installed = JSON.parse(
    await readFile(join(consumer, 'node_modules/tar-vern/package.json'), 'utf8')
  );
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.git.commit.hash, manifest.git.commit.hash);
  await cp(join(root, 'tests/consumer'), consumer, { recursive: true });
  const runtime = await execute(process.execPath, ['verify.mjs'], {
    cwd: consumer,
  });
  process.stdout.write(runtime.stdout);
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['browser.ts', 'esm.mts', 'commonjs.cts'],
    })
  );
  await execute(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', consumer],
    { cwd: consumer }
  );
  const result = await build({
    configFile: false,
    root: consumer,
    logLevel: 'warn',
    build: {
      write: false,
      lib: { entry: join(consumer, 'browser.ts'), formats: ['es'] },
    },
  });
  for (const bundle of Array.isArray(result) ? result : [result]) {
    for (const chunk of bundle.output) {
      if (chunk.type === 'chunk')
        assert.deepEqual(
          chunk.imports,
          [],
          'Browser output must have no external dependencies'
        );
    }
  }
  console.log(
    `${manifest.version} tarball: ESM/CJS types, browser types without @types/node, and browser bundle passed`
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
