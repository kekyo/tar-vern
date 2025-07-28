// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { Readable } from "stream";
import { createGzip } from "zlib";
import { getBuffer, MAX_NAME, MAX_PREFIX } from "./utils";
import { CompressionTypes, EntryItem, EntryItemContent } from "./types";

/**
 * Get the byte length of a string in UTF-8
 * @param str - The string to get the byte length of
 * @returns The byte length of the string
 */
const utf8ByteLength = (str: string) => {
  return Buffer.byteLength(str, "utf8");
}

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
    const charBytes = Buffer.byteLength(char, "utf8");
    if (total + charBytes > maxBytes) break;
    total += charBytes;
    i += char.length;
  }
  return str.slice(0, i);
}

/**
 * Split a path into a name and a prefix
 * @param path - The path to split
 * @returns The name and prefix
 */
const splitPath = (path: string) => {
  if (utf8ByteLength(path) <= MAX_NAME) {
    return { prefix: "", name: path };
  }

  // Split by '/' and find the part that fits in name from the end
  const parts = path.split("/");
  let name = parts.pop() ?? "";
  let prefix = parts.join("/");

  // Truncate if name exceeds 100 bytes
  if (utf8ByteLength(name) > MAX_NAME) {
    name = truncateUtf8Safe(name, MAX_NAME);
  }

  // Truncate if prefix exceeds 155 bytes
  while (utf8ByteLength(prefix) > MAX_PREFIX) {
    prefix = truncateUtf8Safe(prefix, MAX_PREFIX);
  }

  return { prefix, name };
}

///////////////////////////////////////////////////////////////////////////////////

/**
 * Get octal bytes from a number
 * @param value - The number to get octal bytes from
 * @param length - The length of the octal bytes
 * @returns The octal bytes
 */
const getOctalBytes = (value: number, length: number) => {
  const str = value.toString(8).padStart(length - 1, "0") + "\0";
  return Buffer.from(str, "ascii");
};

/**
 * Get padded bytes from a buffer
 * @param buffer - The buffer to get padded bytes from
 * @returns The padded bytes
 */
const getPaddedBytes = (buffer: Buffer) => {
  const extra = buffer.length % 512;
  if (extra === 0) {
    return buffer;
  } else {
    return Buffer.concat([buffer, Buffer.alloc(512 - extra, 0)]);
  }
}

/**
 * The terminator bytes
 */
const terminatorBytes = Buffer.alloc(1024, 0);

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
  // Allocate header bytes
  const buffer = Buffer.alloc(512, 0);

  // Split path into name and prefix
  const { name, prefix } = splitPath(path);

  // Write name, mode, uid, gid, size, mtime, typeflag, prefix, checksum
  buffer.write(name, 0, 100, "utf8");
  getOctalBytes(mode & 0o7777, 8).copy(buffer, 100);
  getOctalBytes(uid, 8).copy(buffer, 108);
  getOctalBytes(gid, 8).copy(buffer, 116);
  getOctalBytes(size, 12).copy(buffer, 124);
  getOctalBytes(Math.floor(date.getTime() / 1000), 12).copy(buffer, 136);

  // Check sum space
  Buffer.from("        ", "ascii").copy(buffer, 148);

  if (type === 'file') {
    buffer.write("0", 156, 1, "ascii");    // typeflag (file)
  } else {
    buffer.write("5", 156, 1, "ascii");    // typeflag (directory)
  }
  buffer.write("ustar\0", 257, 6, "ascii");
  buffer.write("00", 263, 2, "ascii");     // version
  buffer.write(uname, 265, 32, "utf8");
  buffer.write(gname, 297, 32, "utf8");
  buffer.write(prefix, 345, 155, "utf8");  // Path prefix

  // Calculate check sum
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += buffer[i];
  }
  getOctalBytes(sum, 8).copy(buffer, 148);

  return buffer;
}

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
  signal?: AbortSignal) => {

  // Create async generator function from entry item iterator
  const entryItemIterator = async function*() {
    // Iterate over the entry items
    for await (const entryItem of entryItemGenerator) {
      signal?.throwIfAborted();

      switch (entryItem.kind) {
        // Entry is a file
        case 'file': {
          const entryItemContent = entryItem.content;
          // Content is a string or buffer
          if (typeof entryItemContent === 'string' || Buffer.isBuffer(entryItemContent)) {
            // Get content bytes from string or buffer
            const contentBytes = getBuffer(entryItemContent);

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
              entryItem.date);
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
              entryItem.date);
            yield tarHeaderBytes;

            let position = 0;
            switch (content.kind) {
              // Content is a generator
              case 'generator': {
                for await (const contentBytes of content.generator) {
                  signal?.throwIfAborted();
                  yield contentBytes;
                  position += contentBytes.length;
                }
                break;
              }
              // Content is a readable stream
              case 'readable': {
                for await (const chunk of content.readable) {
                  signal?.throwIfAborted();
                  const contentBytes = getBuffer(chunk);
                  yield contentBytes;
                  position += contentBytes.length;
                }
                break;
              }
            }

            // Padding space
            if (position % 512 !== 0) {
              signal?.throwIfAborted();
              yield Buffer.alloc(512 - (position % 512), 0);
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
      return Readable.from(entryItemIterator());
    }
    // Gzip compression
    case 'gzip': {
      // Create gzip stream
      const gzipStream = createGzip({ level: 9 });
      // Create readable stream from entry item iterator
      const entryItemStream = Readable.from(entryItemIterator());
      // Pipe the entry item stream to the gzip stream
      entryItemStream.pipe(gzipStream);
      // Return the gzip stream
      return gzipStream;
    }
  }
};
