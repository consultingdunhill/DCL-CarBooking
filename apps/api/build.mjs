// Bundle the API (and the workspace packages it uses) into dist/. Third-party
// packages stay external and are installed in production as usual.
import { build } from 'esbuild';

// `node ../api/build.mjs --worker` from apps/worker builds the worker the same way.
await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  plugins: [
    {
      name: 'externalize-deps',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('@carbooking/') ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
console.log(`Built ${process.cwd()}/dist`);
