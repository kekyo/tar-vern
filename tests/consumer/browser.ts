import {
  createBlobFileItem,
  createTarPacker,
  createTarExtractor,
} from 'tar-vern';

export const roundTrip = async (file: File): Promise<Uint8Array[]> => {
  const items = async function* () {
    yield await createBlobFileItem(file.name, file);
  };
  const stream: ReadableStream<Uint8Array> = createTarPacker(items(), 'gzip');
  const contents: Uint8Array[] = [];
  for await (const entry of createTarExtractor(stream, 'gzip')) {
    if (entry.kind === 'file') contents.push(await entry.getContent('bytes'));
  }
  return contents;
};
