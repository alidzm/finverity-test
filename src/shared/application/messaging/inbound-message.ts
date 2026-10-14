import { DiscoveryService } from '@nestjs/core';

/** A message delivered by the broker, independent of the client library. */
export interface InboundMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: Buffer | null;
  headers: Record<string, string>;
}

/**
 * Contract between inbound message adapters (presentation layer) and the transport that
 * delivers to them (infrastructure). Implementations translate a message into use cases.
 */
export interface MessageHandler {
  readonly topic: string;
  handle(message: InboundMessage): Promise<void>;
}

/** Class decorator: registers a provider implementing `MessageHandler` with the transport. */
export const MessageConsumer = DiscoveryService.createDecorator();

/** The message itself is unprocessable (bad schema, unknown type…): retrying cannot help. */
export class NonRetryableMessageError extends Error {
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'NonRetryableMessageError';
  }
}
