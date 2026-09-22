# Rejection probe: admin CSV import vs productSet

Probed 2026-09-22 on rodionteststore5 (API 2026-01) with `sample/product-rejection-probe.csv`
(synthetic, one product per case). Re-run with:

```bash
cd server
npx ts-node scripts/rejectionProbe/buildProbeCsv.ts                      # writes the CSV
npx ts-node --transpile-only scripts/rejectionProbe/probeProductSet.ts ../sample/product-rejection-probe.csv store5 out.json
```

The admin side is Products → Import with the same file. `SKIP=price-text,compare-at-text,cost-text`
builds the variant the admin importer lets past its upload check (see below).

## How the admin importer reports errors

Two stages:

1. **At upload, the whole file is refused** on the first value it can't parse. No row number, one
   message at a time:
   - `"abc" is not a valid price` (Variant Price, and also Variant Compare At Price)
   - `"cheap" is not a valid cost per item`
2. **After the import, by email** ("Your product import finished with some errors"). Each failed
   product is one line with the CSV rows it spans:
   `Row 3-4: Validation failed: The variant 'Default Title' already exists.`
   Multiple errors on one product are joined with " and ".

Images that can't be fetched are not reported anywhere: the product imports and the media is
`FAILED`.

## Case by case

Rows marked **≠** are cases where our import (productSet) does not reach the same verdict as the
real CSV import.

| # | Case | Admin CSV import | productSet: code · field path · message | |
|---|---|---|---|---|
| 01 | valid control | imported | accepted | = |
| 02 | duplicate Default Title variant | `Validation failed: The variant 'Default Title' already exists.` | `INVALID_VARIANT` · `variants.1` · same text | = |
| 03 | duplicate option value | `The variant 'M' already exists.` | `INVALID_VARIANT` · `variants.1` · same | = |
| 04 | blank Option1 Value on a variant row | **imported**, value filled in as `Default Title` | `INVALID_INPUT` · `variants.1.optionValues.0` · `The name provided is not valid.` | **≠** |
| 05 | option name > 255 | `Option name is too long.` | `INVALID_INPUT` · `productOptions.0.name` · same | = |
| 06 | two options named Color | `Duplicated option name 'Color'` | `DUPLICATED_OPTION_NAME` · `productOptions` · same | = |
| 07 | option named `Title` | imported | accepted | = |
| 08 | Option3 without Option2 | `Can't have option Color as option3 without providing option2` | `OPTION_VALUES_MISSING` · `productOptions.1` · `Option 'Color' must specify at least one option value.` | = (wording differs) |
| 09 | option value > 255 | `Option value name is too long.` | `INVALID_INPUT` · `productOptions.0.values.0` · same | = |
| 10 | metafield column with no definition | **imported**, metafield silently dropped | `INVALID_METAFIELD` · `metafields.0.type` · `Type can't be blank` | **≠** |
| 11 | Gift Card TRUE (not activated) | `Gift card products can only be created after they have been activated` | `GIFT_CARDS_NOT_ACTIVATED` · `giftCard` · same | = |
| 12 | Variant Price `abc` | whole file refused at upload | top-level GraphQL error: `invalid value for variants.0.price (invalid money 'abc')` | **≠** (scope) |
| 13 | Variant Price `-5.00` | `Price must be greater than or equal to 0` | `INVALID_VARIANT` · `variants.0.price` · same | = |
| 14 | Compare At Price `abc` | whole file refused at upload | top-level: `variants.0.compareAtPrice (invalid money 'abc')` | **≠** (scope) |
| 15 | Cost per item `cheap` | whole file refused at upload | top-level: `variants.0.inventoryItem.cost (invalid decimal 'cheap')` | **≠** (scope) |
| 16 | Variant Grams `heavy` | `Weight isn't a number.` | **accepted** (builder drops the weight) | **≠** |
| 17 | Weight Unit `stone` | imported (unit ignored) | accepted (builder falls back to grams) | = |
| 18 | Inventory Policy `maybe` | `Inventory policy is not included in the list` | **accepted** (builder maps it to DENY) | **≠** |
| 19 | Inventory Qty `1.5` | imported, quantity 1 | accepted, quantity skipped | = (result differs) |
| 20 | Status `live` | `Status isn't valid. Set the status as active, draft, or archived.` | **accepted** (builder falls back to Published) | **≠** |
| 21 | Title blank | `Title must be specified` | `INVALID_PRODUCT` · `title` · same | = |
| 22 | Title > 255 | `Title is too long (maximum is 255 characters)` | `INVALID_PRODUCT` · `title` · `is too long (maximum is 255 characters)` | = |
| 23 | Vendor > 255 | `Vendor is too long (maximum is 255 characters)` | `INVALID_PRODUCT` · `(input)` · same | = |
| 24 | Type > 255 | `Product type is too long … and Custom product type is too long …` | two `INVALID_PRODUCT` errors · `(input)` | = |
| 25 | one tag > 255 | `Product tags is invalid` | `INVALID_PRODUCT` · `(input)` · same | = |
| 26 | SKU > 255 | `SKU is too long (maximum is 255 characters)` | `INVALID_VARIANT` · `variants.0.sku` · same | = |
| 27 | Barcode > 255 | `Barcode is too long (maximum is 255 characters)` | `INVALID_VARIANT` · `variants.0.barcode` · same | = |
| 28 | Image Src `not a url` | `File URL is invalid` | `INVALID_INPUT` · `files.0.originalSource` · same | = |
| 29 | Image Src unreachable | imported, media FAILED, no error | accepted | = |
| 30 | Variant Image not in Image Src | imported | accepted | = |
| 31 | Compare At below Price | imported | accepted | = |

## Value formats (second probe, same day)

| Column | Admin behaviour |
|---|---|
| Variant Price / Compare At / Cost | Reads the first number in the cell: `$10.00`, `10 USD` → 10.00; `1,000.00` → 1000; `10,50` → 10.50; `10.999` → 11.00; `1e2` → 1.00; `.5` → 0.50. **No digits at all refuses the whole file.** |
| Variant Grams | A leading number: `100g` → 100 g; `1e3` → 1000 g; `1,000` → **1 g**. No leading number: `Weight isn't a number.`; negative: `Weight must be greater than or equal to 0`. |
| Variant Inventory Policy | deny/continue, any case, spaces trimmed. **Blank on a variant row refuses the whole file** when the column exists (`Inventory policy is not included in the list`); image-only rows and files without the column are fine. |
| Status | active/draft/archived/**unlisted**, any case. |
| Variant Inventory Qty | Never fails: a leading integer (`1.5` → 1, `1,000` → 1, `-3` → -3, `ten` → 0). |

The case list with these verdicts is `server/scripts/rejectionProbe/cases.ts`;
`server/test/validators/productProbeParity.test.ts` holds the pre-check to it.

## What the tool does now (2026-09-22)

- **Pre-check** (`validators/product/`) flags exactly the cases the admin import does not import,
  quoting Shopify's wording, and marks the whole-file ones (`FILE_BLOCKING_ISSUE_TYPES`).
- **Import** (productSet) sends what the admin would store: money and grams read the same way,
  a blank option value becomes `Default Title`, and metafields with no definition on the store
  are dropped. Values the admin rejects are passed through unchanged so productSet rejects that
  product too. A whole-file problem does **not** stop the tool's import: those products come back
  rejected and the rest import, so every problem shows in one pass.
- Verified on store 5: all 52 probe cases land the same way as in the admin import (whole-file
  cases come back as rejected products).

## What this meant for the tool (before the fix)

- **Where both reject, the messages are Shopify's same validation text.** The email adds
  `Validation failed:` and the CSV row range. productSet gives a field path that points at a
  specific variant, option, file or metafield, so it can be resolved to a row and column.
- **The email's row reference is the product's whole row range**, not the offending row. A path
  like `variants.1` can name the exact row, which is more precise than the email.
- **Our import is stricter than the CSV import on 04 and 10.** A blank option value and a
  metafield with no definition both import through the admin, but productSet rejects them.
  All 32 real `INVALID_METAFIELD` rejections in the local DB have this exact field and message.
- **Our import is looser on 16, 18 and 20.** The builder quietly replaces a bad Grams, Inventory
  Policy or Status value, so the tool reports "accepted" for rows the CSV import rejects.
- **The admin refuses the whole file for a non-numeric price, compare-at price or cost** (12, 14,
  15). In a bulk run each of those is a per-product top-level error, so our report shows one bad
  product where the real import would take nothing.
