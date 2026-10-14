import { z } from 'zod';

// Contract of the inbound `treasury.fx-rates.v1` topic (assumed; see ARCHITECTURE.md §3.2).

const Currency = z.string().regex(/^[A-Z]{3}$/);
const Timestamp = z.iso.datetime({ offset: true });

export const FxRateMessageSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    type: z.literal('FxRateUpdated'),
    schemaVersion: z.literal(1),
    occurredAt: Timestamp,
    payload: z.object({
      base: Currency,
      quote: Currency,
      /** 1 base = rate quote; at most 12 decimal places (storage precision). */
      rate: z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,12})?$/),
      asOf: Timestamp,
    }),
  })
  .refine((message) => message.payload.base !== message.payload.quote, {
    message: 'base and quote currencies must differ',
    path: ['payload', 'quote'],
  });

export type FxRateMessage = z.output<typeof FxRateMessageSchema>;
