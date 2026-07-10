import fs from 'fs';
import { createWriteStream } from 'fs';
import prisma from './src/db/prisma';
import { streamShopifyVerificationReport } from './src/reports/shopifyVerificationReport';

const OUT = 'C:/Users/RODION~1/AppData/Local/Temp/claude/c--Users-RodionOstrovskii-repos-qa-shopify-tool/2a946d88-9a8e-46ef-b83e-e12e1dfca2ab/scratchpad/import-report.xlsx';
const mb = (b: number) => (b / 1024 / 1024).toFixed(0) + ' MB';

async function main() {
  // Find the biggest customer import run (most rowResults) — that's the one that OOM'd.
  const biggest = await prisma.importRowResult.groupBy({
    by: ['importRunId'],
    _count: { _all: true },
    orderBy: { _count: { importRunId: 'desc' } },
    take: 5,
  });
  console.log('Customer import runs by result count:');
  for (const b of biggest) console.log(`  ${b.importRunId.slice(0,8)}  ${b._count._all} results`);

  const target = biggest[0]?.importRunId;
  if (!target) { console.log('No customer import runs found.'); await prisma.$disconnect(); return; }
  console.log(`\nGenerating verification report for ${target.slice(0,8)} (${biggest[0]._count._all} results)…`);

  let peak = 0;
  const timer = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 100);

  const out = createWriteStream(OUT);
  const start = Date.now();
  let fileName = '';
  await streamShopifyVerificationReport(target, out, (fn) => { fileName = fn; });
  await new Promise<void>((res, rej) => { out.on('finish', res); out.on('error', rej); });
  clearInterval(timer);

  const size = fs.statSync(OUT).size;
  console.log(`\nDONE in ${((Date.now()-start)/1000).toFixed(1)}s  → ${mb(size)}  peak RSS ${mb(peak)}  file="${fileName}"`);

  const { execSync } = require('child_process');
  try { execSync(`unzip -t "${OUT}"`, { stdio: 'ignore' }); console.log('Valid xlsx (zip integrity OK)'); }
  catch { console.log('WARNING: zip integrity failed'); }
  // Sheet names + row counts from the zip (lightweight).
  try {
    const names = execSync(`unzip -p "${OUT}" xl/workbook.xml`).toString().match(/name="[^"]*"/g);
    console.log('Sheets:', names?.join(' '));
  } catch {}

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
