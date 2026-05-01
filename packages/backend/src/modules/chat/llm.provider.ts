import Anthropic from "@anthropic-ai/sdk";
import type { Response } from "express";
import { config } from "../../config";
import { BadGatewayError } from "../../shared/errors";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LLMChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

export interface LLMResponse {
  id: string;
  model: string;
  choices: LLMChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface LlmConfig {
  provider: "openai" | "anthropic" | "google";
  apiKey: string;
  model: string;
}

export function getDefaultLlmConfig(): LlmConfig {
  return {
    provider: config.LLM_PROVIDER,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
  };
}

// ── OpenAI-compatible (OpenAI + Google Gemini) ───────────────────────────────

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

async function callOpenAICompat(
  messages: OpenAIMessage[],
  tools: unknown[],
  stream: boolean,
  cfg: LlmConfig,
): Promise<LLMResponse | globalThis.Response> {
  const baseUrl = PROVIDER_BASE_URLS[cfg.provider] ?? PROVIDER_BASE_URLS.openai;
  const body: Record<string, unknown> = { model: cfg.model, messages, stream };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new BadGatewayError(`${cfg.provider} error ${res.status}: ${text}`);
  }

  if (stream) return res;
  return res.json() as Promise<LLMResponse>;
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

function toAnthropicTools(tools: unknown[]): Anthropic.Tool[] {
  return (tools as Array<{ type: string; function: { name: string; description?: string; parameters: unknown } }>)
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters as Anthropic.Tool["input_schema"],
    }));
}

function toAnthropicMessages(messages: OpenAIMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  const out: Anthropic.MessageParam[] = [];

  for (let i = 0; i < rest.length; ) {
    const msg = rest[i];

    if (msg.role === "assistant") {
      const content: Anthropic.ContentBlock[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content } as Anthropic.Messages.TextBlock);
      for (const tc of msg.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
      out.push({ role: "assistant", content });
      i++;
      continue;
    }

    if (msg.role === "tool") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      while (i < rest.length && rest[i].role === "tool") {
        const t = rest[i];
        toolResults.push({
          type: "tool_result",
          tool_use_id: t.tool_call_id ?? "",
          content: t.content ?? "",
        });
        i++;
      }
      out.push({ role: "user", content: toolResults });
      continue;
    }

    out.push({ role: "user", content: msg.content ?? "" });
    i++;
  }

  return { system: systemMsg?.content ?? undefined, messages: out };
}

function anthropicToLLMResponse(res: Anthropic.Message): LLMResponse {
  const textBlocks = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  const toolBlocks = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

  const tool_calls: ToolCall[] = toolBlocks.map((b) => ({
    id: b.id,
    type: "function",
    function: { name: b.name, arguments: JSON.stringify(b.input) },
  }));

  return {
    id: res.id,
    model: res.model,
    choices: [
      {
        message: {
          role: "assistant",
          content: textBlocks.map((b) => b.text).join("") || null,
          ...(tool_calls.length > 0 ? { tool_calls } : {}),
        },
        finish_reason: res.stop_reason === "tool_use" ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
    },
  };
}

async function callAnthropic(
  messages: OpenAIMessage[],
  tools: unknown[],
  stream: boolean,
  cfg: LlmConfig,
  expressRes?: Response,
): Promise<LLMResponse | void> {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const anthropicTools = toAnthropicTools(tools);

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: cfg.model,
    max_tokens: 8192,
    messages: anthropicMessages,
    ...(system ? { system } : {}),
    ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
  };

  if (!stream) {
    const res = await client.messages.create(params);
    return anthropicToLLMResponse(res);
  }

  if (!expressRes) throw new Error("expressRes required for streaming");

  expressRes.setHeader("Content-Type", "text/event-stream");
  expressRes.setHeader("Cache-Control", "no-cache");
  expressRes.setHeader("Connection", "keep-alive");

  const streamRes = await client.messages.stream({ ...params, stream: true } as Anthropic.MessageStreamParams);
  const msgId = `chatcmpl-${Date.now()}`;

  for await (const event of streamRes) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      const chunk = {
        id: msgId,
        object: "chat.completion.chunk",
        model: cfg.model,
        choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
      };
      expressRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
    } else if (event.type === "message_delta" && event.delta.stop_reason) {
      const chunk = {
        id: msgId,
        object: "chat.completion.chunk",
        model: cfg.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      expressRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  }

  expressRes.write("data: [DONE]\n\n");
  expressRes.end();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function callLLM(
  messages: OpenAIMessage[],
  tools: unknown[],
  stream: false,
  cfg: LlmConfig,
): Promise<LLMResponse>;
export async function callLLM(
  messages: OpenAIMessage[],
  tools: unknown[],
  stream: true,
  cfg: LlmConfig,
  expressRes: Response,
): Promise<void>;
export async function callLLM(
  messages: OpenAIMessage[],
  tools: unknown[],
  stream: boolean,
  cfg: LlmConfig,
  expressRes?: Response,
): Promise<LLMResponse | void> {
  if (cfg.provider === "anthropic") {
    return callAnthropic(messages, tools, stream, cfg, expressRes);
  }
  // openai + google both use the OpenAI-compatible path
  if (stream) {
    const res = await callOpenAICompat(messages, tools, true, cfg) as globalThis.Response;
    if (!expressRes) throw new Error("expressRes required for streaming");
    expressRes.setHeader("Content-Type", "text/event-stream");
    expressRes.setHeader("Cache-Control", "no-cache");
    expressRes.setHeader("Connection", "keep-alive");
    const reader = res.body?.getReader();
    if (!reader) { expressRes.end(); return; }
    while (true) {
      const { done, value } = await reader.read();
      if (done) { expressRes.end(); break; }
      expressRes.write(value);
    }
    return;
  }
  return callOpenAICompat(messages, tools, false, cfg) as Promise<LLMResponse>;
}
