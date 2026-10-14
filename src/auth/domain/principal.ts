export const SCOPES = {
  READ: 'capacity:read',
  RESERVE: 'capacity:reserve',
  RELEASE: 'capacity:release',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** The authenticated caller (an OAuth2 client in the client-credentials flow). */
export interface Principal {
  subject: string;
  clientId: string | null;
  scopes: ReadonlySet<string>;
}

/** Identity recorded in audit columns (reservations.created_by, ledger.actor, …). */
export function actorOf(principal: Principal): string {
  return principal.clientId ?? principal.subject;
}
