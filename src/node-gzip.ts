// Temporary Node.js gzip connection while the portable compression stage is implemented.
import { Readable } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';
import { createTarPacker } from './packer.ts';
import { createTarExtractor } from './extractor.ts';
import { iterateSource } from './streams.ts';
import type { Source } from './streams.ts';
import type { EntryItem, CompressionTypes } from './types.ts';

export const createTarPackerWithGzip = (
  entries: AsyncIterable<EntryItem>,
  compression?: CompressionTypes,
  signal?: AbortSignal
): ReadableStream<Uint8Array> => {
  const stream = createTarPacker(entries, 'none', signal);
  if (compression !== 'gzip') return stream;
  return Readable.toWeb(
    Readable.fromWeb(stream).pipe(createGzip({ level: 9 }))
  ) as ReadableStream<Uint8Array>;
};

export const createTarExtractorWithGzip = (
  source: Source<Uint8Array>,
  compression?: CompressionTypes,
  signal?: AbortSignal
) => {
  const stream =
    compression === 'gzip'
      ? Readable.from(iterateSource(source, signal)).pipe(createGunzip())
      : source;
  return createTarExtractor(stream, 'none', signal);
};
