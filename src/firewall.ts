/**
 * firewall.ts — ramen-ai evaluation wrapper for the MCP proxy.
 *
 * Evaluates a tools/call payload against the ramen-ai PaaS API and returns
 * a structured verdict. Fail-closed: any transport or parse error is treated
 * as a denial so an unreachable firewall never becomes an open door.
 *
 * An ALLOW is released only with cryptographic evidence, matching
 * ramen-foundry's RamenToolNode. All three must hold:
 *
 *   1. A Schema V5 receipt is present.
 *   2. The SDK verified it against this exact input (`receiptVerified`:
 *      Ed25519 signature under the pinned key, plus the payload_hash binding).
 *   3. The *signed* payload records verdict 1 (ALLOW), with matching kid and id.
 *
 * Check 3 is needed because check 2 does not read the signed verdict: a
 * genuine BLOCK receipt for the same input, returned with `allowed: true`,
 * passes check 2 but fails check 3.
 */

import { AUDIT_PUBLIC_KEYS, RamenClient, verifyAllowReceiptSignature } from "@ramen-ai/node-core";
import type { ComplianceVerdict } from "@ramen-ai/node-core";
import type { ProxyConfig, ToolsCallParams } from "./types.js";

export interface FirewallVerdict {
  allowed: boolean;
  steering: string | null;
  statutoryAnchors: string[];
  receiptVerified: boolean;
  /** Schema V5 receipt id of the evaluation, when one was returned */
  receiptId: string | null;
  /** Present when the call was blocked due to an evaluation or verification error */
  error?: string;
}

/**
 * Evaluate a tools/call against the ramen-ai firewall.
 *
 * The evaluation payload is a JSON object containing the tool name and its
 * resolved arguments — giving the evaluator full context about what the
 * agent is about to do.
 *
 * `publicKeys` overrides the receipt verification keys (tests only); it must
 * be the same key map the client verifies with.
 */
export async function evaluate(
  params: ToolsCallParams,
  config: ProxyConfig,
  client: RamenClient,
  publicKeys: Record<string, string> = AUDIT_PUBLIC_KEYS,
): Promise<FirewallVerdict> {
  const payload = JSON.stringify({
    tool: params.name,
    arguments: params.arguments ?? {},
  });

  let verdict: ComplianceVerdict;
  try {
    verdict = await client.evaluateCompliance(payload, {
      bundleIds: config.bundleIds.length ? config.bundleIds : undefined,
      policyIds: config.policyIds.length ? config.policyIds : undefined,
      context: { tool_name: params.name },
    });
  } catch (err) {
    // Fail-closed: evaluation errors are treated as blocks.
    const message = err instanceof Error ? err.message : String(err);
    return {
      allowed: false,
      steering:
        `ramen-ai evaluation could not complete (fail-closed). ` +
        `Tool '${params.name}' has been blocked. Error: ${message}`,
      statutoryAnchors: [],
      receiptVerified: false,
      receiptId: null,
      error: message,
    };
  }

  const receiptId = verdict.receipt?.id ?? null;

  if (verdict.allowed) {
    const unverified = await allowEvidenceProblem(verdict, publicKeys);
    if (unverified) {
      // Fail-closed: an ALLOW without verifiable evidence is treated as a block.
      return {
        allowed: false,
        steering:
          `Tool '${params.name}' was not executed because the ramen-ai ALLOW verdict ` +
          `could not be cryptographically verified (fail-closed): ${unverified}`,
        statutoryAnchors: verdict.statutoryAnchors,
        receiptVerified: false,
        receiptId,
        error: `receipt verification failed: ${unverified}`,
      };
    }
  }

  return {
    allowed: verdict.allowed,
    steering: verdict.steering,
    statutoryAnchors: verdict.statutoryAnchors,
    receiptVerified: verdict.receiptVerified,
    receiptId,
  };
}

/** Return why an ALLOW verdict lacks verifiable evidence, or null if it is sound. */
async function allowEvidenceProblem(
  verdict: ComplianceVerdict,
  publicKeys: Record<string, string>,
): Promise<string | null> {
  if (!verdict.receipt) {
    return verdict.receiptAlert
      ? `no receipt returned (${verdict.receiptAlert})`
      : "no Schema V5 receipt returned";
  }
  if (!verdict.receiptVerified) {
    return verdict.receiptReason ?? "receipt signature or input binding did not verify";
  }
  const signed = await verifyAllowReceiptSignature(verdict.receipt, publicKeys);
  return signed.valid ? null : signed.reason;
}

/** Build a RamenClient from proxy config. */
export function buildClient(config: ProxyConfig): RamenClient {
  return new RamenClient({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.providerKey ? { providerKey: config.providerKey } : {}),
    ...(config.providerName ? { providerName: config.providerName } : {}),
  });
}
