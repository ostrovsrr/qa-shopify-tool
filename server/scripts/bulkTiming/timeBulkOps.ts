// Times one bulk operation against K concurrent ones on the SAME store, for both
// customerCreate and customerDelete. Answers: does splitting one store's work
// across Shopify's 5 concurrent bulk-op slots (API 2026-01+) make it faster?
//
//   npx ts-node --transpile-only scripts/bulkTiming/timeBulkOps.ts <storeId> [perGroup=10000] [k=5]
//
// Group A (perGroup customers) is created as ONE op, group B (perGroup) as K ops
// at once. Then B is deleted as K ops and A as one — the reverse order, so any
// warm-up or slow-down at Shopify does not favour one side. Staged uploads happen
// before the clock starts: only Shopify's execution is timed.
//
// Every customer carries `qa-import` plus a run tag, so the tool's own Clean QA
// removes them if this dies midway. Takes no store lock — keep imports off the
// store while it runs.
import 'dotenv/config';
import {
  fetchBulkOperationState,
  runBulkMutation,
  splitIntoBatches,
  stagedUpload,
  TERMINAL_BULK_STATUSES,
} from '../../src/services/shopifyBulk';
import { getShopifyClient, ShopifyClient } from '../../src/services/shopifyClient';

const CREATE_MUTATION =
  'mutation customerCreate($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }';
const DELETE_MUTATION =
  'mutation customerDelete($input: CustomerDeleteInput!) { customerDelete(input: $input) { deletedCustomerId userErrors { field message } } }';
const POLL_MS = 2000;

interface OpResult {
  id: string;
  status: string;
  objectCount: string | null;
  url: string | null;
  ms: number;
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms: number) => `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;

/** Stage every payload, then submit them all at once and poll each to terminal. */
async function runOps(
  client: ShopifyClient,
  label: string,
  mutation: string,
  payloads: string[],
): Promise<{ ops: OpResult[]; wallMs: number }> {
  const paths: string[] = [];
  for (let i = 0; i < payloads.length; i++) {
    paths.push(await stagedUpload(client, payloads[i], `timing-${label}-${i}.jsonl`));
  }
  log(`${label}: staged ${payloads.length} file(s); submitting`);

  const start = Date.now();
  const ops = await Promise.all(
    paths.map(async (path, i) => {
      const id = await runBulkMutation(client, mutation, path);
      const opStart = Date.now();
      for (;;) {
        await sleep(POLL_MS);
        const s = await fetchBulkOperationState(client, id);
        if (TERMINAL_BULK_STATUSES.includes(s.status)) {
          const ms = Date.now() - opStart;
          log(`${label}[${i}] ${s.status} objects=${s.objectCount} in ${fmt(ms)}`);
          return { id, status: s.status, objectCount: s.objectCount, url: s.url, ms };
        }
      }
    }),
  );
  return { ops, wallMs: Date.now() - start };
}

/** Customer ids from a finished customerCreate result file, plus the rejected count. */
async function createdIds(url: string | null): Promise<{ ids: string[]; failed: number }> {
  if (!url) return { ids: [], failed: 0 };
  const text = await (await fetch(url)).text();
  const ids: string[] = [];
  let failed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { data?: { customerCreate?: { customer: { id: string } | null } } };
    const id = row.data?.customerCreate?.customer?.id;
    if (id) ids.push(id);
    else failed++;
  }
  return { ids, failed };
}

/** Lines whose customerDelete came back without an id. */
async function deleteFailures(url: string | null): Promise<number> {
  if (!url) return 0;
  const text = await (await fetch(url)).text();
  return text
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => !(JSON.parse(l) as { data?: { customerDelete?: { deletedCustomerId: string | null } } }).data
      ?.customerDelete?.deletedCustomerId).length;
}

function createLines(group: string, runTag: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      input: {
        firstName: 'Timing',
        lastName: `${group}-${String(i + 1).padStart(5, '0')}`,
        tags: ['qa-import', runTag],
      },
    }),
  );
}

const deleteLines = (ids: string[]) => ids.map((id) => JSON.stringify({ input: { id } }));
const rate = (n: number, ms: number) => `${(n / (ms / 1000)).toFixed(1)}/s`;

async function main() {
  const [storeId, perGroupArg, kArg] = process.argv.slice(2);
  if (!storeId) throw new Error('usage: timeBulkOps.ts <storeId> [perGroup=10000] [k=5]');
  const perGroup = Number(perGroupArg ?? 10000);
  const k = Number(kArg ?? 5);
  const runTag = `qa-timing-${Date.now().toString(36)}`;
  const client = await getShopifyClient(storeId);
  log(`store ${client.shop}, ${perGroup} customers per group, k=${k}, tag ${runTag}`);

  const summary: string[] = [];
  const record = (what: string, n: number, r: { ops: OpResult[]; wallMs: number }) => {
    const line = `${what}: ${n} in ${fmt(r.wallMs)} (${rate(n, r.wallMs)}); ops ${r.ops
      .map((o) => `${o.status} ${fmt(o.ms)}`)
      .join(', ')}`;
    summary.push(line);
    log(line);
  };

  // ── create: A as one op, then B as k ops ───────────────────────────────────
  const aCreate = await runOps(client, 'create-A-x1', CREATE_MUTATION, [
    createLines('A', runTag, perGroup).join('\n'),
  ]);
  record('CREATE  x1', perGroup, aCreate);
  const bCreate = await runOps(
    client,
    `create-B-x${k}`,
    CREATE_MUTATION,
    splitIntoBatches(createLines('B', runTag, perGroup), k).map((b) => b.join('\n')),
  );
  record(`CREATE  x${k}`, perGroup, bCreate);

  const a = await createdIds(aCreate.ops[0].url);
  const bParts = await Promise.all(bCreate.ops.map((o) => createdIds(o.url)));
  const bIds = bParts.flatMap((p) => p.ids);
  log(`created A=${a.ids.length} (rejected ${a.failed}), B=${bIds.length} (rejected ${bParts.reduce((s, p) => s + p.failed, 0)})`);

  // ── delete: B as k ops first, then A as one ────────────────────────────────
  const bDelete = await runOps(
    client,
    `delete-B-x${k}`,
    DELETE_MUTATION,
    splitIntoBatches(bIds, k).map((ids) => deleteLines(ids).join('\n')),
  );
  record(`DELETE  x${k}`, bIds.length, bDelete);
  const aDelete = await runOps(client, 'delete-A-x1', DELETE_MUTATION, [deleteLines(a.ids).join('\n')]);
  record('DELETE  x1', a.ids.length, aDelete);

  const leftover =
    (await Promise.all(bDelete.ops.map((o) => deleteFailures(o.url)))).reduce((s, n) => s + n, 0) +
    (await deleteFailures(aDelete.ops[0].url));
  log(`delete failures: ${leftover}${leftover ? ` -- remove with Clean QA, or by tag ${runTag}` : ''}`);

  console.log('\n=== SUMMARY ===');
  for (const line of summary) console.log(line);
}

main().catch((err) => {
  console.error(`FAILED: ${(err as Error).message}`);
  console.error('Any customers created carry the qa-import tag: the tool\'s Clean QA removes them.');
  process.exit(1);
});
