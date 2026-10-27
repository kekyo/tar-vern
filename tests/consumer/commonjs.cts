import tar = require('tar-vern');
import filesystem = require('tar-vern/node');

export const writeArchive = async (path: string): Promise<void> => {
  const entries = async function* () {
    yield await tar.createFileItem('text', 'typed CJS');
  };
  await filesystem.storeReaderToFile(tar.createTarPacker(entries()), path);
};
