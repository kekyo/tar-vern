// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

/** A portable source of asynchronously supplied values. */
export type Source<T> = ReadableStream<T> | AsyncIterable<T>;

/** Own an abort signal without changing the caller's controller. */
export const createAbortScope = (signal: AbortSignal | undefined) => {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    dispose: () => signal?.removeEventListener('abort', abort),
  };
};

/** Read a source with cancellation during a pending read and deterministic lock release. */
export const iterateSource = async function* <T>(
  source: Source<T>,
  signal: AbortSignal | undefined
): AsyncGenerator<T, void, unknown> {
  const reader = 'getReader' in source ? source.getReader() : undefined;
  const iterator = reader
    ? undefined
    : (source as AsyncIterable<T>)[Symbol.asyncIterator]();
  let complete = false;
  let pending = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing)
      closing = (async () => {
        try {
          if (!complete) {
            if (reader) await reader.cancel(signal?.reason);
            else await iterator?.return?.();
          }
        } catch {
          // Preserve the original read/abort error if cleanup itself fails.
        } finally {
          reader?.releaseLock();
        }
      })();
    return closing;
  };
  let wake!: () => void;
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    wake = () => resolve({ done: true, value: undefined });
  });
  const onAbort = () => {
    wake();
    void close();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      pending = true;
      const result = await Promise.race([
        reader ? reader.read() : iterator!.next(),
        aborted,
      ]);
      pending = false;
      signal?.throwIfAborted();
      if (result.done) {
        complete = true;
        break;
      }
      yield result.value;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // An arbitrary iterator may ignore cancellation while next() is pending.
    // Request return() and observe its result, but do not block the consumer on it.
    const cleanup = close();
    if (reader || (!pending && !signal?.aborted)) await cleanup;
  }
};

/** Adapt an iterator to a pull-driven Web Stream with no output queue. */
export const readableFrom = <T>(
  factory: (signal: AbortSignal) => AsyncIterable<T>,
  signal: AbortSignal | undefined
): ReadableStream<T> => {
  const scope = createAbortScope(signal);
  const ownSignal = scope.controller.signal;
  const iterator = factory(ownSignal)[Symbol.asyncIterator]();
  let finished = false;
  let controller: ReadableStreamDefaultController<T>;
  const cleanup = () => {
    ownSignal.removeEventListener('abort', onAbort);
    scope.dispose();
  };
  const onAbort = () => {
    if (finished) return;
    finished = true;
    cleanup();
    void (async () => {
      try {
        await iterator.return?.();
      } catch {
        /* The abort reason is the primary error. */
      } finally {
        controller.error(ownSignal.reason);
      }
    })();
  };
  return new ReadableStream<T>(
    {
      start(value) {
        controller = value;
        if (ownSignal.aborted) onAbort();
        else ownSignal.addEventListener('abort', onAbort, { once: true });
      },
      async pull() {
        try {
          ownSignal.throwIfAborted();
          const result = await iterator.next();
          if (finished) return;
          if (result.done) {
            finished = true;
            cleanup();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          if (!finished) {
            finished = true;
            controller.error(error);
          }
          scope.controller.abort(error);
          cleanup();
          await iterator.return?.();
        }
      },
      async cancel(reason) {
        finished = true;
        scope.controller.abort(
          reason ?? new DOMException('Stream cancelled', 'AbortError')
        );
        cleanup();
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 }
  );
};

/** Maintain one input chunk and an offset; iterator.return() always means close. */
export const createByteReader = (
  source: Source<Uint8Array>,
  signal: AbortSignal
) => {
  const iterator = iterateSource(source, signal);
  let chunk = new Uint8Array();
  let offset = 0;
  const take = async (limit: number): Promise<Uint8Array | undefined> => {
    signal.throwIfAborted();
    while (offset === chunk.length) {
      const result = await iterator.next();
      if (result.done) return undefined;
      if (!(result.value instanceof Uint8Array))
        throw new TypeError('Expected Uint8Array input');
      chunk = result.value;
      offset = 0;
    }
    const result = chunk.subarray(
      offset,
      offset + Math.min(limit, chunk.length - offset)
    );
    offset += result.length;
    return result;
  };
  const exact = async (size: number): Promise<Uint8Array | undefined> => {
    const bytes = new Uint8Array(size);
    let position = 0;
    while (position < size) {
      const next = await take(size - position);
      if (!next) {
        if (!position) return undefined;
        throw new Error(
          `Unexpected end of stream: expected ${size} bytes, got ${position} bytes`
        );
      }
      bytes.set(next, position);
      position += next.length;
    }
    return bytes;
  };
  const skip = async (size: number) => {
    let remaining = size;
    while (remaining) {
      const next = await take(remaining);
      if (!next)
        throw new Error('Unexpected end of stream while skipping file data');
      remaining -= next.length;
    }
  };
  return {
    take,
    exact,
    skip,
    close: async () => {
      await iterator.return();
    },
  };
};
