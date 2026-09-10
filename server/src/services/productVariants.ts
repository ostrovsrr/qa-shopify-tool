import { col } from './productCsvParser';

// How a Handle group's rows become a product's options and variants. Shared by the
// productSet builder (productImport.service) and the product pre-check rules
// (validators/product), so the pre-check judges exactly what the import sends.

export const OPTION_NAME_COLS = ['Option1 Name', 'Option2 Name', 'Option3 Name'];
export const OPTION_VALUE_COLS = ['Option1 Value', 'Option2 Value', 'Option3 Value'];

export function isTruthy(v: string): boolean {
  return ['true', 'yes', '1', 'y', 't'].includes(v.trim().toLowerCase());
}

// A row contributes a variant if it carries any variant-distinguishing data.
// (Trailing image-only rows — only Image Src populated — are not variants.)
export function hasVariantData(row: Record<string, string>): boolean {
  return (
    col(row, ...OPTION_VALUE_COLS) !== '' ||
    col(row, 'Variant SKU') !== '' ||
    col(row, 'Variant Price') !== ''
  );
}

/** Indexes of the group's variant rows: the first row is always the product's
 *  first variant; later rows only if they carry variant data. */
export function variantRowIndexes(rows: Record<string, string>[]): number[] {
  const out: number[] = [];
  rows.forEach((row, i) => {
    if (i === 0 || hasVariantData(row)) out.push(i);
  });
  return out;
}

/** The product's option names, declared on the group's first row. */
export function productOptionNames(first: Record<string, string>): string[] {
  return OPTION_NAME_COLS.map((c) => col(first, c)).filter(Boolean);
}

/** The option values a variant row gets, one per declared option. With no declared
 *  options Shopify's single default option applies and every variant is "Default
 *  Title". A blank entry means the row has no value for that option. */
export function variantOptionValues(row: Record<string, string>, optionNames: string[]): string[] {
  if (optionNames.length === 0) return ['Default Title'];
  return optionNames.map((_, i) => col(row, OPTION_VALUE_COLS[i]));
}
