import { describe, expect, test } from "bun:test";
import { isPrivateWebhookHost } from "./webhook-guard";

describe("isPrivateWebhookHost", () => {
  test("blocks loopback + link-local + private v4 literals", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "169.254.169.254", // cloud metadata
      "10.0.0.5",
      "172.16.9.9",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // CGNAT / Tailscale
      "0.0.0.0",
    ]) {
      expect(isPrivateWebhookHost(host)).toBe(true);
    }
  });

  test("blocks loopback names + v6 loopback / ULA / link-local", () => {
    expect(isPrivateWebhookHost("localhost")).toBe(true);
    expect(isPrivateWebhookHost("db.localhost")).toBe(true);
    expect(isPrivateWebhookHost("[::1]")).toBe(true);
    expect(isPrivateWebhookHost("::1")).toBe(true);
    expect(isPrivateWebhookHost("fd12:3456::1")).toBe(true); // ULA
    expect(isPrivateWebhookHost("fe80::1")).toBe(true); // link-local
    expect(isPrivateWebhookHost("::ffff:169.254.169.254")).toBe(true); // mapped metadata
  });

  test("strips a fully-qualified trailing dot before the name/IP check", () => {
    expect(isPrivateWebhookHost("localhost.")).toBe(true);
    expect(isPrivateWebhookHost("db.localhost.")).toBe(true);
    expect(isPrivateWebhookHost("127.0.0.1.")).toBe(true);
    expect(isPrivateWebhookHost("example.com.")).toBe(false);
  });

  test("allows public literals + DNS names", () => {
    for (const host of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1", // just outside 172.16/12
      "2606:4700:4700::1111",
      "example.com",
      "hooks.slack.com",
    ]) {
      expect(isPrivateWebhookHost(host)).toBe(false);
    }
  });
});
