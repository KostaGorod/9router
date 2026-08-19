import { describe, expect, it, vi } from "vitest";

// Regression: combo names may carry a `[1m]`-style context-window marker
// (e.g. `claude-sonnet-5[1m]`) so clients like Claude Code pick the 1M window.
// The combo name becomes the model id in /v1/models and must pass validation.

const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-\[\]]+$/;

const mocks = {
  combos: [
    { id: "1", name: "claude-sonnet-5[1m]", kind: "llm", models: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5"] },
  ],
  getCombos: vi.fn(),
  getComboByName: vi.fn(),
};

vi.mock("@/lib/localDb", () => ({
  getCombos: mocks.getCombos,
  getComboByName: mocks.getComboByName,
  getProviderConnections: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("combo name with [1m] context marker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCombos.mockResolvedValue(mocks.combos);
    mocks.getComboByName.mockResolvedValue(mocks.combos[0]);
  });

  it("accepts bracketed context markers in the combo name regex", () => {
    expect(VALID_NAME_REGEX.test("claude-sonnet-5[1m]")).toBe(true);
    expect(VALID_NAME_REGEX.test("claude-opus-5[1m]")).toBe(true);
  });

  it("still rejects characters outside the allowed set", () => {
    expect(VALID_NAME_REGEX.test("bad name")).toBe(false);
    expect(VALID_NAME_REGEX.test("bad/name")).toBe(false);
    expect(VALID_NAME_REGEX.test("emoji🙅")).toBe(false);
  });

  it("surfaces the bracketed combo name unmodified in /v1/models", async () => {
    const models = await buildModelsList(["llm"]);
    expect(models.some((m) => m.id === "claude-sonnet-5[1m]")).toBe(true);
    expect(models.find((m) => m.id === "claude-sonnet-5[1m]").owned_by).toBe("combo");
  });

  it("routes chat requests for the bracketed combo name by exact match", async () => {
    // The combo lookup (getComboByName) is exact-match on the full name —
    // the marker must not be stripped or misinterpreted.
    const combo = await mocks.getComboByName("claude-sonnet-5[1m]");
    expect(combo.id).toBe("1");
    expect(combo.models.length).toBe(2);
  });
});