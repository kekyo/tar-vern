import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as esm from 'tar-vern';
import * as esmNode from 'tar-vern/node';

const require = createRequire(import.meta.url);
for (const [format, tar, filesystem] of [
  ['ESM', esm, esmNode],
  ['CJS', require('tar-vern'), require('tar-vern/node')],
]) {
  const entries = async function* () {
    yield await tar.createFileItem('hello.txt', '\uFEFF日本語😀');
  };
  const packed = tar.createTarPacker(entries(), 'gzip');
  assert.ok(packed instanceof ReadableStream);
  await filesystem.storeReaderToFile(packed, `${format}.tar.gz`);
  await filesystem.extractTo(
    tar.createTarExtractor(createReadStream(`${format}.tar.gz`), 'gzip'),
    format
  );
  assert.equal(await readFile(`${format}/hello.txt`, 'utf8'), '\uFEFF日本語😀');
  console.log(`${format}: installed tar/gzip and filesystem APIs passed`);
}
