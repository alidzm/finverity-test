/** Who originated a change: this service's API or the treasury feed. */
export const CHANGE_SOURCES = ['API', 'TREASURY'] as const;

export type ChangeSource = (typeof CHANGE_SOURCES)[number];

/** Who/what triggered a change; recorded in audit columns, releases and the ledger. */
export interface ChangeOrigin {
  readonly source: ChangeSource;
  /** OAuth client id for API calls, `treasury` for Kafka-driven changes. */
  readonly actor: string;
  /** HTTP request id or Kafka message id. */
  readonly correlationId: string | null;
}
