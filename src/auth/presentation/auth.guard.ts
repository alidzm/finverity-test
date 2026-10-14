import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenVerifier } from '@/auth/application/token-verifier';
import type { Scope } from '@/auth/domain/principal';
import { DomainError } from '@/shared/domain/domain-error';
import type { AuthenticatedRequest } from './authenticated-request';
import { IS_PUBLIC_KEY, REQUIRED_SCOPES_KEY } from './decorators';

/**
 * Global guard: every route requires a valid bearer token unless marked `@Public()`, and
 * must declare its scopes with `@RequireScopes()`. A route that declares nothing is
 * rejected (fail closed) so a forgotten decorator cannot silently expose an endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new DomainError('UNAUTHENTICATED', 'Missing bearer token');
    }
    const principal = await this.verifier.verify(token);
    request.principal = principal;

    const required = this.reflector.getAllAndOverride<Scope[] | undefined>(
      REQUIRED_SCOPES_KEY,
      targets,
    );
    if (!required) {
      this.logger.error(
        `Route ${request.method} ${request.route?.path} declares no scopes; denying`,
      );
      throw new DomainError('FORBIDDEN', 'Access denied');
    }
    const missing = required.filter((scope) => !principal.scopes.has(scope));
    if (missing.length > 0) {
      throw new DomainError('FORBIDDEN', 'The access token lacks a required scope', {
        requiredScopes: required,
      });
    }
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  return scheme?.toLowerCase() === 'bearer' && token && rest.length === 0 ? token : null;
}
