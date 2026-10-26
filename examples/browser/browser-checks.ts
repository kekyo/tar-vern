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
  return {
    files: values.length,
    backpressure: true,
    cancellation: true,
    pendingAbort: true,
    userAgent: navigator.userAgent,
  };
};
