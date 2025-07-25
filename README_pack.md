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
- No any other dependencies.

## Installation

```bash
npm install tar-vern
```

----

## Usage for tar packing

### Basic example

```typescript
import { createTarPacker, storeReaderToFile } from 'tar-vern';
import { createWriteStream } from 'fs';

// Create an async generator for tar entries
const generator = async function*() {
  // Add a simple text file
  yield {
    kind: 'file',
    path: 'hello.txt',
    mode: 0o644,
    uname: 'user',
    gname: 'group',
    uid: 1000,
    gid: 1000,
    date: new Date(),
    content: 'Hello, world!'   // text contents
  };
  
  // Add a directory
  yield {
    kind: 'directory',
    path: 'mydir',
    mode: 0o755,
    uname: 'user',
    gname: 'group',
    uid: 1000,
    gid: 1000,
    date: new Date()
  };
};

// Create tar stream and write to file
const packer = createTarPacker(generator());
await storeReaderToFile(packer, 'archive.tar');   // Use helper to awaitable
```

----

For more information, [see repository documents](http://github.com/kekyo/tar-vern/).

----

## License

Under MIT.
