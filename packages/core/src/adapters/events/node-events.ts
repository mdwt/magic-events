import { EventEmitter } from "node:events";
import type { DomainEvent, DomainEvents } from "../../shared/domain-events.ts";
import type { Logger } from "../../shared/logger.ts";

// The domain event port on Node's own event emitter. It is the simplest adapter there is: no broker and nothing
// to run. Its limit is that it reaches subscribers in this process only. Reaching other processes means another
// adapter behind the same port, such as Postgres LISTEN/NOTIFY or NATS.
export function createDomainEvents(logger: Logger): DomainEvents {
  const log = logger.child({ component: "domain-events" });
  const emitter = new EventEmitter();
  // Subscribers are few and long-lived, so the emitter's leak warning would only be noise.
  emitter.setMaxListeners(0);

  return {
    publish(event) {
      log.debug({ eventId: event.id, type: event.type, resourceId: event.resourceId }, "Domain event published");
      emitter.emit(event.type, event);
      emitter.emit("*", event);
    },

    subscribe(type: string, handler: (event: never) => void | Promise<void>) {
      // A subscriber's failure is its own. It is logged, and the publisher and the other subscribers go on.
      const listener = (event: DomainEvent) => {
        const failed = (error: unknown) => {
          log.error({ err: error, eventId: event.id, type: event.type }, "A domain event subscriber failed");
        };
        try {
          const result = (handler as (event: DomainEvent) => void | Promise<void>)(event);
          if (result instanceof Promise) result.catch(failed);
        } catch (error) {
          failed(error);
        }
      };
      emitter.on(type, listener);
      return () => {
        emitter.off(type, listener);
      };
    },
  };
}
