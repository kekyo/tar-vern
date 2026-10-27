// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir, readdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import type {
  CreateItemOptions,
  DirectoryItem,
  EntryItem,
  ExtractedEntryItem,
  ExtractedFileItem,
  FileItem,
} from './types.ts';
import { createDirectoryItem, createGeneratorFileItem } from './utils.ts';
import { getBytes } from './bytes.ts';
import { iterateSource } from './streams.ts';

/**
 * The type of stat reflection
 * - all: Reflect all stats
 * - exceptName: Reflect all stats except uname and gname
 * - none: Do not reflect any stats
 */
export type ReflectStats = 'all' | 'exceptName' | 'none';

/**
 * Get the user/group name from the candidate name or ID
 * @param candidateName - The candidate user/group name
 * @param candidateId - The candidate user/group ID
 * @param reflectStat - Whether to reflect the stat (all, exceptName, none)
 * @returns The user/group name
 */
const getUName = (
  candidateName: string | undefined,
  candidateId: number,
  reflectStat: ReflectStats | undefined
) => {
  return (
    candidateName ?? (reflectStat === 'all' ? candidateId.toString() : 'root')
  );
};

/**
 * Create a DirectoryItem from a local directory path.
 * @param path - The path to the directory in the tar archive
 * @param directoryPath - The directory path on the real filesystem
 * @param reflectStat - Whether to reflect mode, uid, gid and mtime; defaults to 'exceptName'
 * @param options - Explicit metadata, which takes precedence over directory stats
 * @param signal - Optional abort signal to cancel the operation
 * @returns A DirectoryItem
 * @remarks Filesystem metadata is not read when reflectStat is 'none'.
 */
export const createReadDirectoryItem = async (
  path: string,
  directoryPath: string,
  reflectStat?: ReflectStats,
  options?: CreateItemOptions,
  signal?: AbortSignal
): Promise<DirectoryItem> => {
  signal?.throwIfAborted();
  const rs = reflectStat ?? 'exceptName';
  if (rs === 'none') return await createDirectoryItem(path, options, signal);
  const stats = await stat(directoryPath);
  return await createDirectoryItem(
    path,
    {
      mode: options?.mode ?? stats.mode,
      uid: options?.uid ?? stats.uid,
      gid: options?.gid ?? stats.gid,
      date: options?.date ?? stats.mtime,
      uname: getUName(options?.uname, stats.uid, rs),
      gname: getUName(options?.gname, stats.gid, rs),
    },
    signal
  );
};

/**
 * Create a FileItem from a local file path
 * @param path - The path to the file in the tar archive
 * @param filePath - The path to the file to read from real filesystem
 * @param reflectStat - Whether to reflect optional stat of the file (mode, uid, gid, mtime. Default: 'exceptName')
 * @param options - Metadata for the file including path in tar archive
 * @param signal - Optional abort signal to cancel the operation
 * @returns A FileItem
 */
export const createReadFileItem = async (
  path: string,
  filePath: string,
  reflectStat?: ReflectStats,
  options?: CreateItemOptions,
  signal?: AbortSignal
): Promise<FileItem> => {
  const rs = reflectStat ?? 'exceptName';

  // Get file stats to extract metadata
  signal?.throwIfAborted();
  const stats = await stat(filePath);
  // Create the file stream only when the entry contents are consumed.
  const contents = async function* () {
    signal?.throwIfAborted();
    const reader = createReadStream(filePath, { signal });
    try {
      for await (const chunk of reader) {
        signal?.throwIfAborted();
        yield getBytes(chunk);
      }
    } finally {
      reader.destroy();
    }
  };

  const mode = options?.mode ?? (rs !== 'none' ? stats.mode : undefined);
  const uid = options?.uid ?? (rs !== 'none' ? stats.uid : undefined);
  const gid = options?.gid ?? (rs !== 'none' ? stats.gid : undefined);
  const date = options?.date ?? (rs !== 'none' ? stats.mtime : undefined);

  const uname = getUName(options?.uname, stats.uid, rs);
  const gname = getUName(options?.gname, stats.gid, rs);

  // Create a FileItem
  return await createGeneratorFileItem(
    path,
    contents(),
    {
      length: stats.size,
      mode,
      uname,
      gname,
      uid,
      gid,
      date,
    },
    signal
  );
};

///////////////////////////////////////////////////////////////////////////////////

/**
 * Store a readable stream to a file
 * @param reader - The readable stream
 * @param path - The path to the file to store the readable stream to
 * @param signal - Optional abort signal to cancel the operation
 * @returns A promise that resolves when the stream is finished
 */
export const storeReaderToFile = async (
  reader: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  path: string,
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted();
  const writer = createWriteStream(path, { signal });
  // The pipeline signal also cancels pending reads when the destination fails.
  await pipeline(
    (options: { signal?: AbortSignal } | undefined) =>
      iterateSource(reader, options?.signal),
    writer,
    { signal }
  );
};

///////////////////////////////////////////////////////////////////////////////////

/**
 * Recursively collect all files and directories in a directory
 * @param baseDir - The base directory to collect files from
 * @param signal - Optional abort signal to cancel the operation
 * @returns Array of relative paths
 */
const getAllFilesInDirectory = async (
  baseDir: string,
  signal: AbortSignal | undefined
): Promise<string[]> => {
  const collectFiles = async (
    currentDir: string,
    relativePath: string
  ): Promise<string[]> => {
    signal?.throwIfAborted();

    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      const result: string[] = [];

      // Process all entries in parallel and collect their results
      const tasks = entries.map(async (entry) => {
        signal?.throwIfAborted();

        const entryRelativePath = join(relativePath, entry.name);

        if (entry.isDirectory()) {
          const entryFullPath = join(currentDir, entry.name);
          // First add the directory itself, then its contents
          const directoryContents = await collectFiles(
            entryFullPath,
            entryRelativePath
          );
          return [entryRelativePath, ...directoryContents];
        } else {
          // For files, just return the file path
          return [entryRelativePath];
        }
      });

      const allResults = await Promise.all(tasks);

      // Flatten and combine all results while maintaining order
      for (const entryResults of allResults) {
        result.push(...entryResults);
      }

      return result;
    } catch (error) {
      signal?.throwIfAborted();
      console.warn(`Warning: Could not read directory ${currentDir}:`, error);
      return [];
    }
  };

  return await collectFiles(baseDir, '');
};

/**
 * Create an async generator that yields EntryItem objects from filesystem paths
 * @param baseDir - Base directory path for resolving relative paths
 * @param relativePaths - Array of relative paths to include in the tar archive (optional)
 * @param includeDirectory - Whether to include DirectoryItem objects (Default: true)
 * @param reflectStat - Whether to reflect file stats (Default: 'exceptName')
 * @param signal - Optional abort signal to cancel the operation
 * @returns Async generator that yields EntryItem objects
 */
export const createEntryItemGenerator = async function* (
  baseDir: string,
  relativePaths?: string[],
  includeDirectory?: boolean,
  reflectStat?: ReflectStats,
  signal?: AbortSignal
): AsyncGenerator<EntryItem, void, unknown> {
  const rs = reflectStat ?? 'exceptName';
  const includeDir = includeDirectory ?? true;

  // If relativePaths is not provided, collect all files in baseDir
  const pathsToProcess =
    relativePaths ?? (await getAllFilesInDirectory(baseDir, signal));

  for (const relativePath of pathsToProcess) {
    signal?.throwIfAborted();

    const fsPath = join(baseDir, relativePath);

    try {
      signal?.throwIfAborted();
      const stats = await stat(fsPath);

      // Create directory entry only if includeDirectory is true
      if (includeDir && stats.isDirectory()) {
        yield await createReadDirectoryItem(
          relativePath,
          fsPath,
          rs,
          undefined,
          signal
        );
      } else if (stats.isFile()) {
        // Create file entry
        yield await createReadFileItem(
          relativePath,
          fsPath,
          rs,
          undefined,
          signal
        );
      }
    } catch (error) {
      signal?.throwIfAborted();
      // Skip files that can't be accessed (permissions, etc.)
      console.warn(`Warning: Could not access ${fsPath}:`, error);
      continue;
    }
  }
};

/**
 * Extract entries from a tar extractor to a directory on the filesystem
 * @param iterator - Async generator of extracted entry items
 * @param basePath - Base directory path where entries will be extracted
 * @param signal - Optional abort signal to cancel the operation
 * @returns Promise that resolves when extraction is complete
 */
export const extractTo = async (
  iterator: AsyncIterable<ExtractedEntryItem>,
  basePath: string,
  signal?: AbortSignal
): Promise<void> => {
  for await (const entry of iterator) {
    signal?.throwIfAborted();

    const targetPath = join(basePath, entry.path);

    if (entry.kind === 'directory') {
      // Create directory
      try {
        signal?.throwIfAborted();
        await mkdir(targetPath, { recursive: true, mode: entry.mode });
      } catch (error) {
        // Directory might already exist, which is fine
        if ((error as any).code !== 'EEXIST') {
          throw error;
        }
      }
    } else if (entry.kind === 'file') {
      // Create parent directories if they don't exist
      const parentDir = dirname(targetPath);
      signal?.throwIfAborted();
      await mkdir(parentDir, { recursive: true });

      // Extract file content and write to filesystem
      const fileEntry = entry as ExtractedFileItem;
      const content = await fileEntry.getContent('readable');
      signal?.throwIfAborted();
      const writer = createWriteStream(targetPath, {
        mode: entry.mode,
        signal,
      });
      // The pipeline signal also cancels pending reads when the destination fails.
      await pipeline(
        (options: { signal?: AbortSignal } | undefined) =>
          iterateSource(content, options?.signal),
        writer,
        { signal }
      );
    }
  }
};
