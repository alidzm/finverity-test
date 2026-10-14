import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Principal, Scope } from '@/auth/domain/principal';
import type { AuthenticatedRequest } from './authenticated-request';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const REQUIRED_SCOPES_KEY = 'auth:requiredScopes';

/** Opts a route out of authentication. Reserved for orchestrator probes. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Scopes the caller's token must carry (all of them). */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);

export const CurrentPrincipal = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.principal) {
    throw new Error('CurrentPrincipal used on a route without authentication');
  }
  return request.principal satisfies Principal;
});
