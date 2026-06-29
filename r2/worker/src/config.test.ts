import { loadConfig, Env } from "./config";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ROOTKEY_API_URL: "https://api.test.rootkey.ai",
    ROOTKEY_API_KEY: "rk_conn_test",
    BUCKET: {} as any,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("returns defaults when MAX_FILE_SIZE_BYTES is unset", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.rootkeyApiUrl).toBe("https://api.test.rootkey.ai");
    expect(cfg.rootkeyApiKey).toBe("rk_conn_test");
    expect(cfg.maxFileSizeBytes).toBe(524_288_000);
  });

  it("strips a trailing slash from the API URL", () => {
    const cfg = loadConfig(baseEnv({ ROOTKEY_API_URL: "https://api.test.rootkey.ai/" }));
    expect(cfg.rootkeyApiUrl).toBe("https://api.test.rootkey.ai");
  });

  it("rejects empty ROOTKEY_API_URL", () => {
    expect(() => loadConfig(baseEnv({ ROOTKEY_API_URL: "" }))).toThrow(/ROOTKEY_API_URL/);
    expect(() => loadConfig(baseEnv({ ROOTKEY_API_URL: "   " }))).toThrow(/ROOTKEY_API_URL/);
  });

  it("rejects non-https ROOTKEY_API_URL", () => {
    expect(() => loadConfig(baseEnv({ ROOTKEY_API_URL: "http://api.test.rootkey.ai" }))).toThrow(
      /must use https/,
    );
  });

  it("rejects empty ROOTKEY_API_KEY", () => {
    expect(() => loadConfig(baseEnv({ ROOTKEY_API_KEY: "" }))).toThrow(/ROOTKEY_API_KEY/);
    expect(() => loadConfig(baseEnv({ ROOTKEY_API_KEY: "  " }))).toThrow(/ROOTKEY_API_KEY/);
  });

  it("parses a valid MAX_FILE_SIZE_BYTES", () => {
    const cfg = loadConfig(baseEnv({ MAX_FILE_SIZE_BYTES: "1048576" }));
    expect(cfg.maxFileSizeBytes).toBe(1_048_576);
  });

  it("rejects non-positive MAX_FILE_SIZE_BYTES", () => {
    expect(() => loadConfig(baseEnv({ MAX_FILE_SIZE_BYTES: "0" }))).toThrow(/positive/);
    expect(() => loadConfig(baseEnv({ MAX_FILE_SIZE_BYTES: "-1" }))).toThrow(/positive/);
  });

  it("rejects non-numeric MAX_FILE_SIZE_BYTES", () => {
    expect(() => loadConfig(baseEnv({ MAX_FILE_SIZE_BYTES: "abc" }))).toThrow(/positive number/);
  });

  it("treats empty string MAX_FILE_SIZE_BYTES as unset (falls back to default)", () => {
    const cfg = loadConfig(baseEnv({ MAX_FILE_SIZE_BYTES: "" }));
    expect(cfg.maxFileSizeBytes).toBe(524_288_000);
  });

  it("floors fractional MAX_FILE_SIZE_BYTES", () => {
    const cfg = loadConfig(baseEnv({ MAX_FILE_SIZE_BYTES: "1048576.9" }));
    expect(cfg.maxFileSizeBytes).toBe(1_048_576);
  });
});
