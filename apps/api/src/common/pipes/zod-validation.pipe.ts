import { PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/**
 * Validates request bodies against a shared zod schema (the same schemas
 * consumed by the offline POS client later) and returns the parsed,
 * coerced value. Validation failures throw ZodError, translated to a
 * 422 VALIDATION_FAILED response by AllExceptionsFilter.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    return this.schema.parse(value);
  }
}
