// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { iterateSource, readableFrom } from './streams.ts';
import type { Source } from './streams.ts';

/** Connect standard gzip streams, retaining native error and cancellation propagation. */
export const transformGzip = (
  source: Source<Uint8Array>,
  direction: 'compress' | 'decompress',
  signal: AbortSignal | undefined
): ReadableStream<Uint8Array> => {
  const Constructor =
    direction === 'compress'
      ? globalThis.CompressionStream
      : globalThis.DecompressionStream;
  if (typeof Constructor !== 'function') {
    throw new Error(
      `${direction === 'compress' ? 'CompressionStream' : 'DecompressionStream'} is required for gzip`
    );
  }
  const input =
    'getReader' in source
      ? source
      : readableFrom((ownSignal) => iterateSource(source, ownSignal), signal);
  return input.pipeThrough(new Constructor('gzip'), { signal });
};
