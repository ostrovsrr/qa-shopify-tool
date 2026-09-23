// Sends each product of a CSV through the SAME builder the import uses
// (buildProductSetInput) and prints Shopify's raw productSet userErrors with the
// FULL field path. The import keeps only the last path segment; this shows what
// is thrown away. Products Shopify accepts are deleted again at the end.
//
//   npx ts-node scripts/rejectionProbe/probeProductSet.ts <csv> <storeId> [out.json]
import 'dotenv/config';
import fs from 'fs';
import { parseProductCsvFile } from '../../src/services/productCsvParser';
import { buildProductSetInput, PRODUCT_SET_MUTATION } from '../../src/services/productImport.service';
import { getShopifyClient } from '../../src/services/shopifyClient';

interface UserError { code: string | null; field: string[] | null; message: string }

async function main() {
  const [csvPath, storeId, outPath] = process.argv.slice(2);
  if (!csvPath || !storeId) throw new Error('usage: probeProductSet.ts <csv> <storeId> [out.json]');

  const { groups } = await parseProductCsvFile(csvPath);
  const client = await getShopifyClient(storeId);

  const results: unknown[] = [];
  const created: string[] = [];
  for (const group of groups) {
    const input = buildProductSetInput(group, 'probe');
    let product: { id: string } | null = null;
    let userErrors: UserError[];
    try {
      const data = await client.query<{
        productSet: { product: { id: string } | null; userErrors: UserError[] };
      }>(PRODUCT_SET_MUTATION, { input });
      ({ product, userErrors } = data.productSet);
    } catch (err) {
      // A value that fails GraphQL type coercion (price "abc") never reaches
      // productSet: the whole request errors. In a bulk run this is the line's
      // top-level error instead of a userError.
      userErrors = [{ code: 'TOP_LEVEL_GRAPHQL_ERROR', field: null, message: (err as Error).message }];
    }
    if (product) created.push(product.id);
    results.push({
      handle: group.handle,
      csvLines: group.rows.map((r) => r.rowNumber),
      accepted: userErrors.length === 0 && !!product,
      userErrors,
    });
    const verdict = userErrors.length === 0 ? 'ACCEPTED' : 'REJECTED';
    console.log(`${verdict.padEnd(9)} ${group.handle}  (lines ${group.rows.map((r) => r.rowNumber).join(',')})`);
    for (const e of userErrors) {
      console.log(`          ${e.code ?? '(no code)'}  field=${JSON.stringify(e.field)}  ${e.message}`);
    }
  }

  if (outPath) fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  // Leave the store as we found it: everything tagged qa-probe (also catches
  // products an earlier, crashed run left behind).
  const left = await client.query<{ products: { nodes: { id: string }[] } }>(
    '{ products(first: 250, query: "tag:qa-probe") { nodes { id } } }',
  );
  for (const { id } of left.products.nodes) if (!created.includes(id)) created.push(id);
  for (const id of created) {
    const del = await client.query<{ productDelete: { userErrors: { message: string }[] } }>(
      'mutation($id: ID!) { productDelete(input: { id: $id }) { userErrors { message } } }',
      { id },
    );
    if (del.productDelete.userErrors.length > 0) {
      console.warn(`Could not delete ${id}: ${del.productDelete.userErrors[0].message}`);
    }
  }
  console.log(`\nDeleted ${created.length} product(s) the probe created.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
