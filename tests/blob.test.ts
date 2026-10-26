import { describe, expect, it, vi } from 'vitest';
import {
  createBlobFileItem,
  createTarPacker,
  createTarExtractor,
} from '../src/index.ts';
import type { EntryItem } from '../src/types.ts';

const entries = async function* (...items: EntryItem[]) {
  yield* items;
};

describe('File and Blob inputs', () => {
  it('round trips selected files including Japanese names, binary data and empty files', async () => {
    const files = [
      new File(['日本語😀'], '名前😀.txt', { lastModified: 1700000000000 }),
      new File([new Uint8Array([0, 128, 255])], 'binary'),
      new File([], 'empty'),
    ];
    const items = [];
    for (const file of files) {
      const arrayBuffer = vi
        .spyOn(file, 'arrayBuffer')
        .mockRejectedValue(new Error('Unexpected full-file read'));
      items.push(await createBlobFileItem(file.name, file));
      expect(arrayBuffer).not.toHaveBeenCalled();
    }
    expect(items[0].date.getTime()).toBe(files[0].lastModified);
    const results = [];
    for await (const file of createTarExtractor(
      createTarPacker(entries(...items))
    )) {
      if (file.kind === 'file')
        results.push([file.path, Array.from(await file.getContent('bytes'))]);
    }
    expect(results).toEqual(
      files.map((file, i) => [
        file.name,
        i === 0
          ? Array.from(new TextEncoder().encode('日本語😀'))
          : i === 1
            ? [0, 128, 255]
            : [],
      ])
    );
  });

  it('uses explicit archive paths and metadata', async () => {
    const date = new Date(0);
    const file = new File(['a'], 'original', { lastModified: 1700000000000 });
    expect(
      await createBlobFileItem('renamed', file, { date, mode: 0o600 })
    ).toMatchObject({ path: 'renamed', date, mode: 0o600 });
    expect((await createBlobFileItem('blob', new Blob(['a']))).path).toBe(
      'blob'
    );
  });

  it('starts tar output before reading all content and stops input on cancellation', async () => {
    const blob = new Blob([new Uint8Array(1024)]);
    let reads = 0;
    let cancelled = false;
    vi.spyOn(blob, 'stream').mockImplementation(
      () =>
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              reads++;
              c.enqueue(new Uint8Array(16));
              if (reads === 64) c.close();
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 }
        )
    );
    const item = await createBlobFileItem('large', blob);
    expect(reads).toBe(0);
    const reader = createTarPacker(entries(item)).getReader();
    expect((await reader.read()).value?.length).toBe(512);
    expect(reads).toBeLessThan(64);
    expect((await reader.read()).value?.length).toBe(16);
    expect(reads).toBeLessThanOrEqual(2);
    await reader.cancel();
    const stoppedAt = reads;
    expect((await reader.read()).done).toBe(true);
    expect(reads).toBe(stoppedAt);
    expect(cancelled).toBe(true);
  });
});
