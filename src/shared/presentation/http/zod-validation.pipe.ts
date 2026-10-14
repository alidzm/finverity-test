import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { DomainError } from '@/shared/domain/domain-error';

/** Validates and transforms a request part (body, params, query) with a zod schema. */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new DomainError('VALIDATION_FAILED', 'Request validation failed', {
        errors: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
