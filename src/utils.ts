// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import type {
  CreateItemOptions,
  CreateReadableFileItemOptions,
  FileItem,
  DirectoryItem,
} from './types.ts';
import { getBytes, validateLength } from './bytes.ts';
import { iterateSource } from './streams.ts';

/**
 * Create a DirectoryItem from explicit metadata or portable defaults.
 * @param path - The path to the directory in the tar archive
 * @param options - Metadata for the directory
 * @param signal - Optional abort signal to cancel the operation
 * @returns A DirectoryItem
 */
export const createDirectoryItem = async (
  path: string,
  options?: CreateItemOptions,
  signal?: AbortSignal
): Promise<DirectoryItem> => {
  signal?.throwIfAborted();
  return {
    kind: 'directory',
    path,
    mode: options?.mode ?? 0o755,
    uid: options?.uid ?? 0,
    gid: options?.gid ?? 0,
    date: options?.date ?? new Date(),
    uname: options?.uname ?? 'root',
    gname: options?.gname ?? 'root',
  };
};

/**
 * Create a FileItem from content data directly
 * @param path - The path to the file in the tar archive
 * @param content - Content data
 * @param options - Metadata for the file including path in tar archive
 * @param signal - Optional abort signal to cancel the operation
 * @returns A FileItem
 */
export const createFileItem = async (
  path: string,
  content: string | Uint8Array,
  options?: CreateItemOptions,
  signal?: AbortSignal
): Promise<FileItem> => {
  signal?.throwIfAborted();

  const mode = options?.mode ?? 0o644;
  const uid = options?.uid ?? 0;
  const gid = options?.gid ?? 0;
  const date = options?.date ?? new Date();

  const uname = options?.uname ?? 'root';
  const gname = options?.gname ?? 'root';

  // Create a FileItem
  return {
    kind: 'file',
    path,
    mode,
    uname,
    gname,
    uid,
    gid,
    date,
    content,
  };
};

/**
 * Create a FileItem from a Web ReadableStream
 * @param path - The path to the file in the tar archive
 * @param readable - The readable stream
 * @param options - Metadata for the file including path in tar archive
 * @param signal - Optional abort signal to cancel the operation
 * @returns A FileItem
 */
export const createReadableFileItem = async (
  path: string,
  readable: ReadableStream<Uint8Array>,
  options?: CreateReadableFileItemOptions,
  signal?: AbortSignal
): Promise<FileItem> => {
  const mode = options?.mode ?? 0o644;
  const uid = options?.uid ?? 0;
  const gid = options?.gid ?? 0;
  const date = options?.date ?? new Date();

  const uname = options?.uname ?? 'root';
  const gname = options?.gname ?? 'root';

  // When length is not provided, calculate the total size by reading all chunks
  signal?.throwIfAborted();
  let length = options?.length;
  if (length !== undefined) validateLength(length);
  if (length === undefined) {
    // Calculate the total size by reading all chunks
    const chunks: Uint8Array[] = [];
    length = 0;

    // Collect all chunks to calculate size
    for await (const chunk of iterateSource(readable, signal)) {
      signal?.throwIfAborted();
      const buffer = getBytes(chunk);
      chunks.push(buffer);
      length += buffer.length;
      validateLength(length);
    }

    // Create a FileItem
    return {
      kind: 'file',
      path,
      mode,
      uname,
      gname,
      uid,
      gid,
      date,
      content: {
        kind: 'generator',
        length,
        generator: (async function* () {
          yield* chunks;
        })(),
      },
    };
  } else {
    // Create a FileItem
    return {
      kind: 'file',
      path,
      mode,
      uname,
      gname,
      uid,
      gid,
      date,
      content: {
        kind: 'readable',
        length,
        readable,
      },
    };
  }
};

/**
 * Create a FileItem from a generator
 * @param path - The path to the file in the tar archive
 * @param generator - The generator to read the file from
 * @param options - Metadata for the file including path in tar archive
 * @param signal - Optional abort signal to cancel the operation
 * @returns A FileItem
 */
export const createGeneratorFileItem = async (
  path: string,
  generator: AsyncIterable<Uint8Array>,
  options?: CreateReadableFileItemOptions,
  signal?: AbortSignal
): Promise<FileItem> => {
  const mode = options?.mode ?? 0o644;
  const uid = options?.uid ?? 0;
  const gid = options?.gid ?? 0;
  const date = options?.date ?? new Date();

  const uname = options?.uname ?? 'root';
  const gname = options?.gname ?? 'root';

  // When length is not provided, calculate the total size by reading all chunks
  signal?.throwIfAborted();
  let length = options?.length;
  if (length !== undefined) validateLength(length);
  if (length === undefined) {
    // Calculate the total size by reading all chunks
    const chunks: Uint8Array[] = [];
    length = 0;

    // Collect all chunks to calculate size
    for await (const chunk of iterateSource(generator, signal)) {
      signal?.throwIfAborted();
      const buffer = getBytes(chunk);
      chunks.push(buffer);
      length += buffer.length;
      validateLength(length);
    }

    // Create a FileItem
    return {
      kind: 'file',
      path,
      mode,
      uname,
      gname,
      uid,
      gid,
      date,
      content: {
        kind: 'generator',
        length,
        generator: (async function* () {
          yield* chunks;
        })(),
      },
    };
  } else {
    // Create a FileItem
    return {
      kind: 'file',
      path,
      mode,
      uname,
      gname,
      uid,
      gid,
      date,
      content: {
        kind: 'generator',
        length,
        generator,
      },
    };
  }
};
