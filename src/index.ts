#!/usr/bin/env node
/**
 * mcp-shield-proxy — universal MCP stdio transport-layer interceptor.
 *
 * Spawns a downstream MCP server as a child process, intercepts tools/call
 * JSON-RPC messages over stdio, evaluates them against the ramen-ai L2
 * Semantic Firewall, and blocks malicious payloads pre-execution by returning
 * an MCP-compliant isError tool result.
 *
 * All other traffic is forwarded unchanged, with two additions: the proxy
 * advertises its own read-only `query_domain_memory` tool in tools/list, and
 * attaches a provenance envelope to the `_meta` of governed tool results.
 */

import { RemoteForgeMemoryStore } from "@ramen-ai/node-core";
import { parseArgs } from "./cli.js";
import { buildClient } from "./firewall.js";
import { runProxy } from "./proxy.js";

const config = parseArgs(process.argv);
const client = buildClient(config);

// Read-only: the proxy never contributes to ramen forge. Warnings go to stderr
// so they never corrupt the stdio JSON-RPC stream on stdout.
const memoryStore = new RemoteForgeMemoryStore({
  baseUrl: config.forgeUrl,
  domain: config.domain,
  logger: {
    warn: (message) => process.stderr.write(`[ramen-proxy:memory] ${message}\n`),
    info: () => {},
  },
});

const { exitCode } = await runProxy(config, client, { memoryStore });
process.exit(exitCode);
