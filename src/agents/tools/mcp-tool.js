import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { jsonResult, readStringParam } from "./common.js";
class McpClient {
  serverName;
  config;
  process = null;
  pendingRequests = new Map();
  buffer = "";
  tools = [];
  initialized = false;
  constructor(serverName, config) {
    this.serverName = serverName;
    this.config = config;
  }
  async start() {
    if (this.process) {
      return;
    }
    this.process = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout?.on("data", (chunk) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });
    this.process.stderr?.on("data", (chunk) => {
      console.error(`[MCP ${this.serverName}] stderr:`, chunk.toString());
    });
    this.process.on("error", (error) => {
      console.error(`[MCP ${this.serverName}] process error:`, error);
      this.cleanup();
    });
    this.process.on("exit", (code) => {
      console.log(`[MCP ${this.serverName}] process exited with code ${code}`);
      this.cleanup();
    });
    // Initialize connection
    await this.initialize();
  }
  processBuffer() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const response = JSON.parse(line);
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (error) {
        console.error(`[MCP ${this.serverName}] Failed to parse response:`, line, error);
      }
    }
  }
  async sendRequest(method, params) {
    if (!this.process?.stdin) {
      throw new Error(`MCP server ${this.serverName} not started`);
    }
    const id = randomUUID();
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const requestLine = JSON.stringify(request) + "\n";
      this.process.stdin.write(requestLine, (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          reject(error);
        }
      });
      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }
  async initialize() {
    try {
      await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: "verso",
          version: "1.0.0",
        },
      });
      // List available tools
      const result = await this.sendRequest("tools/list");
      this.tools = result.tools || [];
      this.initialized = true;
      console.log(`[MCP ${this.serverName}] Initialized with ${this.tools.length} tools`);
    } catch (error) {
      console.error(`[MCP ${this.serverName}] Initialization failed:`, error);
      throw error;
    }
  }
  async callTool(name, args) {
    if (!this.initialized) {
      throw new Error(`MCP server ${this.serverName} not initialized`);
    }
    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
    return result;
  }
  getTools() {
    return this.tools;
  }
  cleanup() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.pendingRequests.clear();
    this.initialized = false;
  }
}
// Global registry of MCP clients
const mcpClients = new Map();
function resolveMcpConfig(cfg) {
  const mcp = cfg?.tools?.mcp;
  if (!mcp || typeof mcp !== "object") {
    return undefined;
  }
  return mcp;
}
function resolveMcpEnabled(mcpConfig) {
  return mcpConfig?.enabled !== false;
}
async function ensureMcpClients(mcpConfig) {
  if (!mcpConfig?.servers) {
    return;
  }
  for (const [serverName, serverConfig] of Object.entries(mcpConfig.servers)) {
    if (!mcpClients.has(serverName)) {
      const client = new McpClient(serverName, serverConfig);
      try {
        await client.start();
        mcpClients.set(serverName, client);
      } catch (error) {
        console.error(`[MCP] Failed to start server ${serverName}:`, error);
      }
    }
  }
}
export function createMcpTool(options) {
  const mcpConfig = resolveMcpConfig(options?.config);
  if (!resolveMcpEnabled(mcpConfig)) {
    return null;
  }
  // Ensure MCP clients are started (async, but we don't block tool creation)
  ensureMcpClients(mcpConfig).catch((error) => {
    console.error("[MCP] Failed to ensure clients:", error);
  });
  const McpSchema = Type.Object({
    server: Type.String({ description: "MCP server name to call" }),
    tool: Type.String({ description: "Tool name to invoke on the MCP server" }),
    arguments: Type.Optional(
      Type.Record(Type.String(), Type.Any(), {
        description: "Arguments to pass to the MCP tool (JSON object)",
      }),
    ),
  });
  return {
    label: "MCP",
    name: "mcp",
    description: `Call tools from MCP (Model Context Protocol) servers. Available servers: ${Object.keys(mcpConfig?.servers || {}).join(", ")}`,
    parameters: McpSchema,
    execute: async (_toolCallId, args) => {
      const params = args;
      const server = readStringParam(params, "server", { required: true });
      const tool = readStringParam(params, "tool", { required: true });
      const toolArgs = params.arguments || {};
      const client = mcpClients.get(server);
      if (!client) {
        return jsonResult({
          error: "server_not_found",
          message: `MCP server "${server}" not found or not started`,
          availableServers: Array.from(mcpClients.keys()),
        });
      }
      try {
        const result = await client.callTool(tool, toolArgs);
        return jsonResult({
          ok: true,
          server,
          tool,
          result,
        });
      } catch (error) {
        return jsonResult({
          error: "mcp_call_failed",
          message: error instanceof Error ? error.message : String(error),
          server,
          tool,
        });
      }
    },
  };
}
// Cleanup on process exit
process.on("exit", () => {
  for (const client of mcpClients.values()) {
    client.cleanup();
  }
});
