/**
 * Tests for the proxy's native query_domain_memory tool and provenance envelope.
 *
 * A fake downstream MCP server (tests/fixtures/fake-mcp-server.mjs) answers
 * tools/list and tools/call, so these tests exercise the full round trip:
 * client → proxy → child → proxy → client.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { RemoteForgeMemoryStore } from "@ramen-ai/node-core";
import type { ProxyConfig } from "../src/types.js";
import { parseMemoryArguments, MEMORY_TOOL_DEFINITION, PROVENANCE_META_KEY } from "../src/memory-tool.js";
import { RECEIPT_ID, TEST_PUBLIC_KEYS, signedReceipt } from "./fixtures/receipts.js";

const SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const FORGE = "https://forge.example.test";
const FINGERPRINT = "594ec7f65c65f2d0a009e193ed80f22f8cdcab5fcad16bf9360f515c7d43f9c2";

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    apiKey: "ramen_ak_test",
    bundleIds: ["ramen__shield_core_it"],
    policyIds: [],
    targetCommand: process.execPath,
    targetArgs: [SERVER],
    logLevel: "silent",
    domain: "fintech",
    ...overrides,
  };
}

const EXEMPLAR = {
  exemplar_id: "a6716c3a-bda8-4228-80b9-8d15969bc50f",
  domain: "fintech",
  task_description: "Formulate a compliant adverse action notice.",
  task_fingerprint: FINGERPRINT,
  tool_name: "issue_credit_adverse_action",
  failed_arguments: { reg_b_reason_codes: ["REGIONAL_ECONOMIC_VOLATILITY_ZIP_CODE"] },
  violation_reason: "Denial cites ZIP code as adverse factor.",
  primary_statutory_anchor: "Equal Credit Opportunity Act, 15 U.S.C. § 1691",
  steering_directive: "Use documented neutral creditworthiness factors.",
  repaired_arguments: { reg_b_reason_codes: ["INSUFFICIENT_LIQUIDITY"] },
  receipt_id: RECEIPT_ID,
  created_at: "2026-10-02T12:00:00+00:00",
  tier: "community",
  signature: "c2ln",
  canonical_payload: "{}",
};

function forgeStore(exemplars: unknown[] = [EXEMPLAR], seen: URL[] = []) {
  return new RemoteForgeMemoryStore({
    baseUrl: FORGE,
    domain: "fintech",
    logger: { warn: () => {}, info: () => {} },
    fetchImpl: (async (url: string) => {
      seen.push(new URL(url));
      return new Response(JSON.stringify({ success: true, count: exemplars.length, exemplars }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
}

async function verdict(allowed: boolean) {
  return {
    allowed,
    steering: allowed ? null : "Refuse.",
    policyIds: [],
    statutoryAnchors: allowed ? [] : ["OWASP ASI-06"],
    receipt: await signedReceipt({ verdict: allowed ? 1 : 0 }),
    receiptVerified: true,
    data: {} as never,
  };
}

async function run(
  lines: object[],
  opts: { allowed?: boolean; store?: RemoteForgeMemoryStore; config?: Partial<ProxyConfig> } = {},
) {
  const { runProxy } = await import("../src/proxy.js");
  const client = { evaluateCompliance: vi.fn().mockResolvedValue(await verdict(opts.allowed ?? true)) };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));

  const done = runProxy(config(opts.config), client as never, {
    stdin,
    stdout,
    memoryStore: opts.store ?? forgeStore(),
    publicKeys: TEST_PUBLIC_KEYS,
  });
  // Like a real MCP client, wait for each response before sending the next request.
  for (const line of lines as { id?: unknown }[]) {
    stdin.write(JSON.stringify(line) + "\n");
    const expected = JSON.stringify(line.id);
    for (let i = 0; i < 300 && !chunks.join("").split("\n").some((l) => l.includes(`"id":${expected}`)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  stdin.end();
  await done;

  const responses = chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const byId = (id: unknown) => responses.find((r) => r.id === id);
  return { responses, byId, client };
}

describe("query_domain_memory tool", () => {
  it("is appended to the downstream tools/list response", async () => {
    const { byId } = await run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const tools = byId(1).result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["read_file", "query_domain_memory"]);
    const memoryTool = tools[1];
    expect(memoryTool.inputSchema.required).toEqual(["tool_name"]);
    expect(Object.keys(memoryTool.inputSchema.properties)).toEqual(["domain", "tool_name", "query"]);
    expect(memoryTool.description).toContain("ramen forge");
    expect(byId(1).result.nextCursor).toBe("page-2"); // other fields preserved
  });

  it("is not repeated on later tools/list pages", async () => {
    const { byId } = await run([{ jsonrpc: "2.0", id: "p2", method: "tools/list", params: { cursor: "page-2" } }]);
    expect(byId("p2").result.tools).toEqual([]);
  });

  it("does not shadow a downstream tool with the same name", async () => {
    const { byId, client } = await run(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query_domain_memory", arguments: {} } },
      ],
      { config: { targetArgs: [SERVER, "with-memory-tool"] } },
    );
    const names = byId(1).result.tools.map((t: { name: string }) => t.name);
    expect(names.filter((n: string) => n === "query_domain_memory")).toHaveLength(1);
    // Routed through the governed path to the downstream server instead.
    expect(client.evaluateCompliance).toHaveBeenCalledTimes(1);
    expect(byId(2).result.content[0].text).toBe("downstream handled query_domain_memory");
  });

  it("returns exemplars from ramen forge without evaluating or forwarding the call", async () => {
    const seen: URL[] = [];
    const { byId, client } = await run(
      [
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "query_domain_memory", arguments: { tool_name: "issue_credit_adverse_action", query: "ZIP" } },
        },
      ],
      { store: forgeStore([EXEMPLAR], seen) },
    );
    const result = byId(7).result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.exemplars[0]).toMatchObject({
      exemplar_id: EXEMPLAR.exemplar_id,
      statutory_anchor: EXEMPLAR.primary_statutory_anchor,
      steering_directive: EXEMPLAR.steering_directive,
      signed: true,
    });
    expect(result.content[0].text).toContain("INSUFFICIENT_LIQUIDITY");
    expect(Object.fromEntries(seen[0].searchParams)).toEqual({
      domain: "fintech", limit: "5", tool_name: "issue_credit_adverse_action", q: "ZIP",
    });
    const provenance = result._meta[PROVENANCE_META_KEY];
    expect(provenance).toMatchObject({
      source: "ramen-forge",
      version: "1.0",
      exemplar_id: EXEMPLAR.exemplar_id,
      receipt_id: RECEIPT_ID,
    });
    expect(new URL(provenance.audit_uri).searchParams.get("task_fingerprint")).toBe(FINGERPRINT);
    expect(client.evaluateCompliance).not.toHaveBeenCalled();
  });

  it("honours an explicit domain and reports an empty result plainly", async () => {
    const seen: URL[] = [];
    const { byId } = await run(
      [{ jsonrpc: "2.0", id: 8, method: "tools/call",
         params: { name: "query_domain_memory", arguments: { tool_name: "place_material", domain: "industrial_iot" } } }],
      { store: forgeStore([], seen) },
    );
    expect(seen[0].searchParams.get("domain")).toBe("industrial_iot");
    expect(byId(8).result.structuredContent.count).toBe(0);
    expect(byId(8).result.content[0].text).toContain("no recorded lessons");
    expect(byId(8).result._meta[PROVENANCE_META_KEY].source).toBe("ramen-local");
  });

  it("returns an isError result for invalid arguments", async () => {
    const { byId } = await run([
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "query_domain_memory", arguments: { domain: "fintech" } } },
    ]);
    expect(byId(9).result.isError).toBe(true);
    expect(byId(9).result.content[0].text).toContain("tool_name");
  });

  it("fails open when ramen forge is unreachable", async () => {
    const offline = new RemoteForgeMemoryStore({
      baseUrl: FORGE,
      logger: { warn: () => {} },
      fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    const { byId } = await run(
      [{ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "query_domain_memory", arguments: { tool_name: "x" } } }],
      { store: offline },
    );
    expect(byId(10).result.isError).toBeUndefined();
    expect(byId(10).result.structuredContent.count).toBe(0);
  });

  it("validates arguments", () => {
    expect(parseMemoryArguments({ tool_name: " t " })).toEqual({ tool_name: "t" });
    for (const bad of [undefined, [], { tool_name: "" }, { tool_name: "t", domain: "Fin Tech" },
      { tool_name: "t", query: "x".repeat(101) }, { tool_name: "t", extra: 1 }]) {
      expect(typeof parseMemoryArguments(bad)).toBe("string");
    }
    expect(MEMORY_TOOL_DEFINITION.annotations.readOnlyHint).toBe(true);
  });
});

describe("provenance on governed tool calls", () => {
  it("attaches provenance to an allowed downstream result and keeps existing _meta", async () => {
    const { byId } = await run([
      { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "read_file", arguments: { path: "a" } } },
    ]);
    const result = byId(20).result;
    expect(result.content[0].text).toBe("downstream handled read_file");
    expect(result._meta["example.com/trace"]).toBe("keep-me");
    expect(result._meta[PROVENANCE_META_KEY]).toEqual({
      source: "ramen-local",
      version: "1.0",
      domain: "fintech",
      tool_name: "read_file",
      exemplar_id: null,
      statutory_anchor: null,
      receipt_id: RECEIPT_ID,
      prevention_summary: null,
      audit_uri: null,
    });
  });

  it("attaches provenance to a blocked response", async () => {
    const { byId } = await run(
      [{ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "drop_db", arguments: {} } }],
      { allowed: false },
    );
    expect(byId(21).result.isError).toBe(true);
    expect(byId(21).result._meta[PROVENANCE_META_KEY]).toMatchObject({ tool_name: "drop_db", receipt_id: RECEIPT_ID });
  });

  it("leaves downstream JSON-RPC errors and other traffic unchanged", async () => {
    const { byId } = await run([
      { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "fail_tool", arguments: {} } },
      { jsonrpc: "2.0", id: 23, method: "resources/list" },
    ]);
    expect(byId(22).error.message).toBe("boom");
    expect(byId(22).result).toBeUndefined();
    expect(byId(23).result).toEqual({ echoed: "resources/list" });
  });
});
