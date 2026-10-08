import { describe, expect, it } from 'vitest';
import { scrub } from '../src/middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// The logs are where merchant PII leaks by ACCIDENT rather than by design.
//
// Nothing in this app deliberately logs a CSV row. But an error message routinely
// quotes the value that caused it — "invalid email: jane.doe@acme.com" — and logs
// outlive the data: they survive the retention purge and get shipped to whatever
// the platform's log aggregator is, which is a system nobody audited for PII.
//
// This is a backstop, not a licence. Do not log user data on purpose.
// ─────────────────────────────────────────────────────────────────────────────

describe('log scrub', () => {
  it('redacts an email quoted in an error message', () => {
    expect(scrub('Invalid email: jane.doe+qa@acme.co.uk on row 42')).toBe(
      'Invalid email: [email] on row 42',
    );
  });

  it('redacts phone numbers, including international forms', () => {
    expect(scrub('bad phone +1 (416) 555-1234')).toBe('bad phone [phone]');
    expect(scrub('bad phone 442071234567')).toBe('bad phone [phone]');
  });

  it('redacts every occurrence, not just the first', () => {
    const scrubbed = scrub('duplicate: a@x.com matches b@y.com');
    expect(scrubbed).toBe('duplicate: [email] matches [email]');
  });

  it('leaves the parts of a message that make it USEFUL', () => {
    // A scrub that eats the diagnosis defeats the purpose of logging at all. Row
    // numbers, counts, ids and file names carry no personal data and must survive.
    const message = 'Row 4821 of customers.csv failed after 3 retries (run 7a56f7f2)';
    expect(scrub(message)).toBe(message);
  });

  it('does not mistake a long number for a phone when it is a count or an id', () => {
    // The phone pattern needs 10+ digits; row counts and short ids must pass through.
    expect(scrub('processed 12345 rows')).toBe('processed 12345 rows');
  });

  it.each([
    '+1 613 555 0104',
    '(613) 555-0104',
    '613-555-0104',
    '613.555.0104',
    '6135550104',
    '+16135550104',
    '+44 20 7946 0958',
  ])('redacts the phone %s wherever it sits in a message', (phone) => {
    expect(scrub(`invalid phone: ${phone}`)).toBe('invalid phone: [phone]');
    expect(scrub(`row 7 phone ${phone}, skipped`)).toBe('row 7 phone [phone], skipped');
    expect(scrub(`could not reach ${phone}.`)).toBe('could not reach [phone].');
  });

  it.each([
    // The old pattern turned all of these into "[phone]".
    'run finished 2026-10-05',
    'claimed at 2026-10-05T14:58:05.123Z',
    'claimed at 2026-10-05 14:58:05',
    'between 2026-10-05 and 2026-10-06',
    'customer gid://shopify/Customer/7234567890123 rejected',
    'bulk op gid://shopify/BulkOperation/1234567890 still RUNNING',
    'product id 8123456789012 was not found',
    'expires 1759675085123',
    'run 123e4567-e89b-12d3-a456-426614174000 failed',
    'poll took 1534.25 ms after 120000 ms timeout',
  ])('keeps dates, timestamps and ids intact: %s', (message) => {
    expect(scrub(message)).toBe(message);
  });
});
