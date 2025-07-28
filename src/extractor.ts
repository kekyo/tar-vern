// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { Readable } from "stream";
import { createGunzip } from "zlib";
import { CompressionTypes, ExtractedDirectoryItem, ExtractedEntryItem, ExtractedFileItem, FileItemReader } from "./types";
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
 * @param stream - The readable stream
 * @param size - The number of bytes to read
 * @param signal - The abort signal
 * @returns The buffer containing the read bytes
 */
const readExactBytes = async (stream: AsyncIterator<any>, size: number, signal?: AbortSignal): Promise<Buffer | null> => {
  const chunks: Buffer[] = [];
  let totalRead = 0;

  while (totalRead < size) {
    signal?.throwIfAborted();
    
    const { value, done } = await stream.next();
    if (done) {
      if (totalRead === 0) {
        return null; // No data at all
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
      await stream.return?.(chunk.subarray(needed));
      totalRead = size;
    }
  }

  return Buffer.concat(chunks, size);
};

/**
 * Parse tar header from buffer
 * @param buffer - The buffer containing the tar header
 * @returns The parsed entry information or null if end of archive
 */
const parseTarHeader = (buffer: Buffer): { 
  type: 'file' | 'directory',
  path: string,
  size: number,
  mode: number,
  uid: number,
  gid: number,
  mtime: Date,
  uname: string,
  gname: string,
  checksum: number
} | null => {
  // Check if this is the end of archive (all zeros)
  if (buffer.every(b => b === 0)) {
    return null;
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
  const type = typeflag === '5' ? 'directory' : 'file';

  return {
    type,
    path,
    size,
    mode,
    uid,
    gid,
    mtime,
    uname: uname || uid.toString(),
    gname: gname || gid.toString(),
    checksum
  };
};

/**
 * Create a file item reader
 * @param dataBuffer - The buffer containing file data
 * @returns The file item reader
 */
const createFileItemReader = (dataBuffer: Buffer): FileItemReader => {
  const reader: FileItemReader = {
    async getContent(type: any) {
      if (type === 'string') {
        return dataBuffer.toString('utf8');
      } else {
        return dataBuffer;
      }
    }
  } as any;
  
  return reader;
};

/**
 * Create a buffered async iterator that allows returning data
 */
class BufferedAsyncIterator implements AsyncIterator<any> {
  private buffer: any[] = [];
  private iterator: AsyncIterator<any>;

  constructor(iterable: AsyncIterable<any>) {
    this.iterator = iterable[Symbol.asyncIterator]();
  }

  async next(): Promise<IteratorResult<any>> {
    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }
    return this.iterator.next();
  }

  async return(value?: any): Promise<IteratorResult<any>> {
    if (value !== undefined) {
      this.buffer.unshift(value);
    }
    return { value: undefined, done: false };
  }
}

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

  const iterator = new BufferedAsyncIterator(inputStream);

  while (true) {
    signal?.throwIfAborted();

    // Read header (512 bytes)
    let headerBuffer: Buffer | null;
    try {
      headerBuffer = await readExactBytes(iterator, 512, signal);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unexpected end of stream')) {
        throw new Error('Invalid tar format: incomplete header');
      }
      throw error;
    }
    
    if (!headerBuffer) {
      break; // End of stream
    }

    // Parse header
    const header = parseTarHeader(headerBuffer);
    if (!header) {
      // Check for second terminator block
      const secondBlock = await readExactBytes(iterator, 512, signal);
      if (!secondBlock || secondBlock.every(b => b === 0)) {
        break; // Proper end of archive
      }
      throw new Error('Invalid tar format: expected terminator block');
    }

    if (header.type === 'directory') {
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
      // Read file data
      const dataBuffer = await readExactBytes(iterator, header.size, signal);
      if (!dataBuffer) {
        throw new Error(`Unexpected end of stream while reading file data for ${header.path}`);
      }

      // Skip padding bytes to next 512-byte boundary
      const padding = (512 - (header.size % 512)) % 512;
      if (padding > 0) {
        await readExactBytes(iterator, padding, signal);
      }

      // Yield file entry with FileItemReader
      yield {
        kind: 'file',
        path: header.path,
        mode: header.mode,
        uid: header.uid,
        gid: header.gid,
        uname: header.uname,
        gname: header.gname,
        date: header.mtime,
        contentReader: createFileItemReader(dataBuffer)
      } as ExtractedFileItem;
    }
  }
};
