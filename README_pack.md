# Tape archiver library for Typescript

Tape archiver (tar) library for Typescript implementation.

[![Project Status: WIP – Initial development is in progress, but there has not yet been a stable, usable release suitable for the public.](https://www.repostatus.org/badges/latest/wip.svg)](https://www.repostatus.org/#wip)
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

## Usage for tar packing

### Minimum example

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

tar-vern provides tar extraction through async generator, allowing you to process entries as they are extracted from the tar archive.

```typescript
import { createReadStream } from 'fs';
import { createTarExtractor } from 'tar-vern';

// Read GZipped tar file and extract entries
const stream = createReadStream('archive.tar.gz');

for await (const extractedItem of createTarExtractor(stream), 'gzip') {
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

For more information, [see repository documents](http://github.com/kekyo/tar-vern/).

----

## License

Under MIT.
