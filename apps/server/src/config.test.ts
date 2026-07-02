import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, parseApiKeys } from "./config";

describe("parseApiKeys", () => {
  test("parses key:actorId:actorType and optional sessionPrefix", () => {
    const keys = parseApiKeys("k1:carlos@example.com:human:sess, k2:claude:agent");
    expect(keys.size).toBe(2);
    expect(keys.get("k1")).toEqual({
      actorId: "carlos@example.com",
      actorType: "human",
      sessionPrefix: "sess",
    });
    expect(keys.get("k2")).toEqual({ actorId: "claude", actorType: "agent" });
  });

  test("rejects malformed entries", () => {
    expect(() => parseApiKeys("just-a-key")).toThrow(ConfigError);
    expect(() => parseApiKeys("k1:actor")).toThrow(ConfigError);
    expect(() => parseApiKeys("k1:actor:king")).toThrow(ConfigError);
    expect(() => parseApiKeys(":actor:human")).toThrow(ConfigError);
    expect(() => parseApiKeys("")).toThrow(ConfigError);
  });

  test("rejects duplicate tokens without echoing them", () => {
    expect(() => parseApiKeys("k1:a:human,k1:b:agent")).toThrow("duplicate key");
  });
});

describe("loadConfig", () => {
  const base = { KANON_DATA_DIR: "/tmp/repo", KANON_API_KEYS: "k:a:human" };

  test("applies defaults", () => {
    const config = loadConfig(base);
    expect(config.gitRemoteSync).toBe(true);
    expect(config.syncIntervalMs).toBe(30_000);
    expect(config.port).toBe(3000);
  });

  test("KANON_GIT_REMOTE_SYNC=0 disables remote sync", () => {
    expect(loadConfig({ ...base, KANON_GIT_REMOTE_SYNC: "0" }).gitRemoteSync).toBe(false);
  });

  test("requires KANON_DATA_DIR and KANON_API_KEYS", () => {
    expect(() => loadConfig({ KANON_API_KEYS: "k:a:human" })).toThrow(ConfigError);
    expect(() => loadConfig({ KANON_DATA_DIR: "/tmp/repo" })).toThrow(ConfigError);
  });

  test("rejects non-integer intervals", () => {
    expect(() => loadConfig({ ...base, KANON_SYNC_INTERVAL: "soon" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, KANON_SYNC_INTERVAL: "0" })).toThrow(ConfigError);
  });
});
