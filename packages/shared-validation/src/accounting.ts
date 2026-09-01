import { z } from 'zod';
import { nameSchema, queryBooleanSchema } from './primitives';

const accountCodeSchema = z.string().trim().min(1).max(20);

export const createAccountSchema = z.object({
  code: accountCodeSchema,
  name: nameSchema,
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  normalBalance: z.enum(['DEBIT', 'CREDIT']),
  parentAccountId: z.string().uuid().optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: nameSchema,
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const accountListQuerySchema = z.object({
  isActive: queryBooleanSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type AccountListQuery = z.infer<typeof accountListQuerySchema>;

export const journalEntryListQuerySchema = z.object({
  sourceType: z.string().trim().max(60).optional(),
  accountId: z.string().uuid().optional(),
  fiscalPeriodId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type JournalEntryListQuery = z.infer<typeof journalEntryListQuerySchema>;

export const reverseJournalEntrySchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});
export type ReverseJournalEntryInput = z.infer<typeof reverseJournalEntrySchema>;

export const trialBalanceQuerySchema = z.object({
  fiscalPeriodId: z.string().uuid().optional(),
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export const openPeriodSchema = z
  .object({
    name: nameSchema,
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
  })
  .refine((v) => v.endDate > v.startDate, { message: 'endDate must be after startDate', path: ['endDate'] });
export type OpenPeriodInput = z.infer<typeof openPeriodSchema>;
