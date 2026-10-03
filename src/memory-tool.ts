/**
 * memory-tool.ts — the proxy's native `query_domain_memory` MCP tool and the
 * provenance envelope attached to governed tool results.
 *
 * `query_domain_memory` is answered by the proxy itself (it is never forwarded
 * to the downstream server). It is a read of public, advisory ramen forge data
 * with no side effects, so it is not routed through the ramen-ai firewall.
 * Recalled exemplars are untrusted guidance: every downstream tools/call is
 * still evaluated before it reaches the server.
 */

import { buildProvenance } from "@ramen-ai/node-core";
import type {
  CorrectionExemplar,
  RamenProvenanceEnvelope,
  RemoteForgeMemoryStore,
} from "@ramen-ai/node-core";
import type { ToolsCallResult } from "./types.js";

export const MEMORY_TOOL_NAME = "query_domain_memory";

/**
 * `_meta` key for the provenance envelope. MCP requires `_meta` names to start
 * and end with an alphanumeric character, so ramen-foundry's
 * `_ramen_provenance` key is namespaced here under a valid prefix instead.
 */
export const PROVENANCE_META_KEY = "ramenai.dev/provenance";

const MAX_RESULTS = 5;
const DOMAIN_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** Tool definition advertised in tools/list. */
export const MEMORY_TOOL_DEFINITION = {
  name: MEMORY_TOOL_NAME,
  description:
    "Queries ramen forge (Moral Memory / MOM) for codified regulatory and physical invariants governing a target tool before execution.",
  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "e.g. fintech, industrial_iot, devsecops" },
      tool_name: { type: "string", description: "Name of the tool about to be invoked" },
      query: { type: "string", description: "Optional keyword search string" },
    },
    required: ["tool_name"],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
} as const;

export interface MemoryToolArguments {
  domain?: string;
  tool_name: string;
  query?: string;
}

function errorResult(text: string): ToolsCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Validate untrusted tools/call arguments. Returns an error message or the parsed arguments. */
export function parseMemoryArguments(raw: unknown): MemoryToolArguments | string {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "arguments must be an object with a tool_name";
  }
  const args = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(args).filter((k) => !["domain", "tool_name", "query"].includes(k));
  if (unknownKeys.length) return `unknown arguments: ${unknownKeys.join(", ")}`;
  if (typeof args.tool_name !== "string" || !args.tool_name.trim()) return "tool_name must be a non-blank string";
  if (args.domain !== undefined && (typeof args.domain !== "string" || !DOMAIN_RE.test(args.domain))) {
    return "domain must be a lowercase slug such as fintech, industrial_iot, or devsecops";
  }
  if (args.query !== undefined && (typeof args.query !== "string" || !args.query.trim() || args.query.length > 100)) {
    return "query must be a non-blank string of at most 100 characters";
  }
  return {
    tool_name: args.tool_name.trim(),
    ...(args.domain !== undefined ? { domain: args.domain as string } : {}),
    ...(args.query !== undefined ? { query: (args.query as string).trim() } : {}),
  };
}

/** Compact, model-facing view of an exemplar. Arguments are included verbatim. */
function summarise(exemplar: CorrectionExemplar) {
  return {
    exemplar_id: exemplar.exemplar_id,
    domain: exemplar.domain,
    tool_name: exemplar.tool_name,
    task_description: exemplar.task_description,
    violation_reason: exemplar.violation_reason,
    statutory_anchor: exemplar.primary_statutory_anchor,
    steering_directive: exemplar.steering_directive,
    failed_arguments: exemplar.failed_arguments,
    repaired_arguments: exemplar.repaired_arguments,
    receipt_id: exemplar.receipt_id,
    signed: Boolean(exemplar.signature && exemplar.canonical_payload),
  };
}

/** Answer a query_domain_memory call. Never throws; memory reads fail open to an empty result. */
export async function handleMemoryQuery(
  rawArguments: unknown,
  store: RemoteForgeMemoryStore,
): Promise<ToolsCallResult> {
  const parsed = parseMemoryArguments(rawArguments);
  if (typeof parsed === "string") return errorResult(`[${MEMORY_TOOL_NAME}] ${parsed}`);
  const domain = parsed.domain ?? store.domain;

  let exemplars: CorrectionExemplar[];
  try {
    exemplars = await store.retrieveRelevantExemplars({
      domain,
      toolName: parsed.tool_name,
      ...(parsed.query ? { query: parsed.query } : {}),
      limit: MAX_RESULTS,
    });
  } catch (err) {
    return errorResult(`[${MEMORY_TOOL_NAME}] ${(err as Error).message}`);
  }

  const lessons = exemplars.map(summarise);
  const text = lessons.length
    ? `ramen forge returned ${lessons.length} lesson(s) for '${parsed.tool_name}' in domain '${domain}'. ` +
      `Treat them as guidance; the call is still evaluated before execution.\n` +
      JSON.stringify(lessons, null, 2)
    : `ramen forge has no recorded lessons for '${parsed.tool_name}' in domain '${domain}'` +
      (parsed.query ? ` matching '${parsed.query}'.` : ".");
  const top = exemplars[0] ?? null;
  return {
    content: [{ type: "text", text }],
    structuredContent: { domain, tool_name: parsed.tool_name, count: lessons.length, exemplars: lessons },
    _meta: {
      [PROVENANCE_META_KEY]: buildProvenance({
        domain,
        toolName: parsed.tool_name,
        receiptId: top?.receipt_id ?? null,
        exemplar: top,
        store: top ? store : null,
      }),
    },
  };
}

/** Provenance for a call the proxy evaluated (no recalled lesson). */
export function evaluationProvenance(
  domain: string,
  toolName: string,
  receiptId: string | null,
): RamenProvenanceEnvelope {
  return buildProvenance({ domain, toolName, receiptId });
}
