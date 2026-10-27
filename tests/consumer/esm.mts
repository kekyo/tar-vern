import { createFileItem, createTarPacker } from 'tar-vern';
import { storeReaderToFile, createReadDirectoryItem } from 'tar-vern/node';

export const writeArchive = async (path: string): Promise<void> => {
  const entries = async function* () {
    yield await createReadDirectoryItem('folder', '.');
    yield await createFileItem('text', 'typed ESM');
  };
  await storeReaderToFile(createTarPacker(entries()), path);
};
