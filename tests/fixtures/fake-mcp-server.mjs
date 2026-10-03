// Minimal newline-delimited JSON-RPC MCP server used by proxy tests.
// argv[2] === "with-memory-tool" makes it advertise its own query_domain_memory.
import { createInterface } from "node:readline";

const ownsMemoryTool = process.argv[2] === "with-memory-tool";
const tools = [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }];
if (ownsMemoryTool) tools.push({ name: "query_domain_memory", inputSchema: { type: "object" } });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
    return;
  }
  if (msg.method === "tools/list") {
    const result = msg.params?.cursor ? { tools: [] } : { tools, nextCursor: "page-2" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  } else if (msg.method === "tools/call") {
    if (msg.params.name === "fail_tool") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } }) + "\n");
      return;
    }
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `downstream handled ${msg.params.name}` }],
          _meta: { "example.com/trace": "keep-me" },
        },
      }) + "\n",
    );
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.method } }) + "\n");
  }
});
rl.on("close", () => process.exit(0));
