/**
 * In-process event bus — fans each newly-observed canonical event out to
 * SSE connections and the webhook deliverer. Subscribers never crash the
 * publisher; a throwing subscriber is logged and skipped.
 */

import type { KanonEvent } from "@kanon/core";

export type Subscriber = (event: KanonEvent) => void;

export class EventBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly warn: (message: string) => void;

  constructor(warn: (message: string) => void = console.warn) {
    this.warn = warn;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: KanonEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.warn(
          `kanon-server: event subscriber failed for ${event.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
