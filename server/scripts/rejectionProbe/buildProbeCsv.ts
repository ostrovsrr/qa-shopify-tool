// Writes sample/product-rejection-probe.csv from the probe cases (cases.ts). The
// same file goes to BOTH importers:
//   • the admin CSV import (Products → Import; errors arrive by email as "Row N: ...")
//   • productSet, via probeProductSet.ts (userErrors with a full field path)
//
//   npx ts-node scripts/rejectionProbe/buildProbeCsv.ts
//
// The admin import refuses the WHOLE file at upload for 'refuses-file' cases, so
// leave those out to see the per-product email errors for the rest:
//   SKIP=refuses-file OUT=../x.csv npx ts-node ...   (skip by verdict)
//   SKIP=price-text,cost-text ...                    (skip by slug)
//   ONLY=<slug> ...                                   (a single-case file)
import fs from 'fs';
import path from 'path';
import { CASES, renderProbeCsv } from './cases';

const skip = new Set((process.env.SKIP ?? '').split(',').filter(Boolean));
const only = process.env.ONLY;
const cases = CASES.filter(
  (c) => !skip.has(c.slug) && !skip.has(c.admin) && (!only || c.slug === only),
);

const target = path.resolve(process.env.OUT ?? path.resolve(__dirname, '../../../sample/product-rejection-probe.csv'));
const { csv, lines } = renderProbeCsv(cases);
fs.writeFileSync(target, csv, 'utf8');
console.log(`Wrote ${target}`);
for (const l of lines) {
  console.log(`  line ${String(l.line).padStart(2)}  ${l.handle}  → ${l.c.admin}${l.c.says ? `: ${l.c.says}` : ''}`);
}
