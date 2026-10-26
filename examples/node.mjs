import {
  createFileItem,
  createTarPacker,
  createTarExtractor,
} from '../dist/index.mjs';

const entries = async function* () {
  yield await createFileItem('hello.txt', 'Hello from tar-vern!');
};

for await (const entry of createTarExtractor(createTarPacker(entries()))) {
  if (entry.kind === 'file') {
    console.log(`${entry.path}: ${await entry.getContent('string')}`);
  }
}
