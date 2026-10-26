import { Command } from "commander";
import { CREW_SIGNAL_TOOLS, callCrewSignalTool } from "@squadrant/core";
import { squadrantdCall } from "./crew-control.js";

/** Stdio MCP server exposing the crew signal tools (#1029). The SDK is imported lazily so no other command pays for it. */
export async function runMcpServer(): Promise<void> {
  const [{ Server }, { StdioServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const server = new Server({ name: "squadrant", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CREW_SIGNAL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: "object" as const,
        properties: Object.fromEntries(Object.entries(t.fields).map(([k, description]) => [k, { type: "string", description }])),
      },
    })),
  }));
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
