# Shopify CSV QA Tool

An internal tool for validating Shopify Customer CSV files before import. Upload a CSV, map its columns to Shopify fields, run 15 validation rules, and download an Excel report with an import-ready Shopify Template sheet.

---

## Features

- **Upload & preview** — upload a Customer CSV (up to 100 MB), preview headers and sample rows
- **Column mapping** — map arbitrary source columns to Shopify fields, with auto-suggested mappings for common header names. Special mapping directives:
  - **Add to Tags** — appends the column's value to Tags (comma-separated); multiple columns can be appended
  - **Add to Note** — appends the column's value to Note (`" | "`-separated); multiple columns can be appended
  - **Keep (as-is)** — carries the column into the Shopify Template sheet unchanged, under its original name
- **15 validation rules** covering contacts, emails, phones, addresses, postal/province codes, tags, consent fields, HTML injection, and more
- **Merge matching duplicates** (optional, per run) — duplicate rows whose names also match (exactly, case-insensitive, non-empty) are merged into one customer in the Shopify Template: most-filled row wins, empty fields fill from the others, tags union, notes concatenate, and consent/tax-exempt are never escalated to TRUE by a merge; a "Merged From Rows" column keeps the audit trail
- **Move duplicates to Note** (optional, per run) — for each *remaining* duplicate email/phone group (runs after merging), the most-filled row keeps the value; the others get it cleared, appended to their Note, and tagged `DuplicateEmailNotes` / `DuplicatePhoneNotes` so Shopify accepts them on import and they stay filterable in admin
- **HeliosMigrated tag** (optional, per run) — appends a `HeliosMigrated` tag to every row in the template
- **Excel report** — Summary, Errors, Warnings, Full Uploaded File, and a **Shopify Template** sheet (mapped columns in Shopify order, duplicate-group markers, auto-fix highlights)
- **Validation history** — recent runs with editable ticket number/name and comments
- **Test-store import & feedback loop** (optional) — bulk-import a validated run into one or more Shopify test stores via the Bulk Operations API, diff Shopify's real accept/reject results against the validators, and download a validator-gap feedback report. Includes parallel multi-store batches and one-click cleanup of imported QA customers.

---

## Prerequisites

- **Node.js** 20.19+
- **PostgreSQL** 14+ running locally (or any accessible PostgreSQL instance)

---

## Local Setup

### 1. Clone and install

```bash
# Server
cd server
npm install

# Client
cd ../client
npm install
```

### 2. Configure the server environment

```bash
cd server
cp .env.example .env
```

Edit `.env` and set your PostgreSQL connection string:

```
DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/shopify_csv_qa"
PORT=3001
CLIENT_URL=http://localhost:5173
```

The Shopify variables in `.env.example` are **optional** — only needed for the
test-store import feature. Three configuration styles are supported (JSON array,
numbered vars, or a legacy single store); see the comments in `.env.example`.
`GET /api/shopify/health` reports configuration and scope problems.

### 3. Set up the database

```bash
cd server

# Generate the Prisma client
npm run prisma:generate

# Apply migrations
npm run prisma:migrate
```

### 4. Start the development servers

Open two terminals:

**Terminal 1 — Server:**
```bash
cd server
npm run dev
```

**Terminal 2 — Client:**
```bash
cd client
npm run dev
```

The app will be available at **http://localhost:5173**.

---

## Workflow

1. **Upload** a CSV — the server parses it and returns headers + sample rows
2. **Map columns** to Shopify fields (auto-suggestions are pre-filled); choose the per-run options (HeliosMigrated tag, Merge matching duplicates, Move duplicates to Note)
3. **Validate** — all 15 rules run against the mapped rows; results persist to PostgreSQL
4. **Review** issues in the dashboard, or open past runs from History
5. **Download** the Excel report — the Shopify Template sheet is the import-ready output
6. *(Optional)* **Import into a test store** to compare Shopify's real accept/reject behavior against the validators

---

## Duplicate Handling (Shopify Template sheet)

Shopify rejects a customer import row whose email or phone is already taken, so
duplicates in the source file need a decision before import. Two per-run options
(both off by default, chosen on the mapping screen) handle them. They only
affect the **Shopify Template** sheet of the Excel report — the validators
always report what's really in the source file, and the test-store import is
untouched.

### Merge matching duplicates

Collapses rows that are *the same person* into one customer.

- **When rows merge:** they share a normalized **email** (trimmed,
  case-insensitive) *or* a normalized **phone** (digits only, NANP country code
  stripped — `+1 (416) 555-0000` equals `416-555-0000`), **and** their names
  also match (First + Last, case/whitespace-insensitive, and **non-empty** —
  two nameless rows sharing an email never merge, since that usually means a
  placeholder email, not one person). A matching name alone is never enough.
- **How fields combine:** the most-filled row is the keeper (ties → earliest
  row). The keeper's non-empty values win; its empty fields fill from the
  absorbed rows in row order. Tags are unioned (case-insensitive), Notes are
  concatenated with `" | "`.
- **Consent is never escalated:** Accepts Email/SMS Marketing and Tax Exempt
  end up TRUE only if *every* row that specified the field agreed; any conflict
  resolves to FALSE.
- **Audit trail:** a "Merged From Rows" column lists the CSV row numbers each
  keeper absorbed. The Full Uploaded File sheet always retains every original
  row. Transitive chains collapse too (A=B by email, B=C by phone, same name →
  one customer).

### Move duplicates to Note

A lossless fallback for duplicates that *remain* — different people sharing a
contact. Within each remaining duplicate group, the most-filled row keeps the
email/phone; every other row gets the duplicated value cleared, appended to its
Note (`Duplicate email: … | Duplicate phone: …`), and tagged
`DuplicateEmailNotes` / `DuplicatePhoneNotes` so the affected customers are
filterable in Shopify admin after import. Only the duplicated field is
stripped — an email-only duplicate keeps its phone, and vice versa.

### Both options together

Order is always **merge first, then move to Note**: same-person duplicates
collapse, duplicate groups are recomputed on the surviving rows (a merged
keeper competes with its post-merge, fuller record), and only the genuinely
distinct people who still share a contact go through the move-to-Note path.
The result is unique by email and by phone *within the file* — collisions with
customers already in the store are out of scope for a CSV-only tool.

---

## API Endpoints

### Customer validation

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/customer-validation/preview` | Upload a CSV, get headers + sample rows + suggested mapping |
| `POST` | `/api/customer-validation/validate` | Validate a previewed upload with a column mapping |
| `POST` | `/api/customer-validation/upload` | Upload and validate in one step (no mapping; legacy) |
| `GET` | `/api/customer-validation/history` | List recent validation runs |
| `GET` | `/api/customer-validation/report/:id` | Download the Excel report |
| `GET` | `/api/customer-validation/:id` | Get a validation run by ID |
| `PATCH` | `/api/customer-validation/:id/metadata` | Update ticket number/name and comments |
| `DELETE` | `/api/customer-validation/:id` | Delete a validation run |

### Test-store import (optional feature)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/shopify/health` | Check Shopify configuration and token scopes |
| `GET` | `/api/shopify/stores` | List configured test stores |
| `GET` | `/api/shopify/stores/:storeId/stats` | Customer stats for a store |
| `POST` | `/api/shopify/stores/:storeId/cleanup-qa` | Delete all `qa-import`-tagged customers |
| `POST` | `/api/customer-import/:validationId/run` | Import a validated run into one store (async) |
| `POST` | `/api/customer-import/:validationId/run-batch` | Import in parallel across multiple stores |
| `GET` | `/api/customer-import/:id` | Poll import status / results |
| `GET` | `/api/customer-import/:id/report` | Excel verification report (Shopify results vs CSV) |
| `GET` | `/api/customer-import/:id/feedback-report` | Markdown validator-gap report |
| `GET` | `/api/customer-import/feedback` | Aggregated rule-gap backlog |
| `POST` | `/api/customer-import/:id/cleanup` | Delete the customers created by one import run |

---

## Validation Rules

| Rule | Severity | Description |
|------|----------|-------------|
| MissingContactRule | Error | Both Email and Phone are missing |
| InvalidEmailRule | Error | Email exists but is not a valid format |
| DuplicateEmailRule | Error | Same email appears more than once (case-insensitive) |
| InvalidPhoneRule | Error / Warning | Too few digits or suspicious characters |
| DuplicatePhoneRule | Error | Same normalized phone appears more than once (NANP country code normalized) |
| MarketingConsentRule | Error | Invalid value for Accepts Email/SMS Marketing |
| TaxExemptRule | Error | Invalid value for Tax Exempt |
| AddressCompletenessRule | Error / Warning | Missing Country, City, or Province for address rows |
| PostalCodeRule | Warning | Invalid Canadian or US postal code format |
| ProvinceCodeRule | Error | Invalid province/state code for the row's country |
| TagsRule | Error / Warning | Duplicate commas, leading/trailing commas, empty tags, duplicate tags |
| NumericFieldsRule | Warning | Non-numeric or negative Total Spent / Total Orders |
| WhitespaceRule | Warning | Leading or trailing spaces in important fields |
| HtmlInjectionRule | Error | HTML markup in text fields |
| LongNoteRule | Warning | Note field exceeds 500 characters |

---

## Project Structure

```
shopify-csv-qa/
├── client/               # React + Vite + TypeScript frontend
│   └── src/
│       ├── api/          # API client functions
│       ├── components/   # UI components (upload, mapping, issues, history, import panel)
│       ├── pages/        # Page components
│       └── types/        # Shared TypeScript types
├── server/               # Node.js + Express + TypeScript backend
│   ├── prisma/           # Prisma schema and migrations
│   ├── test/             # Vitest unit + integration tests
│   └── src/
│       ├── controllers/  # HTTP request handlers
│       ├── db/           # Prisma client singleton
│       ├── reports/      # Excel/Markdown report generators
│       ├── services/     # Business logic (parsing, mapping, validation, Shopify import)
│       ├── types/        # TypeScript types
│       ├── utils/        # Utility helpers
│       └── validators/   # Validation rules (one file per rule)
│           └── customer/
└── sample/               # Sample Shopify Customer CSV for testing
```

---

## Adding New Validation Rules

1. Create a new file in `server/src/validators/customer/myRule.rule.ts`
2. Implement the `CustomerValidationRule` interface:
   ```typescript
   import { CustomerCsvRow, CustomerValidationIssue, CustomerValidationRule } from '../../types';

   export class MyRule implements CustomerValidationRule {
     name = 'MyRule';
     validate(rows: CustomerCsvRow[]): CustomerValidationIssue[] {
       // return array of issues
     }
   }
   ```
3. Import and add it to the array in `server/src/validators/customer/index.ts`

---

## Sample CSV

A sample file with intentional issues is provided at `sample/shopify-customers-sample.csv` for testing all validation rules.

---

## Testing

Run from `server/`:

```bash
npm run typecheck        # tsc --noEmit
npm test                 # unit tests (validators + parser) — no database needed
npm run test:integration # API tests against a real PostgreSQL (see below)
```

`npm test` covers every validation rule plus a full-pipeline "golden" snapshot
and needs no setup. `npm run test:integration` drives the Express API end to end
(upload → validate → persist → report) and **requires `TEST_DATABASE_URL` to
point at a throwaway database** — the suite truncates tables between tests, so
never point it at a database with real data. If `TEST_DATABASE_URL` is unset the
integration tests skip themselves.

```bash
# example: run integration tests against a scratch database
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/shopify_csv_qa_test" \
  npx prisma migrate deploy   # first time, with DATABASE_URL pointed at the scratch DB
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/shopify_csv_qa_test" \
  npm run test:integration
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push and pull
request, standing up a disposable PostgreSQL for the integration job.

## Production Build

```bash
# Build server
cd server && npm run build

# Build client
cd ../client && npm run build
```

---

## Roadmap / Ideas

- Cross-reference against existing store customers: export customers from Shopify, upload to the tool, and detect collisions with the incoming CSV
- Keep aligning validation rules with Shopify's real acceptance behavior (driven by the test-store import feedback loop)
- Image tool in the same app
- Product variants extraction from the Title
- Products: generate handles
