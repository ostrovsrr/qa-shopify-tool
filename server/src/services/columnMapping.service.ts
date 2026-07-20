import { HttpError } from '../errors';

export const SHOPIFY_COLUMNS = [
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Accepts Email Marketing',
  'Accepts SMS Marketing',
  'Tags',
  'Note',
  'Tax Exempt',
  'Default Address Company',
  'Default Address Address1',
  'Default Address Address2',
  'Default Address City',
  'Default Address Province Code',
  'Default Address Country Code',
  'Default Address Zip',
  'Default Address Phone',
] as const;

export type ShopifyColumn = (typeof SHOPIFY_COLUMNS)[number];

// Append targets: not real Shopify columns, but mapping directives. A source
// column mapped to one of these has its value appended to the Tags/Note field
// instead of replacing a column. Multiple source columns may use the same
// append target.
export const APPEND_TO_TAGS = 'Add to Tags';
export const APPEND_TO_NOTE = 'Add to Note';

// Pass-through directive: the source column is carried into the Shopify
// Template as-is, under its original name. Multiple columns can be kept.
export const KEEP_COLUMN = 'Keep';

const TAGS_SEPARATOR = ',';
const NOTE_SEPARATOR = ' | ';

/**
 * Apply a column mapping to a single record (CSV-header-keyed → Shopify-column-keyed).
 * Unmapped keys are kept under their original name. Sources mapped to
 * "Add to Tags" / "Add to Note" are appended (in CSV column order) to the
 * Tags / Note fields rather than becoming columns of their own; empty values
 * are skipped.
 */
export function applyMappingToRecord(
  record: Record<string, string>,
  mapping: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const tagAppends: string[] = [];
  const noteAppends: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const target = mapping[key] ?? key;
    if (target === APPEND_TO_TAGS || target === APPEND_TO_NOTE) {
      const trimmed = (value ?? '').trim();
      if (trimmed) (target === APPEND_TO_TAGS ? tagAppends : noteAppends).push(trimmed);
      continue;
    }
    // "Keep" passes the column through under its original name. Trim on the way
    // through: leading/trailing whitespace in a source cell is never meaningful to
    // Shopify, so we clean it here rather than flag it. Both the test-store import
    // and the "Shopify Template" report sheet build from this one function, so the
    // cleaned value is what gets imported AND what the report shows — in lockstep.
    out[target === KEEP_COLUMN ? key : target] = (value ?? '').trim();
  }
  if (tagAppends.length > 0) {
    out['Tags'] = [(out['Tags'] ?? '').trim(), ...tagAppends].filter(Boolean).join(TAGS_SEPARATOR);
  }
  if (noteAppends.length > 0) {
    out['Note'] = [(out['Note'] ?? '').trim(), ...noteAppends].filter(Boolean).join(NOTE_SEPARATOR);
  }
  return out;
}

/** The real Shopify column an append target feeds into; non-append targets pass through. */
export function resolveMappingTarget(target: string): string {
  if (target === APPEND_TO_TAGS) return 'Tags';
  if (target === APPEND_TO_NOTE) return 'Note';
  return target;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s\-_()./]/g, '');
}

// Normalized source name → Shopify target column
const ALIAS_MAP: Record<string, ShopifyColumn> = {
  // Email
  email: 'Email',
  emailaddress: 'Email',
  customeremail: 'Email',
  emailid: 'Email',
  // Phone
  phone: 'Phone',
  phonenumber: 'Phone',
  mobile: 'Phone',
  mobilenumber: 'Phone',
  cellphone: 'Phone',
  cell: 'Phone',
  telephone: 'Phone',
  tel: 'Phone',
  // First Name
  firstname: 'First Name',
  fname: 'First Name',
  givenname: 'First Name',
  // Last Name
  lastname: 'Last Name',
  lname: 'Last Name',
  surname: 'Last Name',
  familyname: 'Last Name',
  // Accepts Email Marketing
  acceptsemailmarketing: 'Accepts Email Marketing',
  emailmarketing: 'Accepts Email Marketing',
  emailsubscribed: 'Accepts Email Marketing',
  emailoptin: 'Accepts Email Marketing',
  marketingemail: 'Accepts Email Marketing',
  // Accepts SMS Marketing
  acceptssmsmarketing: 'Accepts SMS Marketing',
  smsmarketing: 'Accepts SMS Marketing',
  smssubscribed: 'Accepts SMS Marketing',
  smsoptin: 'Accepts SMS Marketing',
  marketingsms: 'Accepts SMS Marketing',
  // Tags
  tags: 'Tags',
  tag: 'Tags',
  customertags: 'Tags',
  // Note
  note: 'Note',
  notes: 'Note',
  comments: 'Note',
  comment: 'Note',
  // Tax Exempt
  taxexempt: 'Tax Exempt',
  taxexemption: 'Tax Exempt',
  istaxexempt: 'Tax Exempt',
  // Default Address Address1
  address1: 'Default Address Address1',
  address: 'Default Address Address1',
  streetaddress: 'Default Address Address1',
  street: 'Default Address Address1',
  addressline1: 'Default Address Address1',
  defaultaddressaddress1: 'Default Address Address1',
  // Default Address Address2
  address2: 'Default Address Address2',
  addressline2: 'Default Address Address2',
  apt: 'Default Address Address2',
  suite: 'Default Address Address2',
  unit: 'Default Address Address2',
  defaultaddressaddress2: 'Default Address Address2',
  // Default Address City
  city: 'Default Address City',
  town: 'Default Address City',
  defaultaddresscity: 'Default Address City',
  // Default Address Province Code
  province: 'Default Address Province Code',
  state: 'Default Address Province Code',
  region: 'Default Address Province Code',
  provincecode: 'Default Address Province Code',
  statecode: 'Default Address Province Code',
  stateabbreviation: 'Default Address Province Code',
  stateabbr: 'Default Address Province Code',
  defaultaddressprovincecode: 'Default Address Province Code',
  // Default Address Country Code
  country: 'Default Address Country Code',
  countryname: 'Default Address Country Code',
  nation: 'Default Address Country Code',
  countrycode: 'Default Address Country Code',
  countryabbreviation: 'Default Address Country Code',
  countryabbr: 'Default Address Country Code',
  defaultaddresscountrycode: 'Default Address Country Code',
  // Default Address Zip
  zip: 'Default Address Zip',
  zipcode: 'Default Address Zip',
  postalcode: 'Default Address Zip',
  postcode: 'Default Address Zip',
  postal: 'Default Address Zip',
  defaultaddresszip: 'Default Address Zip',
  // Default Address Company
  company: 'Default Address Company',
  companyname: 'Default Address Company',
  organization: 'Default Address Company',
  businessname: 'Default Address Company',
  employer: 'Default Address Company',
  defaultaddresscompany: 'Default Address Company',
  // Default Address Phone
  defaultaddressphone: 'Default Address Phone',
};

const SHOPIFY_SET = new Set<string>(SHOPIFY_COLUMNS);
const ALLOWED_TARGETS = new Set<string>([
  ...SHOPIFY_COLUMNS,
  APPEND_TO_TAGS,
  APPEND_TO_NOTE,
  KEEP_COLUMN,
]);

/** Reject mappings that reference unknown columns or silently overwrite a field. */
export function assertValidColumnMapping(
  headers: string[],
  mapping: Record<string, string>,
): void {
  const headerSet = new Set(headers);
  const targetOwners = new Map<string, string>();

  for (const [source, target] of Object.entries(mapping)) {
    if (!headerSet.has(source)) {
      throw new HttpError(400, `Column mapping refers to unknown source column "${source}".`);
    }
    if (!ALLOWED_TARGETS.has(target)) {
      throw new HttpError(400, `"${target || '(empty)'}" is not a valid column-mapping target.`);
    }

    // Append and Keep are deliberately many-to-one directives. Every real
    // Shopify field is scalar and must have exactly one source owner.
    if (target === APPEND_TO_TAGS || target === APPEND_TO_NOTE || target === KEEP_COLUMN) {
      continue;
    }
    const previous = targetOwners.get(target);
    if (previous) {
      throw new HttpError(
        400,
        `Both "${previous}" and "${source}" are mapped to "${target}". Choose one source column to avoid overwriting customer data.`,
      );
    }
    targetOwners.set(target, source);
  }
}

export function suggestMapping(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    if (SHOPIFY_SET.has(header)) {
      result[header] = header;
      continue;
    }
    const key = normalize(header);
    if (ALIAS_MAP[key]) {
      result[header] = ALIAS_MAP[key];
    }
  }
  return result;
}
