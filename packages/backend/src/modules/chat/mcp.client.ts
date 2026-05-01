import { config } from "../../config";
import { logger } from "../../shared/logger";
import { getDecryptedToken } from "../oauth/oauth.service";
import { resolveMcpServer } from "./mcp.registry";
import type { OAuthProvider } from "../../shared/types";

const TOOL_TIMEOUT_MS = 10_000;

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

/**
 * Executes a single OpenAI-format tool call by routing it to the appropriate
 * MCP server and returning the result as a string.
 */
export async function executeTool(
  workspaceId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<ToolCallResult> {
  const mcpEntry = resolveMcpServer(toolName);

  if (!mcpEntry) {
    return {
      toolCallId,
      toolName,
      content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
      isError: true,
    };
  }

  // Get the decrypted OAuth token for the required provider
  let accessToken: string | null;
  try {
    accessToken = await getDecryptedToken(workspaceId, mcpEntry.provider as OAuthProvider);
  } catch (err) {
    logger.warn({ err, toolName, provider: mcpEntry.provider }, "OAuth token unavailable");
    return {
      toolCallId,
      toolName,
      content: JSON.stringify({ error: `${mcpEntry.provider} is not connected. Please connect it in workspace settings.` }),
      isError: true,
    };
  }

  if (!accessToken) {
    return {
      toolCallId,
      toolName,
      content: JSON.stringify({ error: `${mcpEntry.provider} is not connected. Please connect it in workspace settings.` }),
      isError: true,
    };
  }

  // Build a minimal MCP JSON-RPC request body for the tool call
  const mcpRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  };

  try {
    const res = await fetch(`${mcpEntry.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": config.INTERNAL_API_SECRET,
        "x-workspace-token": accessToken,
        Accept: "application/json, text/event-stream",
        "mcp-session-id": `ws-${workspaceId}`,
      },
      body: JSON.stringify(mcpRequest),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });

    const text = await res.text();

    // Handle SSE response (StreamableHTTP may return SSE)
    let result: unknown;
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      // Parse SSE: find the last data line
      const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
      const lastData = dataLines.at(-1)?.slice(5).trim();
      result = lastData ? JSON.parse(lastData) : null;
    } else {
      result = JSON.parse(text);
    }

    const rpcResult = result as { result?: { content?: { text?: string }[] }; error?: { message?: string } };

    if (rpcResult.error) {
      return { toolCallId, toolName, content: JSON.stringify({ error: rpcResult.error.message }), isError: true };
    }

    const content = rpcResult.result?.content?.[0]?.text ?? JSON.stringify(rpcResult.result);
    return { toolCallId, toolName, content, isError: false };
  } catch (err) {
    logger.error({ err, toolName }, "MCP tool call failed");
    return {
      toolCallId,
      toolName,
      content: JSON.stringify({ error: err instanceof Error ? err.message : "Tool call failed" }),
      isError: true,
    };
  }
}

/**
 * Executes multiple tool calls in parallel.
 */
export async function executeTools(
  workspaceId: string,
  toolCalls: { id: string; function: { name: string; arguments: string } }[],
): Promise<ToolCallResult[]> {
  return Promise.all(
    toolCalls.map((tc) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* invalid JSON — pass empty */ }
      return executeTool(workspaceId, tc.id, tc.function.name, args);
    }),
  );
}
