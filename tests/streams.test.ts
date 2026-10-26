import { describe, expect, it } from 'vitest';
import {
  createFileItem,
  createGeneratorFileItem,
  createReadableFileItem,
  createTarExtractor,
  createTarPacker,
} from '../src/index.ts';
import type { EntryItem, ExtractedFileItem } from '../src/types.ts';

const entries = async function* (...items: EntryItem[]) {
  yield* items;
};
const collect = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
};

describe('Web Streams', () => {
  it('rejects pre-aborted operations without reading entries or byte input', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already stopped'));
    let reads = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull() {
          reads++;
        },
      },
      { highWaterMark: 0 }
    );
    const items = async function* () {
      reads++;
      yield await createFileItem('file', 'data');
    };
    await expect(
      createTarPacker(items(), 'none', controller.signal).getReader().read()
    ).rejects.toThrow('already stopped');
    await expect(
      createTarExtractor(source, 'none', controller.signal).next()
    ).rejects.toThrow('already stopped');
    expect(reads).toBe(0);
    expect(source.locked).toBe(false);
  });

  it('interrupts a pending next when the parent iterator is explicitly returned', async () => {
    let wake!: () => void;
    const waiting = new Promise<void>((resolve) => {
      wake = resolve;
    });
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull() {
          wake();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const archive = createTarExtractor(source);
    const rejection = expect(archive.next()).rejects.toThrow(
      /enumeration ended/
    );
    await waiting;
    expect((await archive.return()).done).toBe(true);
    await rejection;
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it('packs into a Web Stream and parses headers and content across single-byte chunks', async () => {
    const data = await collect(
      createTarPacker(
        entries(
          await createFileItem('first', 'abc'),
          await createFileItem('second', 'def')
        )
      )
    );
    const split = async function* () {
      for (const byte of data) yield new Uint8Array([byte]);
    };
    const result = [];
    for await (const file of createTarExtractor(split())) {
      if (file.kind === 'file') result.push(await file.getContent('string'));
    }
    expect(result).toEqual(['abc', 'def']);
  });

  it('skips an unread entry without losing the following header in a shared input chunk', async () => {
    const data = await collect(
      createTarPacker(
        entries(
          await createFileItem('skip', 'abc'),
          await createFileItem('keep', 'def')
        )
      )
    );
    const source = async function* () {
      yield data;
    };
    const archive = createTarExtractor(source());
    expect((await archive.next()).value?.path).toBe('skip');
    const file = (await archive.next()).value as ExtractedFileItem;
    expect(await file.getContent('string')).toBe('def');
    expect((await archive.next()).done).toBe(true);
  });

  it('claims content immediately and rejects a second getContent call', async () => {
    const archive = createTarExtractor(
      createTarPacker(entries(await createFileItem('first', 'abc')))
    );
    const file = (await archive.next()).value as ExtractedFileItem;
    const content = await file.getContent('readable');
    await expect(file.getContent('bytes')).rejects.toThrow(
      /already been consumed/
    );
    expect(await collect(content)).toEqual(new TextEncoder().encode('abc'));
    await archive.return();
  });

  it('rejects advancing while content is still active', async () => {
    const archive = createTarExtractor(
      createTarPacker(entries(await createFileItem('first', 'abc')))
    );
    const file = (await archive.next()).value as ExtractedFileItem;
    const content = await file.getContent('readable');
    await expect(archive.next()).rejects.toThrow(/consume|cancel/i);
    await expect(collect(content)).rejects.toThrow();
  });

  it('continues after cancelling only part of a file without skipping its size twice', async () => {
    const source = async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    };
    const item = await createGeneratorFileItem('partial', source(), {
      length: 4,
    });
    const archive = createTarExtractor(
      createTarPacker(entries(item, await createFileItem('next', 'ok')))
    );
    const file = (await archive.next()).value as ExtractedFileItem;
    const reader = (await file.getContent('readable')).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    await reader.cancel();
    reader.releaseLock();
    const next = (await archive.next()).value as ExtractedFileItem;
    expect(next.path).toBe('next');
    expect(await next.getContent('string')).toBe('ok');
    expect((await archive.next()).done).toBe(true);
  });

  it('closes the input on early parent return and releases the reader lock', async () => {
    const data = await collect(
      createTarPacker(entries(await createFileItem('file', 'abc')))
    );
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(data);
      },
      cancel() {
        cancelled = true;
      },
    });
    const archive = createTarExtractor(source);
    await archive.next();
    await archive.return();
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it('serializes parent advancement after cancelling a pending content read', async () => {
    const data = await collect(
      createTarPacker(
        entries(
          await createFileItem('first', 'abc'),
          await createFileItem('second', 'ok')
        )
      )
    );
    let input!: ReadableStreamDefaultController<Uint8Array>;
    let waiting!: () => void;
    const pendingInput = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const source = new ReadableStream<Uint8Array>(
      {
        start(c) {
          input = c;
          c.enqueue(data.subarray(0, 513));
        },
        pull() {
          waiting();
        },
      },
      { highWaterMark: 0 }
    );
    const archive = createTarExtractor(source);
    const file = (await archive.next()).value as ExtractedFileItem;
    const reader = (await file.getContent('readable')).getReader();
    await reader.read();
    const pending = reader.read();
    await pendingInput;
    await reader.cancel();
    await pending;
    const next = archive.next();
    input.enqueue(data.subarray(513));
    input.close();
    const second = (await next).value as ExtractedFileItem;
    expect(second.path).toBe('second');
    expect(await second.getContent('string')).toBe('ok');
    expect((await archive.next()).done).toBe(true);
  });

  it('aborts a pending input read and releases its reader', async () => {
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
    const archive = createTarExtractor(source, 'none', controller.signal);
    const next = archive.next();
    const rejection = expect(next).rejects.toThrow('stop');
    await reading;
    controller.abort(new Error('stop'));
    await rejection;
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it('returns promptly even when an async iterator ignores cancellation', async () => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let returned = false;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            started();
            return await new Promise<IteratorResult<Uint8Array>>(() => {});
          },
          return: async () => {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const controller = new AbortController();
    const archive = createTarExtractor(source, 'none', controller.signal);
    const rejection = expect(archive.next()).rejects.toThrow('stop');
    await reading;
    controller.abort(new Error('stop'));
    await rejection;
    expect(returned).toBe(true);
  });

  it('cancels the file source when tar output is cancelled during a pending read', async () => {
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
    const item = await createReadableFileItem('pending', source, { length: 1 });
    const reader = createTarPacker(entries(item)).getReader();
    await reader.read();
    const pending = reader.read();
    await reading;
    await reader.cancel();
    await pending;
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });

  it('closes the current file when aborted between output reads', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const item = await createReadableFileItem('pending', source, { length: 1 });
    const controller = new AbortController();
    const reader = createTarPacker(
      entries(item),
      'none',
      controller.signal
    ).getReader();
    await reader.read();
    controller.abort(new Error('stop'));
    await expect(reader.read()).rejects.toThrow('stop');
    expect(cancelled).toBe(true);
  });

  it('propagates input errors and rejects truncated content', async () => {
    const data = await collect(
      createTarPacker(entries(await createFileItem('file', 'abc')))
    );
    const source = async function* () {
      yield data.subarray(0, 513);
      throw new Error('input failed');
    };
    const archive = createTarExtractor(source());
    const file = (await archive.next()).value as ExtractedFileItem;
    await expect(file.getContent('bytes')).rejects.toThrow('input failed');
    await archive.return();
    const short = async function* () {
      yield data.subarray(0, 513);
    };
    const truncated = createTarExtractor(short());
    const entry = (await truncated.next()).value as ExtractedFileItem;
    await expect(entry.getContent('bytes')).rejects.toThrow(/Unexpected end/);
    await expect(truncated.next()).rejects.toThrow(/Unexpected end/);
  });
});
