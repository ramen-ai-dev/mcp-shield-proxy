/**
 * proxy.ts — MCP stdio transport interceptor.
 *
 * Spawns the downstream MCP server as a child process and sits between the
 * MCP client (e.g. Claude Desktop) and the server, intercepting every
 * tools/call JSON-RPC message before it reaches the server.
 *
 * Wire diagram:
 *
 *   MCP client
 *     │ stdin  (newline-delimited JSON-RPC)
 *     ▼
 *   [mcp-shield-proxy]  ← this module
 *     │  tools/call query_domain_memory → answered by the proxy (ramen forge read)
 *     │  tools/call?  → evaluate against ramen-ai
 *     │  ALLOWED + verified signed receipt → forward to child stdin
 *     │  BLOCKED      → synthesise error response to client stdout
 *     │  anything else→ forward unchanged
 *     ▼
 *   Downstream MCP server (child process)
 *     │ stdout (responses, notifications)
 *     ▼
 *   [mcp-shield-proxy]
 *     │  tools/list response      → append query_domain_memory
 *     │  allowed tools/call result → attach provenance under _meta
 *     │  anything else             → forwarded byte-for-byte
 *     ▼
 *   MCP client
 *
 * Newline-delimited framing: each JSON-RPC message is exactly one line.
 * The proxy buffers partial lines across chunk boundaries and only processes
 * complete lines. This is required by the MCP stdio transport specification.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { RemoteForgeMemoryStore } from "@ramen-ai/node-core";
import type { RamenClient, RamenProvenanceEnvelope } from "@ramen-ai/node-core";
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  ProxyConfig,
  ToolsCallParams,
  ToolsCallResult,
} from "./types.js";
import { evaluate } from "./firewall.js";
import {
  MEMORY_TOOL_DEFINITION,
  MEMORY_TOOL_NAME,
  PROVENANCE_META_KEY,
  evaluationProvenance,
  handleMemoryQuery,
} from "./memory-tool.js";

const TOOLS_CALL_METHOD = "tools/call";
const TOOLS_LIST_METHOD = "tools/list";
const DEFAULT_DOMAIN = "general";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg && msg.id !== undefined;
}

function isToolsCall(msg: JsonRpcMessage): msg is JsonRpcRequest & { params: ToolsCallParams } {
  return (
    isRequest(msg) &&
    msg.method === TOOLS_CALL_METHOD &&
    msg.params !== null &&
    typeof msg.params === "object" &&
    "name" in (msg.params as object)
  );
}

function isResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    typeof msg === "object" &&
    msg !== null &&
    !Array.isArray(msg) &&
    !("method" in msg) &&
    "id" in msg &&
    ("result" in msg || "error" in msg)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map key that keeps numeric and string ids distinct (1 vs "1"). */
function idKey(id: JsonRpcId | undefined): string {
  return JSON.stringify(id ?? null);
}

/**
 * Synthesise an MCP-compliant blocked tool result response.
 * Uses the isError=true path specified in the MCP tools spec.
 */
function buildBlockedResponse(
  id: string | number | null,
  toolName: string,
  steering: string | null,
  anchors: string[],
  receiptVerified: boolean,
  provenance: RamenProvenanceEnvelope,
): JsonRpcResponse {
  const anchorStr = anchors.length ? anchors.join(", ") : "none";
  const steeringStr = steering ?? "This tool call has been blocked by the ramen-ai compliance firewall.";

  const text =
    `[BLOCKED] Tool '${toolName}' was blocked by the ramen-ai L2 Semantic Firewall.\n` +
    `Statutory anchors: ${anchorStr}\n` +
    `Steering: ${steeringStr}\n` +
    `Receipt verified (Ed25519): ${receiptVerified}`;

  const result: ToolsCallResult = {
    content: [{ type: "text", text }],
    isError: true,
    _meta: { [PROVENANCE_META_KEY]: provenance },
  };

  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function makeLogger(level: ProxyConfig["logLevel"]) {
  return {
    info: (msg: string) => {
      if (level === "info" || level === "debug") process.stderr.write(`[ramen-proxy] ${msg}\n`);
    },
    debug: (msg: string) => {
      if (level === "debug") process.stderr.write(`[ramen-proxy:debug] ${msg}\n`);
    },
    error: (msg: string) => {
      // Errors always go to stderr regardless of log level
      process.stderr.write(`[ramen-proxy:error] ${msg}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Main proxy runner
// ---------------------------------------------------------------------------

export interface ProxyRunResult {
  exitCode: number;
}

export async function runProxy(
  config: ProxyConfig,
  client: RamenClient,
  // Injectable streams and memory store for testing; defaults to process streams
  options?: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    memoryStore?: RemoteForgeMemoryStore;
    /** Receipt verification keys (tests only); defaults to the production keys */
    publicKeys?: Record<string, string>;
  },
): Promise<ProxyRunResult> {
  const stdin = options?.stdin ?? process.stdin;
  const stdout = options?.stdout ?? process.stdout;
  const log = makeLogger(config.logLevel);
  const domain = config.domain ?? DEFAULT_DOMAIN;
  const memoryStore =
    options?.memoryStore ??
    new RemoteForgeMemoryStore({
      baseUrl: config.forgeUrl,
      domain,
      logger: { warn: (m) => log.info(`memory: ${m}`), info: () => {} },
    });

  log.info(
    `Starting proxy → target: "${config.targetCommand} ${config.targetArgs.join(" ")}" ` +
      `bundles: [${config.bundleIds.join(", ")}] memory: ${memoryStore.baseUrl} (domain ${domain})`,
  );

  // Spawn the downstream MCP server
  const child: ChildProcess = spawn(config.targetCommand, config.targetArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to obtain stdio pipes from child process");
  }

  // Requests whose downstream responses the proxy annotates, keyed by idKey().
  const listRequests = new Set<string>();
  const governedCalls = new Map<string, RamenProvenanceEnvelope>();
  // If the downstream server advertises its own query_domain_memory, the proxy
  // stops answering that name and forwards it through the governed path.
  let downstreamOwnsMemoryTool = false;

  // Child stdout → client stdout. Lines the proxy does not annotate are
  // forwarded byte-for-byte; annotated responses are re-serialised.
  const childOut = createInterface({ input: child.stdout, crlfDelay: Infinity });
  childOut.on("line", (line: string) => {
    stdout.write(annotateDownstreamLine(line) + "\n");
  });

  function annotateDownstreamLine(line: string): string {
    if (listRequests.size === 0 && governedCalls.size === 0) return line;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isResponse(msg)) return line;
    const key = idKey(msg.id);

    if (listRequests.delete(key)) {
      const result = msg.result;
      if (!isPlainObject(result) || !Array.isArray(result.tools)) return line;
      const tools = result.tools as unknown[];
      if (tools.some((t) => isPlainObject(t) && t.name === MEMORY_TOOL_NAME)) {
        downstreamOwnsMemoryTool = true;
        log.info(`Downstream server already exposes '${MEMORY_TOOL_NAME}'; the proxy will not shadow it`);
        return line;
      }
      return JSON.stringify({ ...msg, result: { ...result, tools: [...tools, MEMORY_TOOL_DEFINITION] } });
    }

    const provenance = governedCalls.get(key);
    if (provenance) {
      governedCalls.delete(key);
      const result = msg.result;
      if (!isPlainObject(result)) return line; // JSON-RPC error: nothing to annotate
      const meta = isPlainObject(result._meta) ? result._meta : {};
      return JSON.stringify({ ...msg, result: { ...result, _meta: { ...meta, [PROVENANCE_META_KEY]: provenance } } });
    }
    return line;
  }

  return new Promise<ProxyRunResult>((resolve) => {
    // Buffer incoming data and process complete lines
    const rl = createInterface({ input: stdin, crlfDelay: Infinity });

    // Track in-flight evaluations so we process lines serially for each id
    // but don't block unrelated messages.
    const pending = new Set<string | number | null>();

    rl.on("line", (line: string) => {
      void handleLine(line);
    });

    async function handleLine(line: string): Promise<void> {
      if (!line.trim()) return; // skip blank lines

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Unparseable line — forward unchanged and let the server handle it
        log.debug(`Forwarding unparseable line: ${line.slice(0, 120)}`);
        child.stdin!.write(line + "\n");
        return;
      }

      // tools/list: forward, and remember the id so the first page of the
      // response can advertise query_domain_memory.
      if (isRequest(msg) && msg.method === TOOLS_LIST_METHOD) {
        const params = msg.params;
        const paginated = isPlainObject(params) && params.cursor !== undefined;
        if (!paginated) listRequests.add(idKey(msg.id));
        child.stdin!.write(line + "\n");
        return;
      }

      // Only intercept tools/call requests
      if (!isToolsCall(msg)) {
        log.debug(`Pass-through: ${"method" in msg ? msg.method : "(response)"}`);
        child.stdin!.write(line + "\n");
        return;
      }

      const params = msg.params as ToolsCallParams;

      // Deduplicate in-flight evaluations with the same id
      if (pending.has(msg.id!)) {
        log.debug(`Duplicate id ${String(msg.id)} — forwarding`);
        child.stdin!.write(line + "\n");
        return;
      }
      pending.add(msg.id!);

      try {
        if (params.name === MEMORY_TOOL_NAME && !downstreamOwnsMemoryTool) {
          log.info(`Answering ${MEMORY_TOOL_NAME} from ramen forge`);
          const result = await handleMemoryQuery(params.arguments, memoryStore);
          const response: JsonRpcResponse = { jsonrpc: "2.0", id: msg.id ?? null, result };
          stdout.write(JSON.stringify(response) + "\n");
          return;
        }

        log.info(`Intercepting tools/call: ${params.name}`);
        const verdict = await evaluate(params, config, client, options?.publicKeys);
        const provenance = evaluationProvenance(domain, params.name, verdict.receiptId);

        if (verdict.allowed) {
          log.info(`ALLOWED: ${params.name}`);
          governedCalls.set(idKey(msg.id), provenance);
          child.stdin!.write(line + "\n");
        } else {
          log.info(
            `BLOCKED: ${params.name} | anchors: ${verdict.statutoryAnchors.join(", ") || "none"} | ` +
              (verdict.error ? `error: ${verdict.error}` : `receipt_verified: ${verdict.receiptVerified}`),
          );
          const response = buildBlockedResponse(
            msg.id ?? null,
            params.name,
            verdict.steering,
            verdict.statutoryAnchors,
            verdict.receiptVerified,
            provenance,
          );
          stdout.write(JSON.stringify(response) + "\n");
        }
      } finally {
        pending.delete(msg.id!);
      }
    }

    // "close" fires after the child has exited and its stdio streams have
    // closed, so every downstream response has been forwarded by then.
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      log.info(`Child process exited with code ${exitCode}`);
      resolve({ exitCode });
    });

    child.on("error", (err) => {
      log.error(`Child process error: ${err.message}`);
      resolve({ exitCode: 1 });
    });

    // When the client closes its stdin, wait for all in-flight evaluations to
    // settle before closing child stdin. Without this, `cat`-style piping closes
    // stdin before the async evaluate() call returns, causing the child to exit
    // before the blocked response can be written.
    rl.on("close", () => {
      log.debug("stdin closed — waiting for in-flight evaluations before closing child stdin");
      const drain = async () => {
        // Poll until pending is empty (all evaluations have completed)
        while (pending.size > 0) {
          await new Promise((r) => setTimeout(r, 10));
        }
        log.debug("all evaluations settled — closing child stdin");
        child.stdin!.end();
      };
      void drain();
    });
  });
}
