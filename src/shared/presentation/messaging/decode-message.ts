import type { z } from 'zod';
import {
  type InboundMessage,
  NonRetryableMessageError,
} from '@/shared/application/messaging/inbound-message';

/** Decodes and validates a message value; any failure is non-retryable (→ DLQ). */
export function decodeMessage<TSchema extends z.ZodType>(
  message: InboundMessage,
  schema: TSchema,
): z.output<TSchema> {
  if (!message.value) {
    throw new NonRetryableMessageError('Empty message value');
  }
  let json: unknown;
  try {
    json = JSON.parse(message.value.toString('utf8'));
  } catch {
    throw new NonRetryableMessageError('Message value is not valid JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new NonRetryableMessageError(
      `Schema validation failed: ${issues.slice(0, 10).join('; ')}`,
      { issues },
    );
  }
  return result.data;
}
