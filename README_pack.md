# Tape archiver library for Typescript

Tape archiver (tar) library for Typescript implementation.

[![Project Status: Active – The project has reached a stable, usable state and is being actively developed.](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

----

## What is this?

A modern TypeScript library for creating tape archives (tar/ustar format) using streaming API. Supports both files and directories with metadata preservation, GZip compression, readable streaming, and flexible content sources.

## Features

- Streaming API: Memory-efficient processing of large files
- Multiple content sources: String, Buffer, ReadableStream, file paths and async generators
- Metadata preservation: File permissions, ownership, timestamps
- Built-in compression: GZip compression support (`tar.gz` format)
- No external dependencies.

## Installation

```bash
npm install tar-vern
```

----

## Minimal sample code

tar-vern supplies file and directory information to pack through "TypeScript async generator."
This allows you to specify pack data with very concise code.

```typescript
import {
  createTarPacker, storeReaderToFile,
  createFileItem, createDirectoryItem } from 'tar-vern';

// Create an async generator for tar entries
const itemGenerator = async function*() {
  // Add a simple text file
  yield await createFileItem(
    'hello.txt',      // file name
    'Hello, world!'   // text contents
  );
  
  // Add a directory
  yield await createDirectoryItem('mydir');

  // (Make your own entries with yield expression...)
};

// Create GZipped tar stream and write to file
const packer = createTarPacker(itemGenerator(), 'gzip');
await storeReaderToFile(packer, 'archive.tar.gz');   // Use helper to awaitable
```

tar-vern provides tar extraction through async generator too, allowing you to process entries as they are extracted from the tar archive.

```typescript
import { createReadStream } from 'fs';
import { createTarExtractor } from 'tar-vern';

// Read GZipped tar file and extract entries
const readableStream = createReadStream('archive.tar.gz');

for await (const extractedItem of createTarExtractor(readableStream), 'gzip') {
  if (extractedItem.kind === 'file') {
    console.log(`File: ${extractedItem.path}`);
    
    // Get content as string or buffer
    const content = await extractedItem.getContent('string');
    console.log(`Content: ${content}`);
  } else {
    console.log(`Directory: ${extractedItem.path}`);
  }
}
```

----

## Features

- Bidirectional streaming: Both creation and extraction of tar archives
- Memory-efficient: Streaming API for processing large files without content buffering
- Multiple content sources: String, Buffer, ReadableStream, file paths and async generators
- Metadata preservation: File permissions, ownership, timestamps
- Built-in compression/decompression: GZip compression support (`tar.gz` format)
- Flexible content access: Extract files as string, Buffer, or Readable stream on demand
- Error handling: Comprehensive validation and error reporting
- Abort signal support: Cancellable operations
- No external dependencies: Pure TypeScript implementation

For more information, [see repository documents](http://github.com/kekyo/tar-vern/).

----

## License

Under MIT.
