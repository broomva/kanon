/**
 * SSRF guard for webhook targets. `createWebhook` otherwise accepts any http(s)
 * URL, so an authed key holder could make the server issue signed POSTs to
 * internal services — cloud metadata (169.254.169.254), localhost, RFC-1918.
 * We refuse loopback / link-local / private IP literals unless the operator
 * opts in with KANON_WEBHOOK_ALLOW_PRIVATE=1 (tests, trusted single-tenant).
 *
 * Residual (documented, out of scope for v1): a public DNS name that resolves
 * to a private address (DNS rebinding). Closing it needs resolution at delivery
 * time; operators who need it lock down with an allowlist instead.
 */

import { BlockList, isIP } from "node:net";

const PRIVATE = new BlockList();
// IPv4 — this-host, RFC-1918, CGNAT/shared (Tailscale), loopback, link-local.
PRIVATE.addSubnet("0.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addAddress("255.255.255.255", "ipv4");
// IPv6 — unspecified, loopback, unique-local (fc00::/7), link-local (fe80::/10).
PRIVATE.addAddress("::", "ipv6");
PRIVATE.addAddress("::1", "ipv6");
PRIVATE.addSubnet("fc00::", 7, "ipv6");
PRIVATE.addSubnet("fe80::", 10, "ipv6");

const MAPPED_V4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * True when `hostname` (a URL host) is a loopback / link-local / private
 * address literal, or a loopback name. DNS names that are not literals return
 * false — they cannot be classified without resolving.
 */
export function isPrivateWebhookHost(hostname: string): boolean {
  // Drop IPv6 brackets + zone id, lowercase, and strip a fully-qualified
  // trailing dot ("localhost." resolves to localhost just like "localhost").
  const host = (hostname.replace(/^\[|\]$/g, "").split("%")[0] ?? "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const family = isIP(host);
  if (family === 4) return PRIVATE.check(host, "ipv4");
  if (family === 6) {
    // IPv4-mapped (::ffff:169.254.169.254) — classify the embedded v4.
    const mapped = MAPPED_V4.exec(host);
    if (mapped?.[1] && isIP(mapped[1]) === 4) return PRIVATE.check(mapped[1], "ipv4");
    return PRIVATE.check(host, "ipv6");
  }
  return false;
}
