import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { cli: 'apps/cli/src/index.ts', server: 'apps/daemon/src/server.ts' },
  format: ['esm'],
  outDir: 'dist',
  target: 'node24',
  sourcemap: true,
  splitting: false,
  clean: true,
});
