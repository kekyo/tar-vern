// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { transformGzip } from './compression.ts';
import type {
  CompressionTypes,
  ExtractedEntryItem,
  ExtractedFileItem,
} from './types.ts';
import { concatBytes, decodeBytes, validateLength } from './bytes.ts';
import { createAbortScope, createByteReader } from './streams.ts';
import type { Source } from './streams.ts';

/** Parse a tar ASCII octal number. */
const parseOctalBytes = (
  buffer: Uint8Array,
  offset: number,
  length: number
): number => {
  const text = decodeBytes(buffer.subarray(offset, offset + length))
    .replace(/\0/g, '')
    .trim();
  if (text && !/^[0-7]+$/.test(text))
    throw new Error('Invalid tar numeric field');
  const value = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value))
    throw new Error('Invalid tar numeric field');
  return value;
};

/** Parse a zero-terminated UTF-8 tar field. */
const parseString = (
  buffer: Uint8Array,
  offset: number,
  length: number
): string => {
  const bytes = buffer.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decodeBytes(end < 0 ? bytes : bytes.subarray(0, end));
};

/**
 * Tar file/directory entry item.
 */
interface EntryItemInfo {
  readonly kind: 'file' | 'directory';
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtime: Date;
  readonly uname: string;
  readonly gname: string;
  readonly checksum: number;
}

/**
 * Parse tar header from buffer
 * @param buffer - The buffer containing the tar header
 * @returns The parsed entry information or null if end of archive
 */
const parseTarHeader = (buffer: Uint8Array): EntryItemInfo | undefined => {
  // Check if this is the end of archive (all zeros)
  if (buffer.every((b) => b === 0)) {
    return undefined;
  }

  // Parse header fields
  const name = parseString(buffer, 0, 100);
  const mode = parseOctalBytes(buffer, 100, 8);
  const uid = parseOctalBytes(buffer, 108, 8);
  const gid = parseOctalBytes(buffer, 116, 8);
  const size = parseOctalBytes(buffer, 124, 12);
  validateLength(size);
  const mtime = new Date(parseOctalBytes(buffer, 136, 12) * 1000);
  const checksum = parseOctalBytes(buffer, 148, 8);
  const typeflag = parseString(buffer, 156, 1);
  const magic = parseString(buffer, 257, 6).trim();
  const uname = parseString(buffer, 265, 32);
  const gname = parseString(buffer, 297, 32);
  const prefix = parseString(buffer, 345, 155);

  // Verify magic (should be "ustar" for POSIX tar)
  if (magic !== 'ustar') {
    throw new Error(`Invalid tar format: magic="${magic}"`);
  }

  // Calculate checksum
  let calculatedSum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) {
      calculatedSum += 32; // Space character
    } else {
      calculatedSum += buffer[i];
    }
  }

  if (calculatedSum !== checksum) {
    throw new Error(
      `Invalid checksum: expected ${checksum}, got ${calculatedSum}`
    );
  }

  // Construct full path and remove trailing slash for directories
  let path = prefix ? `${prefix}/${name}` : name;
  if (path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  // Determine type
  const kind = typeflag === '5' ? 'directory' : 'file';

  return {
    kind,
    path,
    size,
    mode,
    uid,
    gid,
    mtime,
    uname: uname || uid.toString(),
    gname: gname || gid.toString(),
    checksum,
  };
};

/** Track the remaining bytes so cancellation never skips a file twice. */
const createFileContent = (
  header: EntryItemInfo,
  input: ReturnType<typeof createByteReader>,
  signal: AbortSignal
) => {
  let state: 'unclaimed' | 'active' | 'cancelled' | 'done' | 'failed' =
    'unclaimed';
  let remaining = header.size;
  let paddingDone = false;
  let pendingPull: Promise<void> | undefined;
  let failure: unknown;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const onAbort = () => {
    if (state === 'active') {
      state = 'failed';
      failure = signal.reason;
      controller?.error(failure);
    }
    signal.removeEventListener('abort', onAbort);
  };
  const skipPadding = async () => {
    if (!paddingDone) {
      await input.skip((512 - (header.size % 512)) % 512);
      paddingDone = true;
    }
  };
  const finish = async () => {
    if (state === 'active')
      throw new Error(
        'Consume or cancel the file content stream before advancing the archive'
      );
    await pendingPull;
    if (state === 'failed') throw failure;
    if (state !== 'done') {
      await input.skip(remaining);
      remaining = 0;
      await skipPadding();
      state = 'done';
    }
  };
  const getContent = async (type: 'string' | 'bytes' | 'readable') => {
    signal.throwIfAborted();
    if (state !== 'unclaimed')
      throw new Error(
        'Content has already been consumed. Multiple calls to getContent are not supported.'
      );
    if (!['string', 'bytes', 'readable'].includes(type))
      throw new Error(`Unsupported content type: ${type}`);
    // Claim the file immediately, including before the first stream pull.
    state = 'active';
    const stream = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
          signal.addEventListener('abort', onAbort, { once: true });
        },
        async pull(value) {
          pendingPull = (async () => {
            try {
              signal.throwIfAborted();
              if (remaining) {
                const chunk = await input.take(remaining);
                if (!chunk)
                  throw new Error(
                    `Unexpected end of stream while reading file data for ${header.path}`
                  );
                remaining -= chunk.length;
                if (state !== 'active') return;
                value.enqueue(chunk);
              }
              if (!remaining) {
                await skipPadding();
                if (state !== 'active') return;
                state = 'done';
                signal.removeEventListener('abort', onAbort);
                value.close();
              }
            } catch (error) {
              if (state === 'active') value.error(error);
              state = 'failed';
              failure = error;
              signal.removeEventListener('abort', onAbort);
            }
          })();
          await pendingPull;
        },
        cancel() {
          // The parent drains only the unread remainder when enumeration resumes.
          state = 'cancelled';
          signal.removeEventListener('abort', onAbort);
        },
      },
      { highWaterMark: 0 }
    );
    if (type === 'readable') return stream;
    // Text and bytes explicitly collect the complete file.
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value.slice());
        total += result.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    const data = concatBytes(chunks, total);
    return type === 'string' ? decodeBytes(data) : data;
  };
  return { finish, getContent: getContent as ExtractedFileItem['getContent'] };
};

/**
 * Enumerate files and directories from a tar stream.
 * @param readable - Byte stream or asynchronous byte iterable; no total size is required.
 * @param compressionType - Compression format (default: 'none').
 * @param signal - Cancel pending reads and release upstream resources.
 * @returns A single-use asynchronous generator of entries.
 * @remarks Unclaimed files are skipped. Consume or cancel claimed content before advancing.
 * Ending enumeration cancels the input. Arbitrary async iterators must cooperate with cancellation.
 */
export const createTarExtractor = (
  readable: Source<Uint8Array>,
  compressionType?: CompressionTypes,
  signal?: AbortSignal
): AsyncGenerator<ExtractedEntryItem, void, unknown> => {
  const scope = createAbortScope(signal);
  const ownSignal = scope.controller.signal;
  const generator = (async function* (): AsyncGenerator<
    ExtractedEntryItem,
    void,
    unknown
  > {
    let input: ReturnType<typeof createByteReader> | undefined;
    let previous: ReturnType<typeof createFileContent> | undefined;
    try {
      const source =
        compressionType === 'gzip'
          ? transformGzip(readable, 'decompress', ownSignal)
          : readable;
      // A dedicated reader owns excess bytes rather than overloading iterator.return().
      input = createByteReader(source, ownSignal);
      while (true) {
        ownSignal.throwIfAborted();
        // Skip unread content and its padding before reading the next header.
        await previous?.finish();
        previous = undefined;
        let bytes: Uint8Array | undefined;
        try {
          bytes = await input.exact(512);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes('Unexpected end of stream')
          )
            throw new Error('Invalid tar format: incomplete header');
          throw error;
        }
        if (!bytes) break;
        const header = parseTarHeader(bytes);
        if (!header) {
          // Check the second terminator block, then drain to propagate late input errors.
          const second = await input.exact(512);
          if (second && !second.every((byte) => byte === 0))
            throw new Error('Invalid tar format: expected terminator block');
          while (await input.take(65536)) {
            /* Drain tar record padding and validate input completion. */
          }
          break;
        }
        const metadata = {
          path: header.path,
          mode: header.mode,
          uid: header.uid,
          gid: header.gid,
          uname: header.uname,
          gname: header.gname,
          date: header.mtime,
        };
        if (header.kind === 'directory') {
          // Yield directory metadata; no file content is exposed.
          yield { kind: 'directory', ...metadata };
        } else {
          // Capture each header in a separate content state.
          previous = createFileContent(header, input, ownSignal);
          yield { kind: 'file', ...metadata, getContent: previous.getContent };
        }
      }
    } finally {
      scope.controller.abort(
        new DOMException('Archive enumeration ended', 'AbortError')
      );
      await input?.close();
      scope.dispose();
    }
  })();
  // A native generator queues return() behind a pending next(). Abort first so that read can settle.
  const originalReturn = generator.return.bind(generator);
  const originalThrow = generator.throw.bind(generator);
  generator.return = async (value) => {
    scope.controller.abort(
      new DOMException('Archive enumeration ended', 'AbortError')
    );
    try {
      return await originalReturn(value);
    } finally {
      scope.dispose();
    }
  };
  generator.throw = async (error) => {
    scope.controller.abort(error);
    try {
      return await originalThrow(error);
    } finally {
      scope.dispose();
    }
  };
  return generator;
};
