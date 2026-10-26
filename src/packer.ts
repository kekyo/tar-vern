// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { getBytes, concatBytes, validateLength, writeText } from './bytes.ts';
// Tar specification: name max 100 bytes, prefix max 155 bytes
const MAX_NAME = 100;
const MAX_PREFIX = 155;
import type { CompressionTypes, EntryItem } from './types.ts';
import { iterateSource, readableFrom } from './streams.ts';

/**
 * Get the byte length of a string in UTF-8
 * @param str - The string to get the byte length of
 * @returns The byte length of the string
 */
const utf8ByteLength = (str: string) => {
  return getBytes(str).length;
};

/**
 * Truncate a string to a maximum byte length in UTF-8
 * @param str - The string to truncate
 * @param maxBytes - The maximum byte length
 * @returns The truncated string
 */
const truncateUtf8Safe = (str: string, maxBytes: number) => {
  let total = 0;
  let i = 0;
  while (i < str.length) {
    const codePoint = str.codePointAt(i)!;
    const char = String.fromCodePoint(codePoint);
    const charBytes = getBytes(char).length;
    if (total + charBytes > maxBytes) break;
    total += charBytes;
    i += char.length;
  }
  return str.slice(0, i);
};

/**
 * Split a path into a name and a prefix
 * @param path - The path to split
 * @returns The name and prefix
 */
const splitPath = (path: string) => {
  if (utf8ByteLength(path) <= MAX_NAME) {
    return { prefix: '', name: path };
  }

  // Split by '/' and find the part that fits in name from the end
  const parts = path.split('/');
  let name = parts.pop() ?? '';
  let prefix = parts.join('/');

  // Truncate if name exceeds 100 bytes
  if (utf8ByteLength(name) > MAX_NAME) {
    name = truncateUtf8Safe(name, MAX_NAME);
  }

  // Truncate if prefix exceeds 155 bytes
  while (utf8ByteLength(prefix) > MAX_PREFIX) {
    prefix = truncateUtf8Safe(prefix, MAX_PREFIX);
  }

  return { prefix, name };
};

///////////////////////////////////////////////////////////////////////////////////

/**
 * Get octal bytes from a number
 * @param value - The number to get octal bytes from
 * @param length - The length of the octal bytes
 * @returns The octal bytes
 */
const getOctalBytes = (value: number, length: number) => {
  const str = value.toString(8).padStart(length - 1, '0') + '\0';
  return getBytes(str);
};

/**
 * The terminator bytes
 */
const terminatorBytes = new Uint8Array(1024);

/**
 * Create a tar header
 * @param type - The type of the entry
 * @param path - The path of the entry
 * @param size - The size of the entry
 * @param mode - The mode of the entry
 * @param uname - The user name of the entry
 * @param gname - The group name of the entry
 */
const createTarHeader = (
  type: 'file' | 'directory',
  path: string,
  size: number,
  mode: number,
  uname: string,
  gname: string,
  uid: number,
  gid: number,
  date: Date
) => {
  validateLength(size);
  // Allocate header bytes
  const buffer = new Uint8Array(512);

  // Split path into name and prefix
  const { name, prefix } = splitPath(path);

  // Write name, mode, uid, gid, size, mtime, typeflag, prefix, checksum
  writeText(buffer, name, 0, 100);
  buffer.set(getOctalBytes(mode & 0o7777, 8), 100);
  buffer.set(getOctalBytes(uid, 8), 108);
  buffer.set(getOctalBytes(gid, 8), 116);
  buffer.set(getOctalBytes(size, 12), 124);
  buffer.set(getOctalBytes(Math.floor(date.getTime() / 1000), 12), 136);

  // Check sum space
  buffer.fill(32, 148, 156);

  if (type === 'file') {
    writeText(buffer, '0', 156, 1); // typeflag (file)
  } else {
    writeText(buffer, '5', 156, 1); // typeflag (directory)
  }
  writeText(buffer, 'ustar\0', 257, 6);
  writeText(buffer, '00', 263, 2); // version
  writeText(buffer, uname, 265, 32);
  writeText(buffer, gname, 297, 32);
  writeText(buffer, prefix, 345, 155); // Path prefix

  // Calculate check sum
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += buffer[i];
  }
  buffer.set(getOctalBytes(sum, 8), 148);

  return buffer;
};

///////////////////////////////////////////////////////////////////////////////////

/**
 * Create a pull-driven tar stream.
 * @param entryItemGenerator - Entries in archive order; the total archive size need not be known.
 * @param compressionType - Compression format (default: 'none').
 * @param signal - Abort ongoing reads and close upstream inputs.
 * @returns A Web Stream of tar bytes.
 * @remarks Streaming file contents require an exact byte length. A size mismatch errors the output.
 */
export const createTarPacker = (
  entryItemGenerator: AsyncIterable<EntryItem>,
  compressionType?: CompressionTypes,
  signal?: AbortSignal
): ReadableStream<Uint8Array> => {
  if (compressionType && compressionType !== 'none')
    throw new Error('Gzip is not available in the portable entry yet');
  // Create an async iterator and connect its lifetime to the output stream.
  return readableFrom(async function* (ownSignal) {
    // Iterate over the entry items.
    for await (const entryItem of iterateSource(
      entryItemGenerator,
      ownSignal
    )) {
      ownSignal.throwIfAborted();
      if (entryItem.kind === 'directory') {
        // Create and produce the directory header.
        yield createTarHeader(
          'directory',
          entryItem.path,
          0,
          entryItem.mode,
          entryItem.uname,
          entryItem.gname,
          entryItem.uid,
          entryItem.gid,
          entryItem.date
        );
        continue;
      }
      const content = entryItem.content;
      // Text and byte arrays already have a known byte length.
      const bytes =
        typeof content === 'string' || content instanceof Uint8Array
          ? getBytes(content)
          : undefined;
      const streamContent = bytes
        ? undefined
        : (content as Exclude<typeof content, string | Uint8Array>);
      const length = bytes ? bytes.length : streamContent!.length;
      validateLength(length);
      const source = streamContent
        ? iterateSource(
            streamContent.kind === 'readable'
              ? streamContent.readable
              : streamContent.generator,
            ownSignal
          )
        : undefined;
      try {
        // Create and produce the file header before reading its contents.
        yield createTarHeader(
          'file',
          entryItem.path,
          length,
          entryItem.mode,
          entryItem.uname,
          entryItem.gname,
          entryItem.uid,
          entryItem.gid,
          entryItem.date
        );
        let position = 0;
        if (bytes) {
          if (bytes.length) yield bytes;
          position = bytes.length;
        } else {
          for await (const chunk of source!) {
            if (!(chunk instanceof Uint8Array))
              throw new TypeError('Expected Uint8Array file content');
            position += chunk.length;
            if (position > length)
              throw new Error('Content size exceeds declared length');
            if (chunk.length) yield chunk;
          }
        }
        if (position !== length)
          throw new Error('Content size differs from declared length');
        // Padding space up to the next 512-byte boundary.
        if (position % 512) yield new Uint8Array(512 - (position % 512));
      } finally {
        await source?.return();
        // A stream cancelled after the header may not have started iteration yet.
        if (
          streamContent?.kind === 'readable' &&
          !streamContent.readable.locked
        ) {
          await streamContent.readable.cancel(ownSignal.reason);
        }
      }
    }
    // Terminate the tar stream with two zero blocks.
    yield terminatorBytes.slice();
  }, signal);
};
