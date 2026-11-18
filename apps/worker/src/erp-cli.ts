/**
 * The ERPNext copy from the command line (packages/server/src/erp):
 *
 *   pnpm erp:schema --out ../dunhill-erp/objects/fleet/doctypes   write the doctypes as JSON
 *   pnpm erp:sync [--dry-run] [--force] [--reconcile] [--only cars,bookings,fuel,car-months]
 *
 * In production: docker compose -f docker-compose.prod.yml exec worker node dist/erp-cli.js sync --dry-run
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (command === 'schema') {
  // Writing JSON needs no database; give the settings parser what it insists on.
  process.env.DATABASE_URL ??= 'postgresql://unused@localhost/unused';
  process.env.APP_SECRET ??= 'schema-only-not-a-real-secret';
  const { erpSchema } = await import('@carbooking/server');
  const out = value('--out');
  if (!out) throw new Error('usage: erp-cli schema --out DIR');
  mkdirSync(out, { recursive: true });
  erpSchema.allDoctypes().forEach((doc, i) => {
    const path = join(out, `${String(i + 1).padStart(2, '0')}-${doc.name.toLowerCase().replaceAll(' ', '-')}.json`);
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`wrote ${path}`);
  });
} else if (command === 'sync') {
  const { ErpClient, KINDS, reconcileErp, runErpSync, summary, syncToErp } = await import('@carbooking/server');
  const { prisma } = await import('@carbooking/db');
  const only = value('--only')?.split(',').map((k) => {
    if (!KINDS[k]) throw new Error(`unknown: ${k}; use ${Object.keys(KINDS).join(', ')}`);
    return KINDS[k]!;
  });
  const client = ErpClient.fromEnv();
  const dryRun = flag('--dry-run');
  const report = dryRun
    ? flag('--reconcile')
      ? await reconcileErp(client, { dryRun })
      : await syncToErp(client, { dryRun, doctypes: only, force: flag('--force') })
    : // a real run also updates ERPNext's status card and Fleet's admin banner
      await runErpSync(client, { full: flag('--reconcile'), doctypes: only, force: flag('--force') });
  console.log((dryRun ? 'Dry run: ' : '') + summary(report));
  await prisma.$disconnect();
  process.exitCode = report.failed ? 1 : 0;
} else {
  console.error('usage: erp-cli schema --out DIR | erp-cli sync [--dry-run] [--force] [--reconcile] [--only cars,bookings,fuel,car-months]');
  process.exitCode = 2;
}
