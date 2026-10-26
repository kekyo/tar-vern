import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFile } from 'node:fs/promises';
import dts from 'vite-plugin-dts';
import screwUp from 'screw-up';
import prettierMax from 'prettier-max';

export default defineConfig({
  plugins: [
    prettierMax({
      generatePrettierConfig: false,
    }),
    dts({
      rollupTypes: true,
      async afterBuild() {
        for (const entry of ['index', 'node']) {
          for (const extension of ['d.mts', 'd.cts']) {
            await copyFile(`dist/${entry}.d.ts`, `dist/${entry}.${extension}`);
          }
        }
      },
    }),
    screwUp(),
  ],
  build: {
    lib: {
      entry: { index: resolve('src/index.ts'), node: resolve('src/node.ts') },
      name: 'tar-vern',
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: (id) => id.startsWith('node:'),
      output: [
        {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name]-[hash].mjs',
        },
        {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs',
        },
      ],
    },
    sourcemap: true,
    minify: false,
  },
});
