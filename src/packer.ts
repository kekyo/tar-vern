// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { Readable } from 'stream';
import { createGzip } from 'zlib';
import { getBytes, concatBytes, validateLength, writeText } from './bytes.ts';
const MAX_NAME = 100;
const MAX_PREFIX = 155;
import { CompressionTypes, EntryItem, EntryItemContent } from './types.ts';

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
 * Get padded bytes from a buffer
 * @param buffer - The buffer to get padded bytes from
 * @returns The padded bytes
 */
const getPaddedBytes = (buffer: Uint8Array) => {
  const extra = buffer.length % 512;
  if (extra === 0) {
    return buffer;
  } else {
    return concatBytes(
      [buffer, new Uint8Array(512 - extra)],
      buffer.length + 512 - extra
    );
  }
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
 * Create a tar packer
 * @param entryItemGenerator - The async generator of the entry items
 * @param compressionType - The compression type to use (Default: 'none')
 * @param signal - The abort signal to cancel the tar packer
 * @returns Readable stream of the tar packer
 */
export const createTarPacker = (
  entryItemGenerator: AsyncGenerator<EntryItem, void, unknown>,
  compressionType?: CompressionTypes,
  signal?: AbortSignal
) => {
  // Create async generator function from entry item iterator
  const entryItemIterator = async function* () {
    // Iterate over the entry items
    for await (const entryItem of entryItemGenerator) {
      signal?.throwIfAborted();

      switch (entryItem.kind) {
        // Entry is a file
        case 'file': {
          const entryItemContent = entryItem.content;
          // Content is a string or buffer
          if (
            typeof entryItemContent === 'string' ||
            entryItemContent instanceof Uint8Array
          ) {
            // Get content bytes from string or buffer
            const contentBytes = getBytes(entryItemContent);

            // Create and produce tar header bytes
            const tarHeaderBytes = createTarHeader(
              'file',
              entryItem.path,
              contentBytes.length,
              entryItem.mode,
              entryItem.uname,
              entryItem.gname,
              entryItem.uid,
              entryItem.gid,
              entryItem.date
            );
            yield tarHeaderBytes;

            // Content bytes to adjust padding space and produce
            const totalPaddedContentBytes = getPaddedBytes(contentBytes);
            yield totalPaddedContentBytes;
          } else {
            // Assert that this is EntryItemContent, not FileItemReader (packer doesn't handle FileItemReader)
            const content = entryItemContent as EntryItemContent;

            // Create and produce tar header bytes
            const tarHeaderBytes = createTarHeader(
              'file',
              entryItem.path,
              content.length,
              entryItem.mode,
              entryItem.uname,
              entryItem.gname,
              entryItem.uid,
              entryItem.gid,
              entryItem.date
            );
            yield tarHeaderBytes;

            let position = 0;
            switch (content.kind) {
              // Content is a generator
              case 'generator': {
                for await (const contentBytes of content.generator) {
                  signal?.throwIfAborted();
                  position += contentBytes.length;
                  if (position > content.length)
                    throw new Error('Content size exceeds declared length');
                  yield contentBytes;
                }
                break;
              }
              // Content is a readable stream
              case 'readable': {
                for await (const chunk of content.readable) {
                  signal?.throwIfAborted();
                  const contentBytes = getBytes(chunk);
                  position += contentBytes.length;
                  if (position > content.length)
                    throw new Error('Content size exceeds declared length');
                  yield contentBytes;
                }
                break;
              }
            }

            if (position !== content.length)
              throw new Error('Content size differs from declared length');

            // Padding space
            if (position % 512 !== 0) {
              signal?.throwIfAborted();
              yield new Uint8Array(512 - (position % 512));
            }
          }
          break;
        }
        // Entry is a directory
        case 'directory': {
          // Create and produce tar header bytes
          const tarHeaderBytes = createTarHeader(
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
          yield tarHeaderBytes;
          break;
        }
      }
    }

    // Terminates for tar stream
    yield terminatorBytes;
  };

  const ct = compressionType ?? 'none';

  switch (ct) {
    // No compression
    case 'none': {
      // Create readable stream from entry item iterator
      return Readable.from(entryItemIterator(), { signal });
    }
    // Gzip compression
    case 'gzip': {
      // Create gzip stream
      const gzipStream = createGzip({ level: 9 });
      // Create readable stream from entry item iterator
      const entryItemStream = Readable.from(entryItemIterator(), { signal });
      // Pipe the entry item stream to the gzip stream
      entryItemStream.pipe(gzipStream);
      // Return the gzip stream
      return gzipStream;
    }
  }
};
