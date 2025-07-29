// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { Readable } from "stream";
import { createGunzip } from "zlib";
import { CompressionTypes, ExtractedDirectoryItem, ExtractedEntryItem, ExtractedFileItem } from "./types";
import { getBuffer } from "./utils";

/**
 * Parse octal bytes to number
 * @param buffer - The buffer containing octal bytes
 * @param offset - The offset in the buffer
 * @param length - The length of the octal bytes
 * @returns The parsed number
 */
const parseOctalBytes = (buffer: Buffer, offset: number, length: number): number => {
  const str = buffer.subarray(offset, offset + length).toString('ascii').replace(/\0/g, '').trim();
  return str ? parseInt(str, 8) : 0;
};

/**
 * Parse string from buffer
 * @param buffer - The buffer containing the string
 * @param offset - The offset in the buffer
 * @param length - The length of the string
 * @returns The parsed string
 */
const parseString = (buffer: Buffer, offset: number, length: number): string => {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0/g, '').trim();
};

/**
 * Read exact number of bytes from stream
 * @param iterator - The async iterator
 * @param size - The number of bytes to read
 * @param signal - The abort signal
 * @returns The buffer containing the read bytes
 */
const readExactBytes = async (
  iterator: AsyncIterator<string | Buffer>,
  size: number,
  signal: AbortSignal | undefined): Promise<Buffer | undefined> => {

  const chunks: Buffer[] = [];
  let totalRead = 0;

  while (totalRead < size) {
    signal?.throwIfAborted();
    
    const { value, done } = await iterator.next();
    if (done) {
      if (totalRead === 0) {
        return undefined; // No data at all
      } else {
        throw new Error(`Unexpected end of stream: expected ${size} bytes, got ${totalRead} bytes`);
      }
    }

    const chunk = getBuffer(value);
    const needed = size - totalRead;
    
    if (chunk.length <= needed) {
      chunks.push(chunk);
      totalRead += chunk.length;
    } else {
      // We read more than needed, split the chunk
      chunks.push(chunk.subarray(0, needed));
      // Put back the remaining data
      await iterator.return?.(chunk.subarray(needed));
      totalRead = size;
    }
  }

  return Buffer.concat(chunks, size);
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
  /**
   * This entry (file) item is consumed.
   */
  consumed: boolean;
}

/**
 * Parse tar header from buffer
 * @param buffer - The buffer containing the tar header
 * @returns The parsed entry information or null if end of archive
 */
const parseTarHeader = (buffer: Buffer): EntryItemInfo | undefined => {
  // Check if this is the end of archive (all zeros)
  if (buffer.every(b => b === 0)) {
    return undefined;
  }

  // Parse header fields
  const name = parseString(buffer, 0, 100);
  const mode = parseOctalBytes(buffer, 100, 8);
  const uid = parseOctalBytes(buffer, 108, 8);
  const gid = parseOctalBytes(buffer, 116, 8);
  const size = parseOctalBytes(buffer, 124, 12);
  const mtime = new Date(parseOctalBytes(buffer, 136, 12) * 1000);
  const checksum = parseOctalBytes(buffer, 148, 8);
  const typeflag = parseString(buffer, 156, 1);
  const magic = parseString(buffer, 257, 6);
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
    throw new Error(`Invalid checksum: expected ${checksum}, got ${calculatedSum}`);
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
    consumed: false
  };
};

/**
 * Create a buffered async iterator that allows returning data
 */
const createBufferedAsyncIterator = (
  iterable: AsyncIterable<string | Buffer>,
  signal: AbortSignal | undefined
): AsyncIterator<string | Buffer> => {
  const buffer: (string | Buffer)[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  return {
    next: async () => {
      signal?.throwIfAborted();
      if (buffer.length > 0) {
        return { value: buffer.shift()!, done: false };
      }
      return iterator.next();
    },
    return: async (value?: string | Buffer) => {
      if (value !== undefined) {
        buffer.unshift(value);
      }
      return { value: undefined, done: false };
    }
  };
};

/**
 * Iterator will be skip padding bytes.
 * @param iterator - Async iterator
 * @param contentSize - Total content size to calculate boundary position
 * @param signal - Abort signal
 */
const skipPaddingBytesTo512Boundary = async (
  iterator: AsyncIterator<string | Buffer>,
  contentSize: number,
  signal: AbortSignal | undefined) => {
  // Skip padding bytes to next 512-byte boundary
  const padding = (512 - (contentSize % 512)) % 512;
  if (padding > 0) {
    await readExactBytes(iterator, padding, signal);
  }
};

/**
 * Create a readable stream from an async iterator with size limit
 * @param iterator - The async iterator to read from
 * @param size - The number of bytes to read
 * @param signal - The abort signal
 * @returns Readable stream
 */
const createReadableFromIterator = (
  iterator: AsyncIterator<string | Buffer>,
  size: number,
  signal: AbortSignal | undefined,
  consumedRef: { consumed: boolean }
): Readable => {
  const generator = async function*() {
    let remainingBytes = size;
    
    while (remainingBytes > 0) {
      signal?.throwIfAborted();

      const { value, done } = await iterator.next();
      if (done) {
        throw new Error(`Unexpected end of stream: expected ${size} bytes, remaining ${remainingBytes} bytes`);
      }

      const chunk = getBuffer(value);
      if (chunk.length <= remainingBytes) {
        remainingBytes -= chunk.length;
        yield chunk;
      } else {
        // We read more than needed
        const needed = chunk.subarray(0, remainingBytes);
        const excess = chunk.subarray(remainingBytes);
        remainingBytes = 0;
        
        // Return excess data to the iterator
        await iterator.return?.(excess);
        yield needed;
        break;
      }
    }

    // Finalize to skip boundary
    await skipPaddingBytesTo512Boundary(iterator, size, signal);

    // Finished to consume
    consumedRef.consumed = true;
  };

  return Readable.from(generator(), { signal });
};

///////////////////////////////////////////////////////////////////////////////////

/**
 * Create a tar extractor
 * @param readable - The readable stream containing tar data
 * @param compressionType - The compression type (default: 'none')
 * @param signal - The abort signal
 * @returns Async generator of entry items
 */
export const createTarExtractor = async function* (
  readable: Readable,
  compressionType?: CompressionTypes,
  signal?: AbortSignal): AsyncGenerator<ExtractedEntryItem, void, unknown> {

  const ct = compressionType ?? 'none';

  // Apply decompression if needed
  let inputStream: Readable;
  switch (ct) {
    case 'gzip':
      const gunzip = createGunzip();
      readable.pipe(gunzip);
      inputStream = gunzip;
      break;
    case 'none':
    default:
      inputStream = readable;
      break;
  }

  // Get async iterator from the stream
  const iterator = createBufferedAsyncIterator(inputStream, signal);

  // Last entry item
  let header: EntryItemInfo | undefined;

  // For each tar items
  while (true) {
    signal?.throwIfAborted();

    // Did not consume last file item yielding?
    if (header?.kind === 'file' && !header.consumed) {
      // Have to skip the file contents and boundary

      // Read entire contents just now
      const dataBuffer = await readExactBytes(iterator, header.size, signal);
      if (dataBuffer === undefined) {
        throw new Error(`Unexpected end of stream while reading file data for ${header.path}`);
      }
      // Finalize to skip boundary
      await skipPaddingBytesTo512Boundary(iterator, header.size, signal);

      // Mark consumed
      header.consumed = true;
    }

    // Read header (512 bytes)
    let headerBuffer: Buffer | undefined;
    try {
      headerBuffer = await readExactBytes(iterator, 512, signal);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unexpected end of stream')) {
        throw new Error('Invalid tar format: incomplete header');
      }
      throw error;
    }
    
    if (headerBuffer === undefined) {
      break; // End of stream
    }

    // Parse header
    header = parseTarHeader(headerBuffer);
    if (!header) {
      // Check for second terminator block
      const secondBlock = await readExactBytes(iterator, 512, signal);
      if (secondBlock === undefined || secondBlock.every(b => b === 0)) {
        break; // Proper end of archive
      }
      throw new Error('Invalid tar format: expected terminator block');
    }

    if (header.kind === 'directory') {
      // Yield directory entry
      yield {
        kind: 'directory',
        path: header.path,
        mode: header.mode,
        uid: header.uid,
        gid: header.gid,
        uname: header.uname,
        gname: header.gname,
        date: header.mtime
      } as ExtractedDirectoryItem;
    } else {
      // Capture current header to avoid closure issues
      const currentHeader = header;
      
      // Yield file entry with lazy getContent
      yield {
        kind: 'file',
        path: currentHeader.path,
        mode: currentHeader.mode,
        uid: currentHeader.uid,
        gid: currentHeader.gid,
        uname: currentHeader.uname,
        gname: currentHeader.gname,
        date: currentHeader.mtime,
        getContent: async (type: any) => {
          // Is multiple called
          if (currentHeader.consumed) {
            throw new Error('Content has already been consumed. Multiple calls to getContent are not supported.');
          }

          switch (type) {
            // For string
            case 'string': {
              // Read entire contents just now
              const dataBuffer = await readExactBytes(iterator, currentHeader.size, signal);
              if (dataBuffer === undefined) {
                throw new Error(`Unexpected end of stream while reading file data for ${currentHeader.path}`);
              }
              // Finalize to skip boundary
              await skipPaddingBytesTo512Boundary(iterator, currentHeader.size, signal);
              currentHeader.consumed = true;
              return dataBuffer.toString('utf8');
            }
            // For buffer
            case 'buffer': {
              // Read entire contents just now
              const dataBuffer = await readExactBytes(iterator, currentHeader.size, signal);
              if (dataBuffer === undefined) {
                throw new Error(`Unexpected end of stream while reading file data for ${currentHeader.path}`);
              }
              // Finalize to skip boundary
              await skipPaddingBytesTo512Boundary(iterator, currentHeader.size, signal);
              currentHeader.consumed = true;
              return dataBuffer;
            }
            // For Readble stream
            case 'readable': {
              // Get Readble object (to delegate)
              const readable = createReadableFromIterator(iterator, currentHeader.size, signal, currentHeader);
              return readable;
            }
            default:
              throw new Error(`Unsupported content type: ${type}`);
          }
        }
      } as ExtractedFileItem;
    }
  }
};
