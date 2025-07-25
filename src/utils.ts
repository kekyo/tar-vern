// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { createReadStream, createWriteStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { CreateItemOptions, CreateReadableItemOptions, FileItem, DirectoryItem, ReflectStats, CreateDirectoryItemOptions } from "./types";

/**
 * Get the user/group name from the candidate name or ID
 * @param candidateName - The candidate user/group name
 * @param candidateId - The candidate user/group ID
 * @param reflectStat - Whether to reflect the stat (all, exceptName, none)
 * @returns The user/group name
 */
const getUName = (candidateName: string | undefined, candidateId: number, reflectStat: ReflectStats | undefined) => {
  return candidateName ?? (reflectStat === 'all' ? candidateId.toString() : 'root');
}

/**
 * Create a DirectoryItem
 * @param path - The path to the directory in the tar archive
 * @param reflectStat - Whether to reflect optional stat of the file (mode, uid, gid, mtime. Default: 'none')
 * @param options - Metadata for the directory including path in tar archive
 * @returns A DirectoryItem
 * @remarks When reflectStat is 'all' or 'exceptName', `options.directoryPath` must be provided.
 */
export const createDirectoryItem = async (
  path: string,
  reflectStat?: ReflectStats,
  options?: CreateDirectoryItemOptions
): Promise<DirectoryItem> => {
  const rs = reflectStat ?? 'none';

  if (rs !== 'none' && options?.directoryPath) {
    const stats = await stat(options.directoryPath);
    const mode = options?.mode ?? stats.mode;
    const uid = options?.uid ?? stats.uid;
    const gid = options?.gid ?? stats.gid;
    const date = options?.date ?? stats.mtime;
    const uname = getUName(options?.uname, stats.uid, rs);
    const gname = getUName(options?.gname, stats.gid, rs);
    return {
      kind: 'directory',
      path, mode, uname, gname, uid, gid, date,
    };
  } else {
    const mode = options?.mode ?? 0o755;
    const uid = options?.uid ?? 0;
    const gid = options?.gid ?? 0;
    const date = options?.date ?? new Date();
    const uname = getUName(options?.uname, undefined, rs);
    const gname = getUName(options?.gname, undefined, rs);
    return {
      kind: 'directory',
      path, mode, uname, gname, uid, gid, date,
    };
  }
};

/**
 * Create a FileItem from a Readable stream
 * @param path - The path to the file in the tar archive
 * @param reader - The readable stream
 * @param options - Metadata for the file including path in tar archive
 * @returns A FileItem
 */
export const createReadableItem = async (
  path: string,
  reader: Readable,
  options?: CreateReadableItemOptions
): Promise<FileItem> => {
  let readable = reader;

  // When length is not provided, calculate the total size by reading all chunks
  let length = options?.length;
  if (!length) {
    // Calculate the total size by reading all chunks
    const chunks: Buffer[] = [];
    length = 0;

    // Collect all chunks to calculate size
    for await (const chunk of reader) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      chunks.push(buffer);
      length += buffer.length;
    }

    // Create a new readable stream from the collected chunks
    readable = Readable.from(chunks);
  }

  const mode = options?.mode ?? 0o644;
  const uid = options?.uid ?? 0;
  const gid = options?.gid ?? 0;
  const date = options?.date ?? new Date();

  const uname = options?.uname ?? 'root';
  const gname = options?.gname ?? 'root';

  // Create a FileItem
  return {
    kind: 'file',
    path, mode, uname, gname, uid, gid, date,
    content: {
      kind: 'readable',
      length: length,
      readable: readable
    }
  };
};

/**
 * Create a FileItem from a local file path
 * @param path - The path to the file in the tar archive
 * @param filePath - The path to the file to read from real filesystem
 * @param reflectStat - Whether to reflect optional stat of the file (mode, uid, gid, mtime. Default: 'exceptName')
 * @param options - Metadata for the file including path in tar archive
 * @returns A FileItem
 */
export const createReadFileItem = async (
  path: string,
  filePath: string,
  reflectStat?: ReflectStats,
  options?: CreateItemOptions
): Promise<FileItem> => {
  const rs = reflectStat ?? 'exceptName';

  // Get file stats to extract metadata
  const stats = await stat(filePath);
  // Create readable stream from file
  const reader = createReadStream(filePath);

  const mode = options?.mode ?? (rs !== 'none' ? stats.mode : undefined);
  const uid = options?.uid ?? (rs !== 'none' ? stats.uid : undefined);
  const gid = options?.gid ?? (rs !== 'none' ? stats.gid : undefined);
  const date = options?.date ?? (rs !== 'none' ? stats.mtime : undefined);

  const uname = getUName(options?.uname, stats.uid, rs);
  const gname = getUName(options?.gname, stats.gid, rs);

  // Create a FileItem
  return await createReadableItem(path, reader, {
    length: stats.size, mode, uname, gname, uid, gid, date,
  });
};

/**
 * Store a readable stream to a file
 * @param reader - The readable stream
 * @param path - The path to the file to store the readable stream to
 * @returns A promise that resolves when the stream is finished
 */
export const storeReaderToFile = (reader: Readable, path: string) => {
  const writer = createWriteStream(path);
  reader.pipe(writer);
  return new Promise<void>((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
};
