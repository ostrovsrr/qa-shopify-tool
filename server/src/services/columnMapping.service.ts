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
  'Address1',
  'Address2',
  'City',
  'Province',
  'Province Code',
  'Country',
  'Country Code',
  'Zip',
  'Company',
  'Total Spent',
  'Total Orders',
] as const;

export type ShopifyColumn = (typeof SHOPIFY_COLUMNS)[number];

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
  // Address1
  address1: 'Address1',
  address: 'Address1',
  streetaddress: 'Address1',
  street: 'Address1',
  addressline1: 'Address1',
  // Address2
  address2: 'Address2',
  addressline2: 'Address2',
  apt: 'Address2',
  suite: 'Address2',
  unit: 'Address2',
  // City
  city: 'City',
  town: 'City',
  // Province
  province: 'Province',
  state: 'Province',
  region: 'Province',
  // Province Code
  provincecode: 'Province Code',
  statecode: 'Province Code',
  stateabbreviation: 'Province Code',
  stateabbr: 'Province Code',
  // Country
  country: 'Country',
  countryname: 'Country',
  nation: 'Country',
  // Country Code
  countrycode: 'Country Code',
  countryabbreviation: 'Country Code',
  countryabbr: 'Country Code',
  // Zip
  zip: 'Zip',
  zipcode: 'Zip',
  postalcode: 'Zip',
  postcode: 'Zip',
  postal: 'Zip',
  // Company
  company: 'Company',
  companyname: 'Company',
  organization: 'Company',
  businessname: 'Company',
  employer: 'Company',
  // Total Spent
  totalspent: 'Total Spent',
  amountspent: 'Total Spent',
  lifetimespend: 'Total Spent',
  // Total Orders
  totalorders: 'Total Orders',
  ordercount: 'Total Orders',
  numberoforders: 'Total Orders',
  numorders: 'Total Orders',
};

const SHOPIFY_SET = new Set<string>(SHOPIFY_COLUMNS);

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
