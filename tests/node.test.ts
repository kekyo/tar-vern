// tar-vern - Tape archiver library for Typescript
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/tar-vern/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectoryItem } from '../src/utils.ts';
import { createTarPacker } from '../src/packer.ts';
import { createTarExtractor } from '../src/extractor.ts';
import {
  createReadDirectoryItem,
  createReadFileItem,
  extractTo,
  storeReaderToFile,
} from '../src/node.ts';
import type { ExtractedFileItem } from '../src/types.ts';

describe('Node filesystem adapters', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tar-vern-node-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('constructs portable directories using explicit metadata only', async () => {
    const date = new Date('2024-01-02T03:04:05Z');
    const item = await createDirectoryItem('archive/path', {
      mode: 0o700,
      uid: 12,
      gid: 34,
      uname: 'owner',
      gname: 'group',
      date,
    });
    expect(item).toEqual({
      kind: 'directory',
      path: 'archive/path',
      mode: 0o700,
      uid: 12,
      gid: 34,
      uname: 'owner',
      gname: 'group',
      date,
    });
  });

  it('reflects directory stats and gives explicit metadata precedence', async () => {
    const source = join(directory, 'source');
    await mkdir(source, { mode: 0o750 });
    const stats = await stat(source);
    const reflected = await createReadDirectoryItem('packed', source, 'all');
    expect(reflected).toMatchObject({
      kind: 'directory',
      path: 'packed',
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
      date: stats.mtime,
      uname: stats.uid.toString(),
      gname: stats.gid.toString(),
    });
    const overridden = await createReadDirectoryItem('packed', source, 'all', {
      mode: 0o700,
      uname: 'override',
      uid: 123,
    });
    expect(overridden).toMatchObject({
      mode: 0o700,
      uname: 'override',
      uid: 123,
    });
  });

  it('reads file entries through the portable tar stream', async () => {
    const source = join(directory, 'source.bin');
    await writeFile(source, new Uint8Array([0, 128, 255]));
    const file = await createReadFileItem('packed.bin', source);
    const entries = async function* () {
      yield file;
    };
    const result = [];
    for await (const entry of createTarExtractor(createTarPacker(entries()))) {
      if (entry.kind === 'file') result.push(await entry.getContent('bytes'));
    }
    expect(result).toEqual([new Uint8Array([0, 128, 255])]);
  });

  it('stores Web Streams and async byte iterables', async () => {
    const webPath = join(directory, 'web.bin');
    await storeReaderToFile(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
      }),
      webPath
    );
    expect(Array.from(await readFile(webPath))).toEqual([1, 2]);
    const chunks = async function* () {
      yield new Uint8Array([3]);
      yield new Uint8Array([4]);
    };
    const iterablePath = join(directory, 'iterable.bin');
    await storeReaderToFile(chunks(), iterablePath);
    expect(Array.from(await readFile(iterablePath))).toEqual([3, 4]);
  });

  it('extracts by requesting streamed content rather than full-file bytes', async () => {
    let requested = false;
    const file = {
      kind: 'file',
      path: 'nested/file.bin',
      mode: 0o600,
      uid: 0,
      gid: 0,
      uname: 'root',
      gname: 'root',
      date: new Date(0),
      getContent: async (type: string) => {
        if (type !== 'readable')
          throw new Error('Full-file buffering was requested');
        requested = true;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([10, 11]));
            controller.enqueue(new Uint8Array([12]));
            controller.close();
          },
        });
      },
    } as ExtractedFileItem;
    const entries = async function* () {
      yield file;
    };
    await extractTo(entries(), directory);
    expect(requested).toBe(true);
    expect(
      Array.from(await readFile(join(directory, 'nested/file.bin')))
    ).toEqual([10, 11, 12]);
  });

  it('rejects an aborted store before creating the destination', async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = async function* () {
      yield new Uint8Array([1]);
    };
    const target = join(directory, 'aborted.bin');
    await expect(
      storeReaderToFile(chunks(), target, controller.signal)
    ).rejects.toThrow();
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['store', 'extract'])(
    'cancels a pending source when opening the destination fails (%s)',
    async (operation) => {
      let cancelled = false;
      const source = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      if (operation === 'store') {
        await expect(storeReaderToFile(source, directory)).rejects.toThrow();
      } else {
        await mkdir(join(directory, 'blocked'));
        const file = {
          ...(await createDirectoryItem('blocked')),
          kind: 'file',
          getContent: async () => source,
        } as ExtractedFileItem;
        const entries = async function* () {
          yield file;
        };
        await expect(extractTo(entries(), directory)).rejects.toThrow();
      }
      expect(cancelled).toBe(true);
      expect(source.locked).toBe(false);
    }
  );
});
