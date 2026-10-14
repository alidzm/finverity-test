import type { ChangeOrigin } from '@/capacity/domain/change-source';

/** Who/what triggered an operation; passed to the domain as the origin of the change. */
export type OperationContext = ChangeOrigin;

export const TREASURY_ACTOR = 'treasury';

export function treasuryContext(messageId: string): OperationContext {
  return { source: 'TREASURY', actor: TREASURY_ACTOR, correlationId: messageId };
}
