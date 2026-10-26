import { expect, it } from 'vitest';
import * as api from '../src/index.ts';

it('removes filesystem helpers from the common entry', () => {
  expect(api).not.toHaveProperty('createReadFileItem');
  expect(api).not.toHaveProperty('extractTo');
});

it('removes the buffer content selector', async () => {
  const entries = async function* () {
    yield await api.createFileItem('file', 'data');
  };
  for await (const file of api.createTarExtractor(
    api.createTarPacker(entries())
  )) {
    if (file.kind === 'file') {
      // @ts-expect-error The old selector is intentionally removed in 2.0.0.
      await expect(file.getContent('buffer')).rejects.toThrow(
        /Unsupported content type/
      );
    }
  }
});
