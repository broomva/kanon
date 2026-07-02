/**
 * SSE — /v1/stream emits each newly-ingested event as `data: <json>` over a
 * raw fetch stream.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { KanonEvent } from "@kanon/core";
import { boot, cleanup, headers, ok } from "./test-helpers";

afterEach(() => {
  cleanup();
});

/**
 * Frame-at-a-time SSE reader with a PERSISTENT buffer: one network chunk can
 * carry many frames, and frames past the match must survive for later reads.
 */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async until(predicate: (frame: string) => boolean, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let boundary = this.buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        if (predicate(frame)) return frame;
        boundary = this.buffer.indexOf("\n\n");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE timeout; buffered: ${this.buffer.slice(0, 400)}`);
      const chunk = await Promise.race([
        this.reader.read(),
        Bun.sleep(remaining).then(() => "timeout" as const),
      ]);
      if (chunk === "timeout") {
        throw new Error(`SSE timeout; buffered: ${this.buffer.slice(0, 400)}`);
      }
      if (chunk.done) throw new Error("SSE stream closed early");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

describe("SSE", () => {
  test("requires auth", async () => {
    const { url } = boot();
    const response = await fetch(`${url}/v1/stream`);
    expect(response.status).toBe(401);
  });

  test("receives an ingested event", async () => {
    const { url } = boot();
    const response = await fetch(`${url}/v1/stream`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = response.body;
    if (body === null) throw new Error("no SSE body");
    const stream = new SseReader(body);

    // The hello frame confirms the subscription is live before we write.
    await stream.until((frame) => frame.includes("event: hello"));

    await ok(url, "POST", "/v1/teams", { key: "BRO", name: "Broomva" });

    const frame = await stream.until((chunk) => chunk.includes('"model":"team"'));
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) throw new Error(`no data line in frame: ${frame}`);
    const event = JSON.parse(dataLine.slice(6)) as KanonEvent;
    expect(event.model).toBe("team");
    expect(event.op).toBe("create");
    expect(event.data.key).toBe("BRO");
    expect(event.workspace).toBe("test");

    // The 7 seeded workflow states stream through the same connection.
    await stream.until((chunk) => chunk.includes('"model":"workflow_state"'));

    await stream.close();
  });
});
