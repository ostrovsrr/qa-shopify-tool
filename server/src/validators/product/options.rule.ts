import { ProductGroup, ProductValidationIssue, ProductValidationRule } from '../../types';
import { col } from '../../services/productCsvParser';
import { OPTION_NAME_COLS, OPTION_VALUE_COLS, variantRowIndexes } from '../../services/productVariants';
import { MAX_TEXT_LENGTH } from '../../services/productValues';
import { productIssue, rawCell } from './issue';

// Option declarations the admin import rejects (observed 2026-09-22):
//   • a gap: Option3 named with no Option2 (or Option2 with no Option1)
//   • two options with the same name
//   • an option name, or any variant's option value, over 255 characters
// Options are declared on the product's first row.
export class OptionsRule implements ProductValidationRule {
  name = 'OptionsRule';

  validate(groups: ProductGroup[]): ProductValidationIssue[] {
    const issues: ProductValidationIssue[] = [];

    for (const group of groups) {
      const first = group.rows[0];
      if (!first) continue;
      const names = OPTION_NAME_COLS.map((c) => col(first.normalized, c));

      for (let i = 1; i < names.length; i++) {
        if (names[i] === '' || names[i - 1] !== '') continue;
        issues.push(productIssue(group, first, {
          column: OPTION_NAME_COLS[i],
          issueType: 'OptionGap',
          currentValue: names[i],
          message: `Option${i + 1} Name is "${names[i]}" but Option${i} Name is blank.`,
          shopifySays: `Can't have option ${names[i]} as option${i + 1} without providing option${i}`,
          suggestedFix: `Move "${names[i]}" into Option${i} Name (and its values into Option${i} Value).`,
        }));
      }

      const seen = new Map<string, number>();
      names.forEach((name, i) => {
        if (name === '') return;
        const key = name.toLowerCase();
        const earlier = seen.get(key);
        if (earlier === undefined) {
          seen.set(key, i);
          return;
        }
        issues.push(productIssue(group, first, {
          column: OPTION_NAME_COLS[i],
          issueType: 'DuplicateOptionName',
          currentValue: name,
          message: `Option${i + 1} Name "${name}" repeats Option${earlier + 1} Name.`,
          shopifySays: `Duplicated option name '${name}'`,
          suggestedFix: 'Give each option a different name, or merge them into one option.',
        }));
      });

      names.forEach((name, i) => {
        if (name.length <= MAX_TEXT_LENGTH) return;
        issues.push(productIssue(group, first, {
          column: OPTION_NAME_COLS[i],
          issueType: 'OptionNameTooLong',
          currentValue: rawCell(first, OPTION_NAME_COLS[i]),
          message: `Option${i + 1} Name is ${name.length} characters; the limit is ${MAX_TEXT_LENGTH}.`,
          shopifySays: 'Option name is too long.',
          suggestedFix: `Shorten the option name to ${MAX_TEXT_LENGTH} characters or fewer.`,
        }));
      });

      const rows = group.rows.map((r) => r.normalized);
      for (const r of variantRowIndexes(rows)) {
        OPTION_VALUE_COLS.forEach((column) => {
          const value = col(rows[r], column);
          if (value.length <= MAX_TEXT_LENGTH) return;
          issues.push(productIssue(group, group.rows[r], {
            column,
            issueType: 'OptionValueTooLong',
            currentValue: rawCell(group.rows[r], column),
            message: `${column} is ${value.length} characters; the limit is ${MAX_TEXT_LENGTH}.`,
            shopifySays: 'Option value name is too long.',
            suggestedFix: `Shorten the option value to ${MAX_TEXT_LENGTH} characters or fewer.`,
          }));
        });
      }
    }

    return issues;
  }
}
