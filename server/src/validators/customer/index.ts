import { CustomerValidationRule } from '../../types';
import { MissingContactRule } from './missingContact.rule';
import { InvalidEmailRule } from './invalidEmail.rule';
import { DuplicateEmailRule } from './duplicateEmail.rule';
import { InvalidPhoneRule } from './invalidPhone.rule';
import { DuplicatePhoneRule } from './duplicatePhone.rule';
import { MarketingConsentRule } from './marketingConsent.rule';
import { TaxExemptRule } from './taxExempt.rule';
import { AddressCompletenessRule } from './addressCompleteness.rule';
import { ProvinceCodeRule } from './provinceCode.rule';
import { TagsRule } from './tags.rule';
import { HtmlInjectionRule } from './htmlInjection.rule';
import { CountryCodeRule } from './countryCode.rule';
import { FieldLengthRule } from './fieldLength.rule';

export const customerValidationRules: CustomerValidationRule[] = [
  new MissingContactRule(),
  new InvalidEmailRule(),
  new DuplicateEmailRule(),
  new InvalidPhoneRule(),
  new DuplicatePhoneRule(),
  new MarketingConsentRule(),
  new TaxExemptRule(),
  new AddressCompletenessRule(),
  new ProvinceCodeRule(),
  new TagsRule(),
  new HtmlInjectionRule(),
  new CountryCodeRule(),
  new FieldLengthRule(),
];
