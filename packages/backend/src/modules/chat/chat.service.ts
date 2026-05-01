/**
 * Agentic chat loop.
 *
 * Flow:
 *   1. Receive OpenAI-format request (messages, model, stream flag)
 *   2. Fetch tool schemas for connected integrations (Redis-cached)
 *   3. Loop (max MAX_ITERATIONS):
 *      a. Call LLM provider (non-streaming)
 *      b. If finish_reason == "tool_calls": execute tools in parallel, append results, repeat
 *      c. If finish_reason == "stop": break
 *   4. Stream final answer to client via provider's SSE format (normalised to OpenAI SSE)
 *   5. Persist session + messages asynchronously
 */
import type { Response } from "express";
import { config } from "../../config";
import { logger } from "../../shared/logger";
import { getUserTools } from "./tools.service";
import { executeTools } from "./mcp.client";
import { callLLM, type OpenAIMessage, type ToolCall, type LLMResponse } from "./llm.provider";
import { resolveUserLlmConfigForProvider } from "../llm-config/llm-config.service";
import { db } from "../../db";
import { chatSessions, chatMessages } from "../../db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const MAX_ITERATIONS = 10;

function inferProvider(model: string): "openai" | "anthropic" | "google" {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  return "openai";
}

export async function runAgenticLoop(
  workspaceId: string,
  userId: string | undefined,
  incomingMessages: OpenAIMessage[],
  streamResponse: boolean,
  expressRes: Response,
  sessionId?: string,
  requestedModel?: string,
): Promise<void> {
  // 1. Resolve LLM config: use the model from the request to pick the right provider + key
  const modelToUse = requestedModel ?? config.LLM_MODEL;
  const provider   = inferProvider(modelToUse);
  const llmCfg     = await resolveUserLlmConfigForProvider(userId ?? "", provider);
  llmCfg.model     = modelToUse;

  // 2. Fetch available tools for this user
  const tools = await getUserTools(userId ?? "");

  // 3. Build conversation buffer
  const messages: OpenAIMessage[] = [...incomingMessages];
  const persistQueue: PersistedMessage[] = [];
  let iteration = 0;
  let finalResponse: LLMResponse | null = null;

  // 4. Agentic loop
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const isLastPossibleIteration = iteration >= MAX_ITERATIONS;

    const llmRes = await callLLM(messages, tools, false, llmCfg);
    const choice = llmRes.choices[0];
    if (!choice) throw new Error("LLM returned no choices");

    const { finish_reason, message } = choice;

    if (finish_reason === "tool_calls" && message.tool_calls?.length && !isLastPossibleIteration) {
      messages.push({
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls,
      });
      persistQueue.push({
        role: "assistant",
        content: message.content,
        toolCalls: message.tool_calls,
        finishReason: "tool_calls",
        promptTokens: llmRes.usage?.prompt_tokens,
        completionTokens: llmRes.usage?.completion_tokens,
      });

      const results = await executeTools(workspaceId, message.tool_calls);

      for (const result of results) {
        messages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.toolCallId,
          name: result.toolName,
        });
        persistQueue.push({
          role: "tool",
          content: result.content,
          toolCallId: result.toolCallId,
          toolName: result.toolName,
        });
      }

      logger.debug({ iteration, toolsUsed: results.map((r) => r.toolName) }, "Tool round complete");
      continue;
    }

    finalResponse = llmRes;
    persistQueue.push({
      role: "assistant",
      content: message.content,
      finishReason: finish_reason,
      promptTokens: llmRes.usage?.prompt_tokens,
      completionTokens: llmRes.usage?.completion_tokens,
    });
    break;
  }

  // 5. Deliver response
  if (streamResponse) {
    await callLLM(messages, [], true, llmCfg, expressRes);
  } else {
    expressRes.json(finalResponse);
  }

  // 6. Async persistence (non-blocking)
  persistMessages(workspaceId, userId, incomingMessages, persistQueue, sessionId).catch((err) =>
    logger.error({ err }, "Failed to persist chat messages"),
  );
}

interface PersistedMessage {
  role: string;
  content: string | null;
  toolCalls?: unknown;
  toolCallId?: string;
  toolName?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
}

async function persistMessages(
  workspaceId: string,
  userId: string | undefined,
  userMessages: OpenAIMessage[],
  assistantMessages: PersistedMessage[],
  sessionId: string | undefined,
): Promise<void> {
  // Upsert session
  let sid = sessionId ?? randomUUID();
  const existing = sessionId
    ? await db.select({ id: chatSessions.id }).from(chatSessions).where(eq(chatSessions.id, sessionId)).limit(1)
    : [];

  if (existing.length === 0) {
    const lastUserMsg = [...userMessages].reverse().find((m) => m.role === "user");
    const title = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content.slice(0, 80)
      : undefined;

    const [sess] = await db.insert(chatSessions).values({
      id: sid,
      workspaceId,
      userId: userId === "open-webui" ? undefined : userId,
      model: config.LLM_MODEL,
      title,
    }).returning({ id: chatSessions.id });
    sid = sess!.id;
  } else {
    await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, sid));
  }

  // Persist user messages
  const allMessages: PersistedMessage[] = [
    ...userMessages.map((m): PersistedMessage => ({ role: m.role, content: typeof m.content === "string" ? m.content : null })),
    ...assistantMessages,
  ];

  for (const m of allMessages) {
    await db.insert(chatMessages).values({
      sessionId: sid,
      role: m.role,
      content: m.content ?? null,
      toolCalls: (m.toolCalls ?? undefined) as never,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      finishReason: m.finishReason,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
    });
  }
}
