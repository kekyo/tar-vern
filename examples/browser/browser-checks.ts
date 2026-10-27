import {
  createBlobFileItem,
  createReadableFileItem,
  createTarPacker,
  createTarExtractor,
} from 'tar-vern';
import type { EntryItem, ExtractedFileItem } from 'tar-vern';

const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
const entries = async function* (...items: EntryItem[]) {
  yield* items;
};

/** Exercise the published entry in an actual browser. Called through Playwright MCP. */
export const runBrowserChecks = async () => {
  const selected = new File(['\uFEFF日本語😀'], '名前😀.txt', {
    lastModified: 1700000000000,
  });
  const item = await createBlobFileItem(selected.name, selected);
  check(item.date.getTime() === selected.lastModified, 'File date was lost');
  const empty = await createBlobFileItem('empty', new Blob());
  const binary = await createBlobFileItem(
    'binary',
    new Blob([new Uint8Array([0, 128, 255])])
  );
  const values = [];
  for await (const file of createTarExtractor(
    createTarPacker(entries(item, empty, binary))
  )) {
    if (file.kind === 'file')
      values.push({
        path: file.path,
        bytes: Array.from(await file.getContent('bytes')),
      });
  }
  check(
    JSON.stringify(values) ===
      JSON.stringify([
        {
          path: selected.name,
          bytes: Array.from(new TextEncoder().encode('\uFEFF日本語😀')),
        },
        { path: 'empty', bytes: [] },
        { path: 'binary', bytes: [0, 128, 255] },
      ]),
    'File round trip failed'
  );

  let pulls = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  const streamItem = await createReadableFileItem('large', source, {
    length: 1024 * 1024,
  });
  check(pulls === 0, 'Entry creation read the file');
  const reader = createTarPacker(entries(streamItem)).getReader();
  check(
    (await reader.read()).value!.length === 512,
    'Header not produced first'
  );
  await reader.read();
  check(pulls <= 2, 'Input was read ahead without bound');
  await reader.cancel();
  reader.releaseLock();
  check(
    cancelled && !source.locked,
    'Output cancellation did not release input'
  );

  let wake!: () => void;
  const waiting = new Promise<void>((resolve) => {
    wake = resolve;
  });
  let stopped = false;
  const pendingSource = new ReadableStream<Uint8Array>(
    {
      pull() {
        wake();
      },
      cancel() {
        stopped = true;
      },
    },
    { highWaterMark: 0 }
  );
  const controller = new AbortController();
  const archive = createTarExtractor(pendingSource, 'none', controller.signal);
  const result = (async () => {
    try {
      await archive.next();
      return false;
    } catch {
      return true;
    }
  })();
  await waiting;
  controller.abort();
  check(await result, 'Pending read was not aborted');
  check(stopped && !pendingSource.locked, 'Pending input was not released');

  const partial = createTarExtractor(
    createTarPacker(
      entries(
        await createBlobFileItem('first', new Blob(['first'])),
        await createBlobFileItem('next', new Blob(['next']))
      )
    )
  );
  const first = (await partial.next()).value as ExtractedFileItem;
  await (await first.getContent('readable')).cancel();
  const next = (await partial.next()).value as ExtractedFileItem;
  check(
    (await next.getContent('string')) === 'next',
    'Content cancellation lost the next entry'
  );
  await partial.return();
  const compressed = new Uint8Array(
    await new Response(
      createTarPacker(
        entries(await createBlobFileItem('gzip', new Blob(['gzip 日本語']))),
        'gzip'
      )
    ).arrayBuffer()
  );
  const gzipFiles = [];
  for await (const file of createTarExtractor(
    new Blob([compressed]).stream(),
    'gzip'
  )) {
    if (file.kind === 'file') gzipFiles.push(await file.getContent('string'));
  }
  check(
    JSON.stringify(gzipFiles) === JSON.stringify(['gzip 日本語']),
    'Gzip round trip failed'
  );
  compressed[compressed.length - 8] ^= 255;
  let corruptionRejected = false;
  try {
    for await (const file of createTarExtractor(
      new Blob([compressed]).stream(),
      'gzip'
    )) {
      if (file.kind === 'file') await file.getContent('bytes');
    }
  } catch {
    corruptionRejected = true;
  }
  check(corruptionRejected, 'Corrupt gzip trailer was accepted');

  let gzipWake!: () => void;
  const gzipWaiting = new Promise<void>((resolve) => {
    gzipWake = resolve;
  });
  let gzipStopped = false;
  const gzipSource = new ReadableStream<Uint8Array>(
    {
      pull() {
        gzipWake();
      },
      cancel() {
        gzipStopped = true;
      },
    },
    { highWaterMark: 0 }
  );
  const gzipAbort = new AbortController();
  const gzipOutput = createTarPacker(
    entries(await createReadableFileItem('pending', gzipSource, { length: 1 })),
    'gzip',
    gzipAbort.signal
  );
  const gzipResult = (async () => {
    try {
      await new Response(gzipOutput).arrayBuffer();
      return false;
    } catch {
      return true;
    }
  })();
  await gzipWaiting;
  gzipAbort.abort();
  check(await gzipResult, 'Gzip cancellation was ignored');
  check(
    gzipStopped && !gzipSource.locked,
    'Gzip cancellation did not release source'
  );
  return {
    files: values.length,
    backpressure: true,
    cancellation: true,
    pendingAbort: true,
    gzip: true,
    userAgent: navigator.userAgent,
  };
};
