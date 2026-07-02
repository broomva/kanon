/**
 * Webhook delivery — a second Bun.serve acts as the receiver; deliveries are
 * signed with HMAC-SHA256 over the exact body bytes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { KanonEvent } from "@kanon/core";
import { api, boot, cleanup, ok, waitFor } from "./test-helpers";

interface Captured {
  body: string;
  signature: string | null;
  eventHeader: string | null;
  delivery: string | null;
}

const receivers: { stop(): void }[] = [];

afterEach(() => {
  cleanup();
  while (receivers.length > 0) {
    receivers.pop()?.stop();
  }
});

/** A localhost receiver that fails the first `failures` requests with 500. */
function receiver(failures = 0): { url: string; captured: Captured[]; attempts: () => number } {
  const captured: Captured[] = [];
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      attempts += 1;
      if (attempts <= failures) {
        return new Response("boom", { status: 500 });
      }
      captured.push({
        body: await request.text(),
        signature: request.headers.get("x-kanon-signature"),
        eventHeader: request.headers.get("x-kanon-event"),
        delivery: request.headers.get("x-kanon-delivery"),
      });
      return new Response("ok");
    },
  });
  receivers.push({ stop: () => server.stop(true) });
  return { url: `http://localhost:${server.port}`, captured, attempts: () => attempts };
}

describe("webhooks", () => {
  test("delivers matching events with a correct HMAC signature", async () => {
    const { url } = boot();
    const sink = receiver();

    const created = await ok(url, "POST", "/v1/webhooks", {
      url: sink.url,
      secret: "s3cret",
      resourceTypes: ["team"],
    });
    const webhook = created.webhook as Record<string, unknown>;
    expect(webhook.id).toBeDefined();
    expect(JSON.stringify(created)).not.toContain("s3cret"); // secrets never leave

    const listed = await ok(url, "GET", "/v1/webhooks");
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    expect((listed.webhooks as unknown[]).length).toBe(1);

    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });

    const delivery = await waitFor(() => sink.captured[0], 5000, "webhook delivery");
    const expected = createHmac("sha256", "s3cret").update(delivery.body).digest("hex");
    expect(delivery.signature).toBe(expected);
    expect(delivery.eventHeader).toBe("team.create");
    expect(delivery.delivery).not.toBeNull();

    const event = JSON.parse(delivery.body) as KanonEvent;
    expect(event.model).toBe("team");
    expect(event.data.key).toBe("BRO");

    // resourceTypes filter: the 7 workflow_state events never arrive.
    await Bun.sleep(150);
    expect(
      sink.captured.every((item) => (JSON.parse(item.body) as KanonEvent).model === "team"),
    ).toBe(true);
    expect(sink.captured.length).toBe(1);
  });

  test("retries with backoff and eventually delivers", async () => {
    const { url } = boot();
    const flaky = receiver(2); // 500, 500, then 200s

    await ok(url, "POST", "/v1/webhooks", {
      url: flaky.url,
      secret: "retry-secret",
      resourceTypes: ["project"],
    });
    await ok(url, "POST", "/v1/projects", { name: "Retry" });

    const delivery = await waitFor(() => flaky.captured[0], 5000, "retried delivery");
    expect(flaky.attempts()).toBe(3);
    const expected = createHmac("sha256", "retry-secret").update(delivery.body).digest("hex");
    expect(delivery.signature).toBe(expected);
  });

  test("delete stops future deliveries; validation rejects junk", async () => {
    const { url } = boot();
    const sink = receiver();

    const created = await ok(url, "POST", "/v1/webhooks", {
      url: sink.url,
      secret: "s",
      resourceTypes: ["team"],
    });
    const id = (created.webhook as { id: string }).id;
    await ok(url, "DELETE", `/v1/webhooks/${id}`);
    expect(((await ok(url, "GET", "/v1/webhooks")).webhooks as unknown[]).length).toBe(0);

    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });
    await Bun.sleep(150);
    expect(sink.captured.length).toBe(0);

    expect(
      (
        await api(url, "POST", "/v1/webhooks", {
          url: "ftp://x",
          secret: "s",
          resourceTypes: ["team"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(url, "POST", "/v1/webhooks", {
          url: sink.url,
          secret: "s",
          resourceTypes: ["bogus"],
        })
      ).status,
    ).toBe(400);
    expect((await api(url, "DELETE", `/v1/webhooks/${id}`)).status).toBe(404);
  });
});
