# tar-vern

A TypeScript/JavaScript library for creating and extracting tar archives

![tar-vern](images/tar-vern-120-c.png)

[![Project Status: Active](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/tar-vern.svg)](https://www.npmjs.com/package/tar-vern)

---

## What Is This?

tar-vern is a library for TypeScript and JavaScript that creates and extracts tar archives.

It supports sequential encoding and decoding and features a modern API.
It works in both browser environments and Node.js.

## Installation and requirements

```sh
npm install tar-vern
```

When using Node.js, version 20.0.0 or later is required.
The stream conversion APIs `Readable.fromWeb()` and `Readable.toWeb()` became stable in Node.js 22.17.0. [Node.js Stream API](https://nodejs.org/api/stream.html#streamreadablefromwebreadablestream-options)

In the browser, use `ReadableStream`, `WritableStream`, `AbortController`, `AbortSignal.throwIfAborted()`, `TextEncoder`, `TextDecoder`, and `DOMException`.
For input from `File` and `Blob`, you need `Blob.stream()`; for generating and decompressing gzip, you need `CompressionStream(‘gzip’)` and `DecompressionStream(‘gzip’)`, respectively.

The following examples are provided for reference:

```typescript
import { createTarPacker } from 'tar-vern';
import { storeReaderToFile } from 'tar-vern/node';
```

```javascript
const { createTarPacker } = require('tar-vern');
const { storeReaderToFile } = require('tar-vern/node');
```

The common API is loaded from `tar-vern`, and the Node.js-specific API for working with file systems is loaded from `tar-vern/node`.

The common API and its type definitions do not depend on Node.js modules or `Buffer`, so a Node.js polyfill for browsers is not required.
It supports both ESM and CommonJS.

## Creating and extracting an archive

An entry represents a file or directory inside an archive.
Supply entries through an async generator, and `createTarPacker` produces tar bytes in that order.
`createTarExtractor` accepts those bytes and yields entries sequentially.

```typescript
import {
  createDirectoryItem,
  createFileItem,
  createTarPacker,
  createTarExtractor,
} from 'tar-vern';

const entries = async function* () {
  yield await createDirectoryItem('messages');
  yield await createFileItem('messages/hello.txt', 'Hello, world!');
};

const archive = createTarPacker(entries());
for await (const entry of createTarExtractor(archive)) {
  if (entry.kind === 'file') {
    console.log(entry.path, await entry.getContent('string'));
  }
}
```

## Creating archives from browser Files and Blobs

A selected `File` already has a known size.
`createBlobFileItem` uses `File.size` or `Blob.size`, so it does not collect the contents to determine their length.

```typescript
import { createBlobFileItem, createTarPacker } from 'tar-vern';

const packFiles = async (
  files: Iterable<File>,
  destination: WritableStream<Uint8Array>,
  signal?: AbortSignal
) => {
  const entries = async function* () {
    for (const file of files) {
      yield await createBlobFileItem(file.name, file, undefined, signal);
    }
  };
  await createTarPacker(entries(), 'none', signal).pipeTo(destination, { signal });
};
```

---

## Documents

For more information, [see the repository.](https://github.com/kekyo/tar-vern/)

## License

Under MIT.
