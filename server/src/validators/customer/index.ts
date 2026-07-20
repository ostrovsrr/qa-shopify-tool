import { CustomerValidationRule } from '../../types';
import { MissingContactRule } from './missingContact.rule';
import { InvalidEmailRule } from './invalidEmail.rule';
import { DuplicateEmailRule } from './duplicateEmail.rule';
import { InvalidPhoneRule } from './invalidPhone.rule';
import { DuplicatePhoneRule } from './duplicatePhone.rule';
import { MarketingConsentRule } from './marketingConsent.rule';
import { TaxExemptRule } from './taxExempt.rule';
import { AddressCompletenessRule } from './addressCompleteness.rule';
import { PostalCodeRule } from './postalCode.rule';
import { ProvinceCodeRule } from './provinceCode.rule';
import { TagsRule } from './tags.rule';
import { NumericFieldsRule } from './numericFields.rule';
import { LongNoteRule } from './longNote.rule';
import { HtmlInjectionRule } from './htmlInjection.rule';

export const customerValidationRules: CustomerValidationRule[] = [
  new MissingContactRule(),
  new InvalidEmailRule(),
  new DuplicateEmailRule(),
  new InvalidPhoneRule(),
  new DuplicatePhoneRule(),
  new MarketingConsentRule(),
  new TaxExemptRule(),
  new AddressCompletenessRule(),
  new PostalCodeRule(),
  new ProvinceCodeRule(),
  new TagsRule(),
  new NumericFieldsRule(),
  new HtmlInjectionRule(),
  new LongNoteRule(),
];
