# Shopify CSV QA Tool

An internal tool for validating Shopify Customer CSV files before import. Upload a CSV, get a detailed validation report, and download an Excel file with all issues.

---

## Features

- Upload & validate Shopify Customer CSV files
- 13 validation rules covering contacts, emails, phones, addresses, postal codes, tags, consent fields, and more
- Validation results stored in PostgreSQL
- Downloadable Excel report (Summary, Errors, Warnings, Info, Original Rows With Issues sheets)
- Validation history with open/delete support
- Clean dashboard UI with filtering, sorting, and search

---

## Prerequisites

- **Node.js** 18+
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

### 3. Set up the database

```bash
cd server

# Generate the Prisma client
npm run prisma:generate

# Run the initial migration (creates the database tables)
npm run prisma:migrate
# When prompted, enter a migration name e.g.: init
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

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/customer-validation/upload` | Upload and validate a Customer CSV |
| `GET` | `/api/customer-validation/:id` | Get a validation run by ID |
| `GET` | `/api/customer-validation/report/:id` | Download Excel report |
| `GET` | `/api/customer-validation/history` | List recent validation runs |
| `DELETE` | `/api/customer-validation/:id` | Delete a validation run |

---

## Validation Rules

| Rule | Severity | Description |
|------|----------|-------------|
| MissingContactRule | Error | Both Email and Phone are missing |
| InvalidEmailRule | Error | Email exists but is not a valid format |
| DuplicateEmailRule | Error | Same email appears more than once (case-insensitive) |
| InvalidPhoneRule | Error / Warning | Too few digits or suspicious characters |
| DuplicatePhoneRule | Error | Same normalized phone appears more than once |
| MarketingConsentRule | Error | Invalid value for Accepts Email/SMS Marketing |
| TaxExemptRule | Error | Invalid value for Tax Exempt |
| AddressCompletenessRule | Warning | Missing Country, City, or Province for address rows |
| PostalCodeRule | Warning | Invalid Canadian or US postal code format |
| TagsRule | Warning | Duplicate commas, leading/trailing commas, empty tags, duplicate tags |
| NumericFieldsRule | Warning | Non-numeric or negative Total Spent / Total Orders |
| WhitespaceRule | Warning | Leading or trailing spaces in important fields |
| LongNoteRule | Warning | Note field exceeds 500 characters |

---

## Project Structure

```
shopify-csv-qa/
├── client/               # React + Vite + TypeScript frontend
│   └── src/
│       ├── api/          # API client functions
│       ├── components/   # UI components
│       ├── pages/        # Page components
│       └── types/        # Shared TypeScript types
├── server/               # Node.js + Express + TypeScript backend
│   ├── prisma/           # Prisma schema and migrations
│   └── src/
│       ├── controllers/  # HTTP request handlers
│       ├── db/           # Prisma client singleton
│       ├── reports/      # Excel report generator
│       ├── services/     # Business logic
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

## Production Build

```bash
# Build server
cd server && npm run build

# Build client
cd ../client && npm run build
```
