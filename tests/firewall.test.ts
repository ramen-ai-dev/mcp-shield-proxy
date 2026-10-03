/**
 * Tests for firewall.ts — evaluate() and buildClient()
 *
 * Coverage:
 *   - ALLOWED verdict: evaluate() returns { allowed: true }
 *   - BLOCKED verdict: evaluate() returns { allowed: false, steering, anchors }
 *   - Fail-closed: transport error → { allowed: false, error }
 *   - buildClient: returns a RamenClient instance
 *   - Payload shape: tool name + arguments in evaluated input JSON
 *   - Receipt gate: an ALLOW is released only with a verified, signed ALLOW receipt
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProxyConfig } from "../src/types.js";
import { RECEIPT_ID, TEST_PUBLIC_KEYS, signedReceipt } from "./fixtures/receipts.js";
import type { TestReceipt } from "./fixtures/receipts.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: ProxyConfig = {
  apiKey: "ramen_ak_test",
  bundleIds: ["ramen__shield_core_it"],
  policyIds: [],
  targetCommand: "node",
  targetArgs: ["server.js"],
  logLevel: "silent",
};

const TOOL_PARAMS = {
  name: "drop_database_table",
  arguments: { table_name: "users_prod" },
};

const SIGNED_ALLOW = await signedReceipt({ verdict: 1 });

function makeVerdict(
  allowed: boolean,
  steering: string | null = null,
  evidence: { receipt?: TestReceipt; receiptVerified?: boolean; receiptReason?: string; receiptAlert?: string } = {},
) {
  // Allowed fixtures default to a genuine signed ALLOW receipt the SDK verified.
  const receipt = "receipt" in evidence ? evidence.receipt : allowed ? SIGNED_ALLOW : undefined;
  return {
    allowed,
    steering,
    policyIds: ["abc123"],
    statutoryAnchors: allowed ? [] : ["OWASP ASI-06"],
    receipt,
    receiptVerified: evidence.receiptVerified ?? (allowed && receipt !== undefined),
    receiptReason: evidence.receiptReason,
    receiptAlert: evidence.receiptAlert,
    data: {
      allowed,
      policy_ids: ["abc123"],
      policies_evaluated: 1,
      policies_passed: allowed ? 1 : 0,
      policies_failed: allowed ? 0 : 1,
      policies_errored: 0,
      total_violations: allowed
        ? []
        : [
            {
              rule_id: "r1",
              rule_name: "Destructive Execution",
              rule_content: "block",
              enforcement_level: "strict" as const,
              recovery_instruction: steering ?? "Refuse the request.",
            },
          ],
      results: [],
      execution_time_ms: 5,
      executed_at: "2026-06-27T12:00:00.000Z",
      statutory_anchors: allowed ? [] : ["OWASP ASI-06"],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evaluate()", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns allowed:true on ALLOWED verdict", async () => {
    const mockClient = {
      evaluateCompliance: vi.fn().mockResolvedValue(makeVerdict(true)),
    };

    const { evaluate } = await import("../src/firewall.js");
    const result = await evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never, TEST_PUBLIC_KEYS);

    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.receiptVerified).toBe(true);
    expect(result.receiptId).toBe(RECEIPT_ID);
  });

  it("returns allowed:false with steering on BLOCKED verdict", async () => {
    const mockClient = {
      evaluateCompliance: vi.fn().mockResolvedValue(
        makeVerdict(false, "Refuse destructive operations.")
      ),
    };

    const { evaluate } = await import("../src/firewall.js");
    const result = await evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never);

    expect(result.allowed).toBe(false);
    expect(result.steering).toBe("Refuse destructive operations.");
    expect(result.statutoryAnchors).toContain("OWASP ASI-06");
  });

  it("is fail-closed on transport error", async () => {
    const mockClient = {
      evaluateCompliance: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };

    const { evaluate } = await import("../src/firewall.js");
    const result = await evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never);

    expect(result.allowed).toBe(false);
    expect(result.error).toContain("Connection refused");
    expect(result.steering).toContain("fail-closed");
  });

  it("is fail-closed on HTTP 500 error", async () => {
    const mockClient = {
      evaluateCompliance: vi.fn().mockRejectedValue(new Error("evaluate failed: HTTP 500")),
    };

    const { evaluate } = await import("../src/firewall.js");
    const result = await evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never);

    expect(result.allowed).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("sends tool name and arguments in evaluation payload", async () => {
    const mockClient = {
      evaluateCompliance: vi.fn().mockResolvedValue(makeVerdict(true)),
    };

    const { evaluate } = await import("../src/firewall.js");
    await evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never);

    const [input] = mockClient.evaluateCompliance.mock.calls[0];
    const payload = JSON.parse(input as string);
    expect(payload.tool).toBe("drop_database_table");
    expect(payload.arguments).toEqual({ table_name: "users_prod" });
  });

  it("forwards bundle_ids to evaluateCompliance", async () => {
    const mockClient = {
      evaluateCompliance: vi.fn().mockResolvedValue(makeVerdict(true)),
    };

    const { evaluate } = await import("../src/firewall.js");
    await evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never);

    const [, opts] = mockClient.evaluateCompliance.mock.calls[0];
    expect((opts as { bundleIds: string[] }).bundleIds).toEqual(["ramen__shield_core_it"]);
  });

  it("uses policy_ids when bundle_ids is empty", async () => {
    const config = {
      ...BASE_CONFIG,
      bundleIds: [],
      policyIds: ["6c787849-96db-4c92-8df9-10aa8d035527"],
    };
    const mockClient = {
      evaluateCompliance: vi.fn().mockResolvedValue(makeVerdict(true)),
    };

    const { evaluate } = await import("../src/firewall.js");
    await evaluate(TOOL_PARAMS, config, mockClient as never);

    const [, opts] = mockClient.evaluateCompliance.mock.calls[0];
    expect((opts as { policyIds: string[] }).policyIds).toEqual([
      "6c787849-96db-4c92-8df9-10aa8d035527",
    ]);
  });
});

describe("evaluate() receipt gate", () => {
  async function evaluateWith(verdict: ReturnType<typeof makeVerdict>) {
    const mockClient = { evaluateCompliance: vi.fn().mockResolvedValue(verdict) };
    const { evaluate } = await import("../src/firewall.js");
    return evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never, TEST_PUBLIC_KEYS);
  }

  function expectFailClosed(result: Awaited<ReturnType<typeof evaluateWith>>, reason: RegExp) {
    expect(result.allowed).toBe(false);
    expect(result.receiptVerified).toBe(false);
    expect(result.error).toMatch(/receipt verification failed/);
    expect(result.error).toMatch(reason);
    expect(result.steering).toContain("fail-closed");
  }

  it("blocks an ALLOW with no receipt", async () => {
    expectFailClosed(await evaluateWith(makeVerdict(true, null, { receipt: undefined })), /no Schema V5 receipt/);
  });

  it("reports the server's receipt alert when signing was unavailable", async () => {
    const result = await evaluateWith(
      makeVerdict(true, null, { receipt: undefined, receiptAlert: "signing infrastructure unavailable" }),
    );
    expectFailClosed(result, /signing infrastructure unavailable/);
  });

  it("blocks an ALLOW whose receipt the SDK could not verify", async () => {
    const result = await evaluateWith(
      makeVerdict(true, null, { receiptVerified: false, receiptReason: "Signature does not verify" }),
    );
    expectFailClosed(result, /Signature does not verify/);
  });

  it("blocks an ALLOW that replays a genuine signed BLOCK receipt", async () => {
    // The SDK's receiptVerified does not read the signed verdict, so this
    // forgery passes it; the proxy's signed-verdict check must catch it.
    const block = await signedReceipt({ verdict: 0 });
    const result = await evaluateWith(makeVerdict(true, null, { receipt: block, receiptVerified: true }));
    expectFailClosed(result, /Signed verdict is not 1/);
    expect(result.receiptId).toBe(RECEIPT_ID);
  });

  it("blocks an ALLOW whose canonical payload was altered after signing", async () => {
    const tampered = await signedReceipt({ tamper: true });
    expectFailClosed(
      await evaluateWith(makeVerdict(true, null, { receipt: tampered, receiptVerified: true })),
      /Signature does not verify/,
    );
  });

  it("blocks an ALLOW signed by a key other than the pinned one", async () => {
    // The default production keys cannot verify a receipt signed with the test key.
    const mockClient = { evaluateCompliance: vi.fn().mockResolvedValue(makeVerdict(true)) };
    const { evaluate } = await import("../src/firewall.js");
    expectFailClosed(await evaluate(TOOL_PARAMS, BASE_CONFIG, mockClient as never), /Signature does not verify/);
  });

  it("leaves a BLOCK verdict as a block without requiring a receipt", async () => {
    const result = await evaluateWith(makeVerdict(false, "Refuse."));
    expect(result.allowed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.steering).toBe("Refuse.");
  });
});

describe("buildClient()", () => {
  it("returns an object with evaluateCompliance method", async () => {
    const { buildClient } = await import("../src/firewall.js");
    const client = buildClient(BASE_CONFIG);
    expect(typeof client.evaluateCompliance).toBe("function");
  });
});
