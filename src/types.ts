// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { Readable } from 'stream';

/**
 * Base interface for all entry item contents
 */
export interface EntryItemContentBase {
  readonly kind: 'generator' | 'readable';
  /**
   * The length of the item
   */
  readonly length: number;
}

/**
 * Interface for all entry item contents that are generators
 */
export interface EntryItemGeneratorContent extends EntryItemContentBase {
  readonly kind: 'generator';
  /**
   * The generator function
   */
  readonly generator: AsyncGenerator<Buffer, void, unknown>;
}

/**
 * Interface for all entry item contents that are readable streams
 */
export interface EntryItemReadableContent extends EntryItemContentBase {
  readonly kind: 'readable';
  /**
   * The readable stream
   */
  readonly readable: Readable;
}

/**
 * Union type for all entry item contents
 */
export type EntryItemContent = EntryItemGeneratorContent | EntryItemReadableContent;

///////////////////////////////////////////////////////////////////////////////////

/**
 * Base interface for all entry items
 */
export interface EntryItemBase {
  readonly kind: 'file' | 'directory';
  /**
   * The path of the item
   */
  readonly path: string;
  /**
   * The mode of the item
   */
  readonly mode: number;
  /**
   * The user name of the item
   */
  readonly uname: string;
  /**
   * The group name of the item
   */
  readonly gname: string;
  /**
   * The user ID of the item
   */
  readonly uid: number;
  /**
   * The group ID of the item
   */
  readonly gid: number;
  /**
   * The date of the item
   */
  readonly date: Date;
}

/**
 * Interface for all file entry items
 */
export interface FileItem extends EntryItemBase {
  readonly kind: 'file';
  /**
   * The content of the item
   */
  readonly content: string | Buffer | EntryItemContent;
}

/**
 * Interface for all directory entry items
 */
export interface DirectoryItem extends EntryItemBase {
  readonly kind: 'directory';
}

/**
 * Union type for all entry items
 */
export type EntryItem = FileItem | DirectoryItem;

///////////////////////////////////////////////////////////////////////////////////

/**
 * The type of stat reflection
 * - all: Reflect all stats
 * - exceptName: Reflect all stats except uname and gname
 * - none: Do not reflect any stats
 */
export type ReflectStats = 'all' | 'exceptName' | 'none';

/**
 * The type of compression
 * - none: No compression
 * - gzip: Gzip compression
 */
export type CompressionTypes = 'none' | 'gzip';

/**
 * Options for creating an item
 */
export interface CreateItemOptions {
  /**
   * The mode of the item
   */
  readonly mode?: number;
  /**
   * The user name of the item
   */
  readonly uname?: string;
  /**
   * The group name of the item
   */
  readonly gname?: string;
  /**
   * The user ID of the item
   */
  readonly uid?: number;
  /**
   * The group ID of the item
   */
  readonly gid?: number;
  /**
   * The date of the item
   */
  readonly date?: Date;
}

/**
 * Options for creating a directory item
 */
export interface CreateDirectoryItemOptions extends CreateItemOptions {
  /**
   * The real directory path
   */
  readonly directoryPath?: string;
}

/**
 * Options for creating a readable item
 */
export interface CreateReadableItemOptions extends CreateItemOptions {
  /**
   * The length of the item
   */
  readonly length?: number;
}
