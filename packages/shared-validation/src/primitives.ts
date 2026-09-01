import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(255);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a digit');

export const nameSchema = z.string().trim().min(1).max(120);

export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens');

export const currencyCodeSchema = z
  .string()
  .trim()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code');

/**
 * Phase 16 — A QUERY-STRING BOOLEAN, PARSED RATHER THAN COERCED.
 *
 * `z.coerce.boolean()` runs JavaScript's `Boolean(value)`, and a query
 * string arrives as a STRING. `Boolean("false")` is `true`, so
 * `?isActive=false` was silently read as `isActive: true` — every "show
 * me the INACTIVE ones" filter in the product returned the active ones
 * instead. Reproduced against a real request while building the ERP
 * supplier screen, which is the first UI to offer such a filter.
 *
 * Only `""`, `"false"` and `"0"` are false; `"true"`, `"1"` and a bare
 * `?flag` (which arrives as `""` in some clients, so it is NOT treated as
 * true here — an explicit value is required) behave as written. A real
 * boolean passes through untouched, so a non-HTTP caller is unaffected.
 *
 * Anything else is a validation error rather than a silent guess: a
 * filter that quietly means its own opposite is worse than one that
 * refuses.
 */
export const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1'));
