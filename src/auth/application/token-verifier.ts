import type { Principal } from '@/auth/domain/principal';

/**
 * Port: turns a bearer token into the calling principal.
 * Throws `UNAUTHENTICATED` for bad tokens and `AUTH_UNAVAILABLE` when the issuer cannot be
 * reached (a server-side condition the caller should retry, not a bad credential).
 */
export abstract class TokenVerifier {
  abstract verify(token: string): Promise<Principal>;
}
