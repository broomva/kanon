/**
 * Webhook delivery loop — in-process, setInterval-driven.
 *
 * Registrations are `webhook` entities IN THE LOG (managed via
 * /v1/webhooks); each new canonical event whose `model` appears in a
 * registration's `resourceTypes` is POSTed to that registration's URL as
 * JSON with:
 *
 *   X-Kanon-Signature  hex HMAC-SHA256(secret, body)
 *   X-Kanon-Event      "<model>.<op>"
 *   X-Kanon-Delivery   ULID, unique per delivery attempt chain
 *
 * Failures retry 3x with exponential backoff, are logged, and NEVER crash
 * the server — delivery is at-least-once best-effort; the durable contract
 * is the /v1/sync/events feed.
 */

import { createHmac } from "node:crypto";
import type { KanonEvent } from "@kanon/core";
import type { KanonService } from "@kanon/service";

const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
const REQUEST_TIMEOUT_MS = 10_000;

interface PendingDelivery {
  deliveryId: string;
  webhookId: string;
  url: string;
  body: string;
  signature: string;
  eventHeader: string;
  attempts: number;
  notBefore: number;
}

export interface DelivererOptions {
  intervalMs: number;
  onWarn?: (message: string) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class WebhookDeliverer {
  private readonly service: KanonService;
  private readonly intervalMs: number;
  private readonly warn: (message: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly queue: PendingDelivery[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private draining = false;

  constructor(service: KanonService, options: DelivererOptions) {
    this.service = service;
    this.intervalMs = options.intervalMs;
    this.warn = options.onWarn ?? ((message) => console.warn(message));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    this.unsubscribe = this.service.bus.subscribe((event) => {
      this.enqueue(event);
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Timers must not keep a stopping process alive.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Deliveries waiting (visible for tests/ops). */
  pending(): number {
    return this.queue.length;
  }

  private enqueue(event: KanonEvent): void {
    // Registrations are read at emission time from the projection, so a
    // webhook created earlier in the same batch never sees its own creation.
    for (const hook of this.service.webhooksForDelivery()) {
      if (!hook.resourceTypes.includes(event.model)) continue;
      const body = JSON.stringify(event);
      this.queue.push({
        deliveryId: crypto.randomUUID(),
        webhookId: hook.id,
        url: hook.url,
        body,
        signature: createHmac("sha256", hook.secret).update(body).digest("hex"),
        eventHeader: `${event.model}.${event.op}`,
        attempts: 0,
        notBefore: 0,
      });
    }
  }

  /** Drain due deliveries; re-entrancy-guarded (ticks can overlap on slow hooks). */
  async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const now = Date.now();
      const due = this.queue.filter((item) => item.notBefore <= now);
      for (const item of due) {
        const index = this.queue.indexOf(item);
        if (index !== -1) this.queue.splice(index, 1);
        await this.deliver(item);
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliver(item: PendingDelivery): Promise<void> {
    item.attempts += 1;
    let failure: string | undefined;
    try {
      const response = await this.fetchImpl(item.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kanon-signature": item.signature,
          "x-kanon-event": item.eventHeader,
          "x-kanon-delivery": item.deliveryId,
        },
        body: item.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) failure = `HTTP ${response.status}`;
      // Drain the body so the connection can be reused/closed cleanly.
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure === undefined) return;
    if (item.attempts >= MAX_ATTEMPTS) {
      this.warn(
        `kanon-server: webhook ${item.webhookId} delivery ${item.deliveryId} FAILED after ` +
          `${item.attempts} attempts (${failure}) — dropped`,
      );
      return;
    }
    // Exponential backoff: interval * 2^attempts.
    item.notBefore = Date.now() + this.intervalMs * 2 ** item.attempts;
    this.queue.push(item);
    this.warn(
      `kanon-server: webhook ${item.webhookId} delivery ${item.deliveryId} attempt ` +
        `${item.attempts} failed (${failure}) — retrying`,
    );
  }
}
