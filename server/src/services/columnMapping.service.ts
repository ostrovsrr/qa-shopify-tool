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
