// Bundle the API (and the workspace packages it uses) into dist/. Third-party
// packages stay external and are installed in production as usual.
import { build } from 'esbuild';

// `node ../api/build.mjs --worker` from apps/worker builds the worker the same way.
import { existsSync } from 'node:fs';

await build({
  // The worker also ships its ERPNext command line (src/erp-cli.ts).
  entryPoints: ['src/index.ts', ...(existsSync('src/erp-cli.ts') ? ['src/erp-cli.ts'] : [])],
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
