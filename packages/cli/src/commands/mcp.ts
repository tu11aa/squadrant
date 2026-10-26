import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { crewSignalToolList, callCrewSignalTool } from "@squadrant/core";
import { squadrantdCall } from "./crew-control.js";

/** Stdio MCP server exposing the crew signal tools (#1029). The SDK is imported lazily so no other command pays for it. */
export async function runMcpServer(): Promise<void> {
  const [{ Server }, { StdioServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  // Same lookup as index.ts --version: this is bundled into dist/index.js, so ../package.json is the root package.
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"));
  const server = new Server({ name: "squadrant", version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: crewSignalToolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await callCrewSignalTool(req.params.name, req.params.arguments ?? {}, { call: squadrantdCall });
    return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
  });
  await server.connect(new StdioServerTransport());
}

export const mcpCommand = new Command("mcp")
  .description("Start the squadrant MCP server on stdio (crew signal tools). Register: claude mcp add --scope user squadrant -- squadrant mcp")
  .action(async () => {
    await runMcpServer();
  });
