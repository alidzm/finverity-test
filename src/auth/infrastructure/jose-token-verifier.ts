import { Inject, Injectable, Logger } from '@nestjs/common';
import { errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { TokenVerifier } from '@/auth/application/token-verifier';
import type { Principal } from '@/auth/domain/principal';
import { AppConfig } from '@/config/app-config';
import { DomainError } from '@/shared/domain/domain-error';

/** Resolves signing keys for token verification (remote JWKS in production, local in tests). */
export const JWKS_KEY_RESOLVER = Symbol('JWKS_KEY_RESOLVER');

const ALLOWED_ALGORITHMS = ['RS256', 'PS256', 'ES256'];

/** Verifies OAuth2/OIDC access tokens (JWT) against the issuer's JWKS with `jose`. */
@Injectable()
export class JoseTokenVerifier extends TokenVerifier {
  private readonly logger = new Logger(JoseTokenVerifier.name);

  constructor(
    private readonly config: AppConfig,
    @Inject(JWKS_KEY_RESOLVER) private readonly keys: JWTVerifyGetKey,
  ) {
    super();
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.auth.issuer,
        audience: this.config.auth.audience,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: 5,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (error) {
      if (isKeySourceFailure(error)) {
        this.logger.error(
          { err: error },
          'Unable to fetch signing keys from the identity provider',
        );
        throw new DomainError('AUTH_UNAVAILABLE', 'Token verification is temporarily unavailable');
      }
      this.logger.debug({ reason: (error as Error).message }, 'Rejected bearer token');
      throw new DomainError('UNAUTHENTICATED', 'Invalid or expired access token');
    }

    return {
      subject: payload.sub!,
      clientId: stringClaim(payload.azp) ?? stringClaim(payload.client_id),
      scopes: parseScopes(payload),
    };
  }
}

/** Supports both `scope` (space-delimited, RFC 8693/9068) and `scp` (array) conventions. */
function parseScopes(payload: JWTPayload): Set<string> {
  const scopes = new Set<string>();
  if (typeof payload.scope === 'string') {
    payload.scope
      .split(' ')
      .filter(Boolean)
      .forEach((scope) => scopes.add(scope));
  }
  if (Array.isArray(payload.scp)) {
    payload.scp.filter((scope) => typeof scope === 'string').forEach((scope) => scopes.add(scope));
  }
  return scopes;
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The JWKS endpoint was unreachable — not the caller's fault. */
function isKeySourceFailure(error: unknown): boolean {
  if (error instanceof errors.JWKSTimeout) {
    return true;
  }
  return !(error instanceof errors.JOSEError);
}
