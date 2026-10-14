export interface InboxRef {
  messageId: string;
  topic: string;
  partition: number;
  offset: string;
  messageType: string;
}

/** Port: record of already processed messages (transactional inbox). */
export abstract class MessageInbox {
  /**
   * Marks the message as processed inside the current transaction. Returns false if it was
   * processed before. Committing or rolling back together with the state change is what
   * makes processing effectively-once on top of at-least-once delivery.
   */
  abstract tryRecord(ref: InboxRef): Promise<boolean>;
}
