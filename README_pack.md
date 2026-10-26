# tar-vern

A TypeScript/JavaScript library for creating and extracting tar archives in browsers and Node.js.

![tar-vern](images/tar-vern-120-c.png)

[![Project Status: Active](https://www.repostatus.org/badges/latest/active.svg)](https://www.repostatus.org/#active)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/tar-vern.svg)](https://www.npmjs.com/package/tar-vern)

[日本語](https://github.com/kekyo/tar-vern/blob/main/docs/ja/README.md)

tar-vern supports ustar files and directories, gzip, metadata, and cancellation, with no runtime package dependencies. This document describes the 2.0.0 API. It is not backward compatible with 1.x; migration notes appear beside the affected APIs.

## Installation and requirements

```sh
npm install tar-vern
```

Node.js 22.17.0 or later is required. Browsers need `ReadableStream`, `WritableStream`, `AbortController`, `AbortSignal.throwIfAborted()`, `TextEncoder`, `TextDecoder`, and `DOMException`. File and Blob inputs need `Blob.stream()`. Gzip creation and extraction require `CompressionStream('gzip')` and `DecompressionStream('gzip')`, respectively.

Import the shared API from `tar-vern` and Node.js filesystem helpers from `tar-vern/node`. The shared API and its types do not depend on Node.js modules or `Buffer`, so browser applications do not need Node.js polyfills. Both ESM and CommonJS are supported.

```typescript
import { createTarPacker } from 'tar-vern';
import { storeReaderToFile } from 'tar-vern/node';
```

```javascript
const { createTarPacker } = require('tar-vern');
const { storeReaderToFile } = require('tar-vern/node');
```

> Changed in 2.0.0: Filesystem functions and the `ReflectStats` type moved to `tar-vern/node`.

## Creating and extracting an archive

An entry represents a file or directory inside an archive. Supply entries through an async generator, and `createTarPacker` produces tar bytes in that order. `createTarExtractor` accepts those bytes and yields entries sequentially.

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

Here, `getContent('string')` collects the entire file in memory. Use `getContent('readable')`, described below, to process large files incrementally.

> Changed in 2.0.0: `createTarPacker` returns `ReadableStream<Uint8Array>`. Use `Readable.fromWeb()` when existing code expects a Node.js `Readable`.

## Creating archives from browser Files and Blobs

A selected `File` already has a known size. `createBlobFileItem` uses `File.size` or `Blob.size`, so it does not collect the contents to determine their length.

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

Pass files from an `<input type="file" multiple>` or another iterable. The application provides `destination`, a Web Stream that saves or processes the output. Always supply the archive path as the first argument; it is not inferred from `File.name`. For a `File`, the default date is `lastModified`, which `options.date` can override. A plain `Blob` uses the current date when the entry is created.

You can also pass the size and date with `createReadableFileItem(file.name, file.stream(), { length: file.size, date: new Date(file.lastModified) })`. Collecting the entire output into a `Blob` before downloading requires memory for the complete archive.

## Size and memory

The total archive size does not need to be known in advance, for either creation or extraction. Each file's exact byte length is needed when creating an archive because tar writes its header before its contents.

| Input or content access | Memory behavior |
| --- | --- |
| `createBlobFileItem`, or a stream/async iterable with `length` | Creates the archive without collecting the entire file |
| `createReadableFileItem` or `createGeneratorFileItem` without `length` | Collects all contents before the helper resolves, to determine the length |
| Strings and byte arrays passed to `createFileItem` | Uses contents already held by the caller |
| `getContent('readable')` | Reads file contents incrementally |
| `getContent('bytes')` or `getContent('string')` | Collects the entire file |
| Collecting output into a `Blob` or `ArrayBuffer` | Collects the entire archive |

With known input lengths and streamed output, input progresses as output is consumed. Slower output consumption stops further input reads after bounded read-ahead; this is backpressure. Streams and gzip may buffer some data. Memory use also depends on chunk sizes, buffers owned by the input source, and data retained by the destination, so there is no fixed byte limit guarantee.

`length` must be an integer from 0 through 8,589,934,591. Use `length: 0` for an empty file. The output stream errors if the actual contents are either longer or shorter than declared. There is no support for spooling unknown-length inputs to temporary files, reading them twice, or rewriting headers afterward.

> Changed in 2.0.0: Invalid lengths and mismatches between the declared length and actual contents are errors.

## Shared API

### Archives

| Function | Input and output |
| --- | --- |
| `createTarPacker(entries, compressionType?, signal?)` | Accepts `AsyncIterable<EntryItem>` and returns `ReadableStream<Uint8Array>` |
| `createTarExtractor(source, compressionType?, signal?)` | Accepts `ReadableStream<Uint8Array>` or `AsyncIterable<Uint8Array>` and returns `AsyncGenerator<ExtractedEntryItem, void, unknown>` |

`CompressionTypes` is `'none' | 'gzip'`, defaulting to `'none'`. The format is not detected automatically. The optional `signal` is an `AbortSignal`.

### Entry creation

All of these helpers return a `Promise`. `path` is the path inside the archive. Both `options` and `signal` are optional.

| Function | Contents | Return type |
| --- | --- | --- |
| `createDirectoryItem(path, options?, signal?)` | Directory with explicit metadata | `Promise<DirectoryItem>` |
| `createFileItem(path, content, options?, signal?)` | `string` or `Uint8Array` | `Promise<FileItem>` |
| `createReadableFileItem(path, readable, options?, signal?)` | `ReadableStream<Uint8Array>` | `Promise<FileItem>` |
| `createGeneratorFileItem(path, generator, options?, signal?)` | `AsyncIterable<Uint8Array>` | `Promise<FileItem>` |
| `createBlobFileItem(path, blob, options?, signal?)` | `Blob` or `File` | `Promise<FileItem>` |

`createDirectoryItem` does not access the filesystem. The `options` for `createReadableFileItem` and `createGeneratorFileItem` accept `length` as well as metadata. The other entry helpers use `CreateItemOptions`.

> Changed in 2.0.0: The public byte type is `Uint8Array`, and `readable` uses Web Streams. Node.js `Buffer` inputs are accepted as `Uint8Array`. Do not rely on Buffer-specific APIs on returned values.

### Metadata and public types

Every field in `CreateItemOptions` is optional and applies to both files and directories. Explicit values take precedence over defaults.

| Field | Type | Usual default |
| --- | --- | --- |
| `mode` | `number` | `0o644` for files, `0o755` for directories |
| `uid`, `gid` | `number` | `0` |
| `uname`, `gname` | `string` | `'root'` |
| `date` | `Date` | Current date, or `lastModified` for a `File` |

Tar stores dates with one-second precision. `CreateReadableFileItemOptions` extends `CreateItemOptions` with an optional `length: number`.

`EntryItemBase` contains `kind`, `path`, and the metadata above. `EntryItem` is `FileItem | DirectoryItem`. `FileItem.content` accepts a string, a `Uint8Array`, or the following `EntryItemContent`:

```typescript
type EntryItemContent =
  | { kind: 'readable'; length: number; readable: ReadableStream<Uint8Array> }
  | { kind: 'generator'; length: number; generator: AsyncIterable<Uint8Array> };
```

The corresponding public types are `EntryItemReadableContent` and `EntryItemGeneratorContent`. Their common `kind` and `length` fields are defined in `EntryItemContentBase`. Extracted entries use `ExtractedEntryItem`, a union of `ExtractedFileItem | ExtractedDirectoryItem`. Both carry metadata, and files provide `getContent`.

## Reading extracted file contents

Call `getContent` at most once per entry.

| Call | Result |
| --- | --- |
| `await entry.getContent('string')` | A UTF-8-decoded `string` |
| `await entry.getContent('bytes')` | A `Uint8Array` |
| `await entry.getContent('readable')` | A `ReadableStream<Uint8Array>` |

> Changed in 2.0.0: Replace `getContent('buffer')` with `getContent('bytes')`. If you need a Node.js `Buffer`, convert the result with `Buffer.from(bytes)`.

```typescript
import { createTarExtractor } from 'tar-vern';

const countFileBytes = async (source: ReadableStream<Uint8Array>) => {
  for await (const entry of createTarExtractor(source)) {
    if (entry.kind !== 'file') continue;
    let size = 0;
    await (await entry.getContent('readable')).pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.length;
        },
      })
    );
    console.log(entry.path, size);
  }
};
```

If you advance without requesting contents, that file is skipped. Once you request a content stream, consume it completely or cancel it before advancing. Advancing the parent iterator while the acquired stream is unfinished is an error. To stop reading a file partway through, use `await reader.cancel()` and then `reader.releaseLock()`. The remaining contents are skipped when enumeration advances.

> Changed in 2.0.0: Advancing the archive while an acquired file content stream is still active is an error.

## Cancellation and errors

Archive operations and entry helpers accept an `AbortSignal`. Calling its `AbortController.abort()` also interrupts pending reads. Cancelling the output stream or breaking out of an extraction `for await` loop triggers input cleanup. Cancelling only a file's content stream still allows you to advance to the next archive entry.

For known-size inputs, `createReadableFileItem`, `createGeneratorFileItem`, and `createBlobFileItem` check the signal when creating the entry. To cancel subsequent archive creation, also pass the same signal to `createTarPacker`, as shown in the example.

For a custom async iterable, tar-vern requests its `return()` during cleanup, but cannot forcibly stop external work already running inside it. Implement the required cancellation support in that work as well.

Input failures, size mismatches, invalid tar headers or checksums, and gzip errors fail stream reads or enumeration. Wait for the stream or enumeration to finish successfully; finding the last file alone does not establish success. Gzip trailer errors and input errors arriving after tar terminators are also propagated.

## Gzip

Pass `'gzip'` as the second argument when creating or extracting an archive to use the standard compression stream APIs. Missing APIs cause an explicit error, without silently falling back to uncompressed tar. `'none'` remains usable without gzip APIs.

> Changed in 2.0.0: The Node.js zlib implementation with compression level 9 has been removed. The standard API has no level option, so compression ratios and compressed bytes can differ between runtimes. [CompressionStream specification](https://compression.spec.whatwg.org/#compressionstream)

Only single-member gzip is supported. A member is one independent gzip-compressed data unit. Concatenated members are outside the supported scope, and their rejection depends on the runtime. The standard requires rejection, but Node.js v24.15.0 has been observed to accept them. Rejection is not guaranteed across all environments. [Gzip specification](https://compression.spec.whatwg.org/#gzip), [Node.js v24.15.0 compression stream implementation](https://github.com/nodejs/node/blob/v24.15.0/lib/internal/webstreams/compression.js)

## Node.js filesystem API

```typescript
import { createReadStream } from 'node:fs';
import { createTarPacker, createTarExtractor } from 'tar-vern';
import {
  createEntryItemGenerator,
  storeReaderToFile,
  extractTo,
} from 'tar-vern/node';

await storeReaderToFile(
  createTarPacker(createEntryItemGenerator('./input'), 'gzip'),
  './archive.tar.gz'
);

await extractTo(
  createTarExtractor(createReadStream('./archive.tar.gz'), 'gzip'),
  './output'
);
```

| Function | Behavior |
| --- | --- |
| `createReadFileItem(path, filePath, reflectStat?, options?, signal?)` | Returns `Promise<FileItem>` using the real file's size. Contents are opened when archive creation consumes them |
| `createReadDirectoryItem(path, directoryPath, reflectStat?, options?, signal?)` | Returns `Promise<DirectoryItem>` using the real directory's metadata |
| `createEntryItemGenerator(baseDir, relativePaths?, includeDirectory?, reflectStat?, signal?)` | Returns `AsyncGenerator<EntryItem, void, unknown>`. Omitting `relativePaths` enumerates recursively; `includeDirectory` defaults to `true` |
| `storeReaderToFile(source, path, signal?)` | Saves a Web Stream or async iterable of bytes to a file and returns `Promise<void>` for completion |
| `extractTo(entries, basePath, signal?)` | Streams extracted entries to files and returns `Promise<void>` for completion |

When provided, `relativePaths` is processed in array order. Inaccessible paths are skipped with a warning. `ReflectStats` controls which filesystem metadata is copied into an entry.

| Value | Behavior |
| --- | --- |
| `'exceptName'` (default) | Copies mode, uid, gid, and modification time; uses the usual defaults for names |
| `'all'` | Also sets uname and gname to the string forms of uid and gid. It does not resolve OS account names |
| `'none'` | Does not copy optional metadata. File size is still obtained |

Explicit `options` take precedence over filesystem values. With `'none'`, `createReadDirectoryItem` does not stat the directory.

> Changed in 2.0.0: Use the new `createReadDirectoryItem` helper for filesystem directory metadata previously handled by `createDirectoryItem`.

`extractTo` passes `mode` when creating files and directories. It does not reapply uid, gid, or timestamps to the OS. `storeReaderToFile` may leave partial files after errors or cancellation.

> Changed in 2.0.0: `extractTo` streams contents directly to the destination without collecting entire files. Errors or cancellation may leave data already written to disk.

Binary Node.js `Readable` streams can be supplied as `AsyncIterable<Uint8Array>`. Use `Readable.fromWeb()` to connect Web Streams to existing Node.js pipelines, and `Readable.toWeb()` to supply a Node.js stream to `createReadableFileItem`. These conversion APIs became stable in Node.js 22.17.0. [Node.js Stream API](https://nodejs.org/api/stream.html#streamreadablefromwebreadablestream-options)

## Tar format scope

Regular files and directories use the ustar format. Text contents and names use UTF-8. There are no APIs for PAX extensions or symbolic links.

The path's name field holds 100 bytes and its prefix field holds 155 bytes. The current implementation truncates overflowing parts at UTF-8 character boundaries, so long paths are not preserved in full. `uname` and `gname` each hold up to 32 bytes.

## Trying the examples

From a repository checkout, run the following commands to try browser file selection, streamed byte counting, downloading, and extraction:

```sh
npm ci
npm run build
npm run example:browser
```

After building, run the minimal Node.js example with `node examples/node.mjs`. See the [browser example](https://github.com/kekyo/tar-vern/blob/main/examples/browser/main.ts) and [Node.js example](https://github.com/kekyo/tar-vern/blob/main/examples/node.mjs).

## License

[MIT License](https://github.com/kekyo/tar-vern/blob/main/LICENSE).
