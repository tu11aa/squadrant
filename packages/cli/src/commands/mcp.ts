import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { squadrantdCall } from "./crew-control.js";
import { mcpToolList, callMcpTool } from "../lib/captain-mcp-tools.js";

/** Stdio MCP server exposing the crew signal tools, and the captain tools in a captain session (#1029). The SDK is imported lazily so no other command pays for it. */
export async function runMcpServer(): Promise<void> {
  const [{ Server }, { StdioServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  // Same lookup as index.ts --version: this is bundled into dist/index.js, so ../package.json is the root package.
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
  // stdout is the protocol channel: the shared CLI functions print progress with console.log, which must not corrupt it.
  console.log = console.info = (...a: unknown[]) => console.error(...a);
  const server = new Server({ name: "squadrant", version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await callMcpTool(req.params.name, req.params.arguments ?? {}, { call: squadrantdCall });
    return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
  });
  await server.connect(new StdioServerTransport());
}

export const mcpCommand = new Command("mcp")
  .description("Start the squadrant MCP server on stdio (crew signal tools; captain tools in a captain session). Register: claude mcp add --scope user squadrant -- squadrant mcp")
  .action(async () => {
    await runMcpServer();
  });
