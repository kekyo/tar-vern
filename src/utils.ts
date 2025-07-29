// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { createReadStream, createWriteStream } from "fs";
import { stat, mkdir, writeFile } from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { dirname, join } from "path";
import { CreateItemOptions, CreateReadableFileItemOptions, FileItem, DirectoryItem, ReflectStats, CreateDirectoryItemOptions, EntryItem, ExtractedEntryItem, ExtractedFileItem } from "./types";

// Tar specification: name max 100 bytes, prefix max 155 bytes
export const MAX_NAME = 100;
export const MAX_PREFIX = 155;

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
 * Get a buffer from the string or Buffer
 * @param data - The data to get a buffer from
 * @returns A buffer
 */
export const getBuffer = (data: Buffer | string) => {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
}

///////////////////////////////////////////////////////////////////////////////////

/**
 * Create a DirectoryItem
 * @param path - The path to the directory in the tar archive
 * @param reflectStat - Whether to reflect optional stat of the file (mode, uid, gid, mtime. Default: 'none')
 * @param options - Metadata for the directory including path in tar archive
 * @param signal - Optional abort signal to cancel the operation
 * @returns A DirectoryItem
 * @remarks When reflectStat is 'all' or 'exceptName', `options.directoryPath` must be provided.
 */
export const createDirectoryItem = async (
  path: string,
  reflectStat?: ReflectStats,
  options?: CreateDirectoryItemOptions,
  signal?: AbortSignal
): Promise<DirectoryItem> => {
  const rs = reflectStat ?? 'none';

  if (rs !== 'none' && options?.directoryPath) {
    signal?.throwIfAborted();
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
 * Create a FileItem from content data directly
 * @param path - The path to the file in the tar archive
 * @param content - Content data
 * @param options - Metadata for the file including path in tar archive
 * @param signal - Optional abort signal to cancel the operation
 * @returns A FileItem
 */
export const createFileItem = async (
  path: string,
  content: string | Buffer,
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
    path, mode, uname, gname, uid, gid, date,
    content
  };
};

/**
 * Create a FileItem from a Readable stream
 * @param path - The path to the file in the tar archive
 * @param readable - The readable stream
 * @param options - Metadata for the file including path in tar archive
 * @param signal - Optional abort signal to cancel the operation
 * @returns A FileItem
 */
export const createReadableFileItem = async (
  path: string,
  readable: Readable,
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
  let length = options?.length;
  if (!length) {
    // Calculate the total size by reading all chunks
    const chunks: Buffer[] = [];
    length = 0;

    // Collect all chunks to calculate size
    for await (const chunk of readable) {
      signal?.throwIfAborted();
      const buffer = getBuffer(chunk);
      chunks.push(buffer);
      length += buffer.length;
    }

    // Create a FileItem
    return {
      kind: 'file',
      path, mode, uname, gname, uid, gid, date,
      content: {
        kind: 'readable',
        length,
        readable: Readable.from(chunks, { signal })
      }
    };
  } else {
    // Create a FileItem
    return {
      kind: 'file',
      path, mode, uname, gname, uid, gid, date,
      content: {
        kind: 'readable',
        length,
        readable
      }
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
  generator: AsyncGenerator<Buffer, void, unknown>,
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
  let length = options?.length;
  if (!length) {
    // Calculate the total size by reading all chunks
    const chunks: Buffer[] = [];
    length = 0;

    // Collect all chunks to calculate size
    for await (const chunk of generator) {
      signal?.throwIfAborted();
      const buffer = getBuffer(chunk);
      chunks.push(buffer);
      length += buffer.length;
    }

    // Create a FileItem
    return {
      kind: 'file',
      path, mode, uname, gname, uid, gid, date,
      content: {
        kind: 'readable',
        length,
        readable: Readable.from(chunks, { signal })
      }
    };
  } else {
    // Create a FileItem
    return {
      kind: 'file',
      path, mode, uname, gname, uid, gid, date,
      content: {
        kind: 'generator',
        length,
        generator
      }
    };
  }
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
  // Create readable stream from file
  const reader = createReadStream(filePath, { signal });

  const mode = options?.mode ?? (rs !== 'none' ? stats.mode : undefined);
  const uid = options?.uid ?? (rs !== 'none' ? stats.uid : undefined);
  const gid = options?.gid ?? (rs !== 'none' ? stats.gid : undefined);
  const date = options?.date ?? (rs !== 'none' ? stats.mtime : undefined);

  const uname = getUName(options?.uname, stats.uid, rs);
  const gname = getUName(options?.gname, stats.gid, rs);

  // Create a FileItem
  return await createReadableFileItem(path, reader, {
    length: stats.size, mode, uname, gname, uid, gid, date,
  }, signal);
};

///////////////////////////////////////////////////////////////////////////////////

/**
 * Store a readable stream to a file
 * @param reader - The readable stream
 * @param path - The path to the file to store the readable stream to
 * @param signal - Optional abort signal to cancel the operation
 * @returns A promise that resolves when the stream is finished
 */
export const storeReaderToFile = async (reader: Readable, path: string, signal?: AbortSignal) => {
  const writer = createWriteStream(path, { signal });
  await pipeline(reader, writer, { signal });
};

///////////////////////////////////////////////////////////////////////////////////

/**
 * Create an async generator that yields EntryItem objects from filesystem paths
 * @param baseDir - Base directory path for resolving relative paths
 * @param relativePaths - Array of relative paths to include in the tar archive
 * @param reflectStat - Whether to reflect file stats (Default: 'exceptName')
 * @param signal - Optional abort signal to cancel the operation
 * @returns Async generator that yields EntryItem objects
 */
export const createEntryItemGenerator = async function* (
  baseDir: string,
  relativePaths: string[],
  reflectStat?: ReflectStats,
  signal?: AbortSignal
): AsyncGenerator<EntryItem, void, unknown> {
  const rs = reflectStat ?? 'exceptName';
  
  for (const relativePath of relativePaths) {
    signal?.throwIfAborted();
    
    const fsPath = join(baseDir, relativePath);
    
    try {
      signal?.throwIfAborted();
      const stats = await stat(fsPath);
      
      if (stats.isDirectory()) {
        // Create directory entry
        yield await createDirectoryItem(relativePath, rs, {
          directoryPath: fsPath
        }, signal);
      } else if (stats.isFile()) {
        // Create file entry
        yield await createReadFileItem(relativePath, fsPath, rs, undefined, signal);
      }
    } catch (error) {
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
  iterator: AsyncGenerator<ExtractedEntryItem, void, unknown>,
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
      const content = await fileEntry.getContent('buffer');
      await writeFile(targetPath, content, { mode: entry.mode, signal });
    }
  }
};
