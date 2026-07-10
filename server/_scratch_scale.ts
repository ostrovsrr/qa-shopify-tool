import prisma from './src/db/prisma';
async function main() {
  const runs = await prisma.productImportRun.findMany({
    orderBy: { createdAt: 'desc' }, take: 10,
    select: { id: true, uploadId: true, status: true, successCount: true, errorCount: true },
  });
  console.log('recent runs:');
  runs.forEach(r => console.log(' ', r.id, r.status, `ok=${r.successCount} err=${r.errorCount}`));
  const run = runs.find(r => r.id.startsWith('835556be')) ?? runs.find(r => r.status === 'COMPLETED') ?? runs[0];
  if (!run) { await prisma.$disconnect(); return; }
  console.log('\nusing run', run.id, 'upload', run.uploadId);
  const originalRows = await prisma.productOriginalRow.count({ where: { uploadRunId: run.uploadId } });
  const rowResults = await prisma.productImportResult.count({ where: { importRunId: run.id } });
  const sample = await prisma.productOriginalRow.findFirst({ where: { uploadRunId: run.uploadId }, select: { data: true } });
  const cols = sample?.data && typeof sample.data === 'object' ? Object.keys(sample.data as object).length : 0;
  const bytes = sample ? Buffer.byteLength(JSON.stringify(sample.data)) : 0;
  console.log(`originalRows=${originalRows}  rowResults=${rowResults}  cols=${cols}  bytesPerRow=${bytes}`);
  console.log(`raw JSON estimate: ${((originalRows*bytes)/1024/1024).toFixed(0)} MB (x2-4 live)`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
