import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import dts from 'vite-plugin-dts';
import screwUp from 'screw-up';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true
    }),
    screwUp()
  ],
  build: {
    lib: {
      entry: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/index.ts'),
      name: 'tar-vern',
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
      formats: ['es', 'cjs']
    },
    rollupOptions: {
      external: ['stream', 'fs', 'fs/promises', 'stream/promises', 'child_process', 'path', 'os', 'zlib']
    },
    sourcemap: true,
    minify: false
  }
});
