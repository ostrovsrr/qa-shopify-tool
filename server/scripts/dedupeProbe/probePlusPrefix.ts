// Does a "+" in front of a duplicate email or phone get Shopify to accept the
// customer instead of rejecting it as "has already been taken"? Creates one base
// customer, then a duplicate per variant, through the same customerCreate the
// import sends, and prints each verdict plus the value Shopify actually stored.
// Everything created is tagged qa-probe and deleted at the end.
//
//   npx ts-node --transpile-only scripts/dedupeProbe/probePlusPrefix.ts <storeId>
import 'dotenv/config';
import { getShopifyClient } from '../../src/services/shopifyClient';

const CREATE =
  'mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id email phone } userErrors { field message } } }';

interface Created { id: string; email: string | null; phone: string | null }
interface UserError { field: string[] | null; message: string }

async function main() {
  const [storeId] = process.argv.slice(2);
  if (!storeId) throw new Error('usage: probePlusPrefix.ts <storeId>');
  const client = await getShopifyClient(storeId);

  // Synthetic, unique per run so a crashed earlier run cannot collide.
  const n = String(Date.now()).slice(-7);
  const email = `probe${n}@example.com`;
  const local = `416${n}`; // 10-digit NANP, no country code
  const phone = `+1${local}`;

  const created: string[] = [];
  const create = async (label: string, input: Record<string, unknown>) => {
    const data = await client.query<{ customerCreate: { customer: Created | null; userErrors: UserError[] } }>(
      CREATE,
      { input: { firstName: 'Probe', lastName: label, tags: ['qa-probe'], ...input } },
    );
    const { customer, userErrors } = data.customerCreate;
    if (customer) created.push(customer.id);
    const sent = JSON.stringify(input);
    if (customer) {
      console.log(`ACCEPTED  ${label.padEnd(26)} sent=${sent}  stored email=${customer.email} phone=${customer.phone}`);
    } else {
      console.log(`REJECTED  ${label.padEnd(26)} sent=${sent}`);
      for (const e of userErrors) console.log(`          field=${JSON.stringify(e.field)}  ${e.message}`);
    }
  };

  try {
    await create('base', { email, phone });

    console.log('\n-- email duplicates (no phone) --');
    await create('email exact', { email });
    await create('email +leading', { email: `+${email}` });
    await create('email + before @', { email: email.replace('@', '+@') });
    await create('email +dup subaddress', { email: email.replace('@', '+dup@') });
    await create('email UPPER', { email: email.toUpperCase() });

    console.log('\n-- phone duplicates (no email) --');
    await create('phone exact', { phone });
    await create('phone ++', { phone: `+${phone}` });
    await create('phone no +, with 1', { phone: `1${local}` });
    await create('phone no +, 10 digit', { phone: local });
    await create('phone +10 digit', { phone: `+${local}` });
  } finally {
    const left = await client.query<{ customers: { nodes: { id: string }[] } }>(
      '{ customers(first: 250, query: "tag:qa-probe") { nodes { id } } }',
    );
    for (const { id } of left.customers.nodes) if (!created.includes(id)) created.push(id);
    for (const id of created) {
      await client.query('mutation($input: CustomerDeleteInput!) { customerDelete(input: $input) { userErrors { message } } }', {
        input: { id },
      });
    }
    console.log(`\nDeleted ${created.length} customer(s) the probe created.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
