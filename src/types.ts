// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

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
  readonly generator: AsyncIterable<Uint8Array>;
}

/**
 * Interface for all entry item contents that are readable streams
 */
export interface EntryItemReadableContent extends EntryItemContentBase {
  readonly kind: 'readable';
  /**
   * The readable stream
   */
  readonly readable: ReadableStream<Uint8Array>;
}

/**
 * Union type for all entry item contents
 */
export type EntryItemContent =
  EntryItemGeneratorContent | EntryItemReadableContent;

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

///////////////////////////////////////////////////////////////////////////////////

/**
 * Interface for all file entry items
 */
export interface FileItem extends EntryItemBase {
  readonly kind: 'file';
  /**
   * The content of the item
   */
  readonly content: string | Uint8Array | EntryItemContent;
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
 * Interface for extracted all file entry items
 */
export interface ExtractedFileItem extends EntryItemBase {
  readonly kind: 'file';
  /**
   * Get the file content once as text, bytes, or a Web Stream
   * @remarks Consume or cancel a returned stream before advancing the archive. Text and bytes collect the entire file.
   * @param type - The type of data to retrieve ('string', 'bytes', or 'readable')
   * @returns The file content in the requested form
   */
  getContent(type: 'string'): Promise<string>;
  getContent(type: 'bytes'): Promise<Uint8Array>;
  getContent(type: 'readable'): Promise<ReadableStream<Uint8Array>>;
  getContent(
    type: 'string' | 'bytes' | 'readable'
  ): Promise<string | Uint8Array | ReadableStream<Uint8Array>>;
}

/**
 * Interface for extracted all directory entry items
 */
export interface ExtractedDirectoryItem extends EntryItemBase {
  readonly kind: 'directory';
}

/**
 * Union type for extracted all entry items
 */
export type ExtractedEntryItem = ExtractedFileItem | ExtractedDirectoryItem;

///////////////////////////////////////////////////////////////////////////////////

/**
 * The type of compression
 * - none: No compression
 * - gzip: Gzip compression
 */
export type CompressionTypes = 'none' | 'gzip';

/**
 * Options for creating an item
 * @remarks If these option values are provided, will set values to the item exactly
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
 * Options for creating a readable/generator item
 */
export interface CreateReadableFileItemOptions extends CreateItemOptions {
  /**
   * The length of the item
   * @remarks If not provided, the length will be calculated by reading all chunks
   */
  readonly length?: number;
}
