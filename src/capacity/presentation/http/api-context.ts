import { actorOf, type Principal } from '@/auth/domain/principal';
import type { AuthenticatedRequest } from '@/auth/presentation/authenticated-request';
import type { OperationContext } from '@/capacity/application/operation-context';

export function apiContext(principal: Principal, request: AuthenticatedRequest): OperationContext {
  return { source: 'API', actor: actorOf(principal), correlationId: request.id ?? null };
}
