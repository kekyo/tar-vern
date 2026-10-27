import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  createFileItem,
  createReadableFileItem,
  createTarPacker,
  createTarExtractor,
} from '../src/index.ts';
import type { EntryItem } from '../src/types.ts';

const entries = async function* (...items: EntryItem[]) {
  yield* items;
};
const collect = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());
const consume = async (
  data: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
) => {
  const result = [];
  for await (const file of createTarExtractor(data, 'gzip')) {
    if (file.kind === 'file') result.push(await file.getContent('string'));
  }
  return result;
};
afterEach(() => vi.unstubAllGlobals());

describe('portable gzip', () => {
  it('interoperates with Node gzip and gunzip', async () => {
    const item = await createFileItem('text', '\uFEFF日本語😀');
    const raw = await collect(createTarPacker(entries(item)));
    const compressed = await collect(createTarPacker(entries(item), 'gzip'));
    expect(new Uint8Array(gunzipSync(compressed))).toEqual(raw);
    expect(await consume(new Blob([gzipSync(raw)]).stream())).toEqual([
      '\uFEFF日本語😀',
    ]);
    expect(await consume(new Blob([compressed]).stream())).toEqual([
      '\uFEFF日本語😀',
    ]);
  });

  it.each(['checksum', 'truncated', 'trailing'])(
    'rejects %s gzip data even after tar terminators',
    async (damage) => {
      const raw = await collect(
        createTarPacker(entries(await createFileItem('text', 'content')))
      );
      let compressed: Uint8Array = gzipSync(raw);
      if (damage === 'checksum') {
        compressed = compressed.slice();
        compressed[compressed.length - 8] ^= 255;
      }
      if (damage === 'truncated')
        compressed = compressed.subarray(0, compressed.length - 1);
      if (damage === 'trailing')
        compressed = new Uint8Array([...compressed, 1]);
      const split = async function* () {
        yield compressed.subarray(0, compressed.length - 8);
        yield compressed.subarray(compressed.length - 8);
      };
      await expect(consume(split())).rejects.toThrow();
    }
  );

  it('propagates an input error after the complete compressed archive', async () => {
    const raw = await collect(
      createTarPacker(entries(await createFileItem('text', 'content')))
    );
    const source = async function* () {
      yield gzipSync(raw);
      throw new Error('late input failure');
    };
    await expect(consume(source())).rejects.toThrow('late input failure');
  });

  it('propagates a file error through compression', async () => {
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('file failure'));
      },
    });
    const item = await createReadableFileItem('text', source, { length: 1 });
    await expect(
      collect(createTarPacker(entries(item), 'gzip'))
    ).rejects.toThrow('file failure');
  });

  it.each(['pack', 'extract'])(
    'aborts pending %s input through compression',
    async (operation) => {
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled = false;
      const source = new ReadableStream<Uint8Array>(
        {
          pull() {
            started();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      const controller = new AbortController();
      let pending: Promise<unknown>;
      if (operation === 'pack') {
        const item = await createReadableFileItem('pending', source, {
          length: 1,
        });
        pending = collect(
          createTarPacker(entries(item), 'gzip', controller.signal)
        );
      } else
        pending = createTarExtractor(source, 'gzip', controller.signal).next();
      const rejection = expect(pending).rejects.toThrow('stop');
      await reading;
      controller.abort(new Error('stop'));
      await rejection;
      expect(cancelled).toBe(true);
      expect(source.locked).toBe(false);
    }
  );

  it('fails clearly when compression APIs are missing while plain tar remains usable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    const item = await createFileItem('text', 'content');
    expect(() => createTarPacker(entries(item), 'gzip')).toThrow(
      /CompressionStream/
    );
    await expect(
      createTarExtractor(new Blob().stream(), 'gzip').next()
    ).rejects.toThrow(/DecompressionStream/);
    const raw = await collect(createTarPacker(entries(item)));
    const files = [];
    for await (const file of createTarExtractor(new Blob([raw]).stream()))
      if (file.kind === 'file') files.push(await file.getContent('string'));
    expect(files).toEqual(['content']);
  });
});
