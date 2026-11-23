// The domain event port. A domain event records that something happened: a raw listing was captured, an
// experience was published. The domain that makes the change appends the event to the log in the same transaction
// and publishes it here once the change is saved, so other parts of the system can react. It belongs to no domain.
// Version 1's adapter is Node's event emitter, which reaches subscribers in the same process only.

// What each domain event carries, as it is stored in the log. See docs/domain-events.md.
export interface DomainEventData {
  "raw_listing.captured": { listing_id: string; run_id: string; kind: "listing" | "removed" };
  "raw_listing.processed": { listing_id: string };
  "raw_listing.failed": { listing_id: string; error: string; attempt: number; will_retry: boolean };
  // raw_listing_id is the newer version that replaced this one.
  "raw_listing.superseded": { listing_id: string; raw_listing_id: string };
  "experience.published": { version: number; raw_listing_id: string };
  // raw_listing_id is there when processing a raw listing caused the change.
  "experience.changed": { version: number; change: string; raw_listing_id?: string };
}

export type DomainEventType = keyof DomainEventData;

// One domain event, exactly as its row in the log.
export type DomainEvent<T extends DomainEventType = DomainEventType> = {
  [K in T]: {
    id: string;
    type: K;
    // The raw listing or the experience the event is about. The type says which.
    resourceId: string;
    data: DomainEventData[K];
    // When it was appended, as an ISO timestamp.
    recordedAt: string;
  };
}[T];

// What a service is handed: the publishing half.
export interface DomainEventPublisher {
  // Publishes an event that has been appended to the log. Inside a transaction it goes out when the transaction
  // commits, and not at all when it rolls back, so no subscriber hears of a change that was never saved.
  publish(event: DomainEvent): void;
}

// The whole port: publishing and subscribing.
export interface DomainEvents extends DomainEventPublisher {
  // Calls the handler for every event of the type, or for every event with "*". Returns a function that ends it.
  // A handler that fails is logged and does not stop the publisher or the other handlers.
  subscribe<T extends DomainEventType>(type: T, handler: (event: DomainEvent<T>) => void | Promise<void>): () => void;
  subscribe(type: "*", handler: (event: DomainEvent) => void | Promise<void>): () => void;
}
