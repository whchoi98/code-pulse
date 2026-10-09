import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await viteBuild();
await build({
  entryPoints: ['src/server/index.ts', 'src/collector/run.ts'],
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
await build({
  entryPoints: ['tools/publish-site.ts'],
  outfile: 'dist/publishing/run.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
});
