import fs from 'fs';
import { createWriteStream } from 'fs';
import prisma from './src/db/prisma';
import { streamProductImportReport } from './src/reports/productImportReport';

const OUT = process.env.OUT ?? 'C:/Users/RODION~1/AppData/Local/Temp/claude/c--Users-RodionOstrovskii-repos-qa-shopify-tool/2a946d88-9a8e-46ef-b83e-e12e1dfca2ab/scratchpad/product-report.xlsx';

const mb = (b: number) => (b / 1024 / 1024).toFixed(0) + ' MB';

async function main() {
  // Show the state of product import runs so we can answer the recovery question.
  const runs = await prisma.productImportRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: {
      id: true, status: true, successCount: true, errorCount: true, createdAt: true,
      _count: { select: { rowResults: true, batchJobs: true } },
    },
  });
  console.log('Recent product import runs:');
  for (const r of runs) {
    console.log(`  ${r.id.slice(0,8)}  ${r.status.padEnd(10)}  ok=${r.successCount} err=${r.errorCount}  rowResults=${r._count.rowResults}  jobs=${r._count.batchJobs}  ${r.createdAt.toISOString()}`);
  }

  // Pick the run with the most rowResults to stress the report.
  const biggest = await prisma.productImportResult.groupBy({
    by: ['importRunId'],
    _count: { _all: true },
    orderBy: { _count: { importRunId: 'desc' } },
    take: 1,
  });
  const target = biggest[0]?.importRunId ?? runs[0]?.id;
  if (!target) { console.log('No product import runs to test.'); await prisma.$disconnect(); return; }
  console.log(`\nGenerating report for run ${target.slice(0,8)} (${biggest[0]?._count._all ?? '?'} results)…`);

  let peakRss = 0;
  const timer = setInterval(() => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; }, 100);

  const out = createWriteStream(OUT);
  const start = Date.now();
  await streamProductImportReport(target, out, () => { /* headers no-op */ });
  await new Promise<void>((res, rej) => { out.on('finish', res); out.on('error', rej); });
  clearInterval(timer);

  const size = fs.statSync(OUT).size;
  console.log(`\nDONE in ${((Date.now()-start)/1000).toFixed(1)}s → ${mb(size)}   peak RSS ${mb(peakRss)}`);

  // Prove it's a valid zip/xlsx.
  const { execSync } = require('child_process');
  try {
    execSync(`unzip -t "${OUT}"`, { stdio: 'ignore' });
    console.log('Valid xlsx (zip integrity OK)');
  } catch { console.log('WARNING: zip integrity check failed'); }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
