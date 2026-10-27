import {
  createReadableFileItem,
  createTarPacker,
  createTarExtractor,
} from 'tar-vern';

const gzip = document.querySelector<HTMLInputElement>('#gzip')!;
const files = document.querySelector<HTMLInputElement>('#files')!;
const archive = document.querySelector<HTMLInputElement>('#archive')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
const list = document.querySelector<HTMLUListElement>('#entries')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const save = document.querySelector<HTMLAnchorElement>('#save')!;
let controller: AbortController | undefined;
let downloadUrl: string | undefined;

const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    'section button'
  ))
    button.disabled = true;
  cancel.disabled = false;
  status.textContent = 'Working…';
  try {
    await operation(current.signal);
  } catch (error) {
    status.textContent = current.signal.aborted
      ? 'Cancelled'
      : `Error: ${error instanceof Error ? error.message : error}`;
  } finally {
    controller = undefined;
    cancel.disabled = true;
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      'section button'
    ))
      button.disabled = false;
  }
};

const pack = async (download: boolean) =>
  await run(async (signal) => {
    const selected = Array.from(files.files ?? []);
    if (!selected.length) throw new Error('Select files first');
    let inputBytes = 0;
    const entries = async function* () {
      for (const file of selected) {
        const source = file.stream().pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, output) {
              inputBytes += chunk.length;
              output.enqueue(chunk);
            },
          }),
          { signal }
        );
        yield await createReadableFileItem(
          file.name,
          source,
          { length: file.size, date: new Date(file.lastModified) },
          signal
        );
      }
    };
    const chunks: BlobPart[] = [];
    let bytes = 0;
    await createTarPacker(
      entries(),
      gzip.checked ? 'gzip' : 'none',
      signal
    ).pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          bytes += chunk.length;
          if (download) chunks.push(chunk.slice());
          status.textContent = `Read ${inputBytes} input bytes; wrote ${bytes} archive bytes`;
        },
      }),
      { signal }
    );
    if (download) {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(
        new Blob(chunks, {
          type: gzip.checked ? 'application/gzip' : 'application/x-tar',
        })
      );
      save.href = downloadUrl;
      save.download = gzip.checked ? 'archive.tar.gz' : 'archive.tar';
      save.hidden = false;
    }
    status.textContent = `Complete: ${selected.length} files, ${bytes} archive bytes`;
  });

document.querySelector<HTMLButtonElement>('#pack')!.onclick = async () => {
  await pack(false);
};
document.querySelector<HTMLButtonElement>('#download')!.onclick = async () => {
  await pack(true);
};
cancel.onclick = () => controller?.abort();
document.querySelector<HTMLButtonElement>('#extract')!.onclick = async () => {
  await run(async (signal) => {
    const file = archive.files?.[0];
    if (!file) throw new Error('Select an archive first');
    list.replaceChildren();
    let total = 0;
    for await (const entry of createTarExtractor(
      file.stream(),
      gzip.checked ? 'gzip' : 'none',
      signal
    )) {
      let bytes = 0;
      if (entry.kind === 'file')
        await (
          await entry.getContent('readable')
        ).pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              bytes += chunk.length;
            },
          }),
          { signal }
        );
      const row = document.createElement('li');
      row.textContent = `${entry.path}: ${bytes} bytes`;
      list.append(row);
      total++;
    }
    status.textContent = `Complete: ${total} entries`;
  });
};
