import { describe, expect, it } from 'vitest';
import {
  createFileItem,
  createGeneratorFileItem,
  createTarPacker,
  createTarExtractor,
} from '../src/index.ts';
import type { EntryItem } from '../src/types.ts';

const entries = async function* (...items: EntryItem[]) {
  yield* items;
};

describe('portable bytes and declared lengths', () => {
  it('round trips plain Uint8Array, empty content and UTF-8 including a leading BOM', async () => {
    const items = [
      await createFileItem('日本語😀.bin', new Uint8Array([0, 128, 255])),
      await createFileItem('empty', new Uint8Array()),
      await createFileItem('text', '\uFEFF日本語😀'),
    ];
    const extracted = [];
    for await (const item of createTarExtractor(
      createTarPacker(entries(...items))
    )) {
      if (item.kind === 'file')
        extracted.push([item.path, await item.getContent('bytes')]);
    }
    expect(extracted.map(([path]) => path)).toEqual(
      items.map((item) => item.path)
    );
    expect(Array.from(extracted[0][1] as Uint8Array)).toEqual([0, 128, 255]);
    expect((extracted[1][1] as Uint8Array).length).toBe(0);
    expect(
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(
        extracted[2][1] as Uint8Array
      )
    ).toBe('\uFEFF日本語😀');
  });

  it('does not read a known zero-length generator while creating an entry', async () => {
    let reads = 0;
    const source = async function* () {
      reads++;
    };
    const item = await createGeneratorFileItem('empty', source(), {
      length: 0,
    });
    expect(reads).toBe(0);
    for await (const _chunk of createTarPacker(entries(item))) {
      /* Consume output. */
    }
    expect(reads).toBe(1);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 0o100000000000])(
    'rejects invalid size %s',
    async (length) => {
      const source = async function* () {
        yield new Uint8Array([1]);
      };
      await expect(
        createGeneratorFileItem('invalid', source(), { length })
      ).rejects.toThrow(/length|size/i);
    }
  );

  it.each([0, 1, 3])(
    'rejects content whose declared size %s differs from two bytes',
    async (length) => {
      const source = async function* () {
        yield new Uint8Array([1, 2]);
      };
      const consume = async () => {
        const item = await createGeneratorFileItem('mismatch', source(), {
          length,
        });
        for await (const _chunk of createTarPacker(entries(item))) {
          /* Consume output. */
        }
      };
      await expect(consume()).rejects.toThrow(/size|length/i);
    }
  );

  it('collects an unknown-length generator and preserves byte values', async () => {
    let ended = false;
    const source = async function* () {
      yield new Uint8Array([255]);
      yield new Uint8Array([0]);
      ended = true;
    };
    const item = await createGeneratorFileItem('unknown', source());
    expect(ended).toBe(true);
    for await (const file of createTarExtractor(
      createTarPacker(entries(item))
    )) {
      if (file.kind === 'file')
        expect(Array.from(await file.getContent('bytes'))).toEqual([255, 0]);
    }
  });
});
