import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";
export const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";
function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
function extractOllamaImages(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((part) => part.type === "image").map((part) => part.data);
}
function extractToolCalls(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = content;
  const result = [];
  for (const part of parts) {
    if (part.type === "toolCall") {
      result.push({ function: { name: part.name, arguments: part.arguments } });
    } else if (part.type === "tool_use") {
      result.push({ function: { name: part.name, arguments: part.input } });
    }
  }
  return result;
}
export function convertToOllamaMessages(messages, system) {
  const result = [];
  if (system) {
    result.push({ role: "system", content: system });
  }
  for (const msg of messages) {
    const { role } = msg;
    if (role === "user") {
      const text = extractTextContent(msg.content);
      const images = extractOllamaImages(msg.content);
      result.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images } : {}),
      });
    } else if (role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);
      result.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (role === "tool" || role === "toolResult") {
      // SDK uses "toolResult" (camelCase) for tool result messages.
      // Ollama API expects "tool" role with tool_name per the native spec.
      const text = extractTextContent(msg.content);
      const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
      result.push({
        role: "tool",
        content: text,
        ...(toolName ? { tool_name: toolName } : {}),
      });
    }
  }
  return result;
}
// ── Tool extraction ─────────────────────────────────────────────────────────
function extractOllamaTools(tools) {
  if (!tools || !Array.isArray(tools)) {
    return [];
  }
  const result = [];
  for (const tool of tools) {
    if (typeof tool.name !== "string" || !tool.name) {
      continue;
    }
    result.push({
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters ?? {},
      },
    });
  }
  return result;
}
// ── Response conversion ─────────────────────────────────────────────────────
export function buildAssistantMessage(response, modelInfo) {
  const content = [];
  if (response.message.content) {
    content.push({ type: "text", text: response.message.content });
  }
  const toolCalls = response.message.tool_calls;
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      content.push({
        type: "toolCall",
        id: `ollama_call_${randomUUID()}`,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const stopReason = hasToolCalls ? "toolUse" : "stop";
  const usage = {
    input: response.prompt_eval_count ?? 0,
    output: response.eval_count ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return {
    role: "assistant",
    content,
    stopReason,
    api: modelInfo.api,
    provider: modelInfo.provider,
    model: modelInfo.id,
    usage,
    timestamp: Date.now(),
  };
}
// ── NDJSON streaming parser ─────────────────────────────────────────────────
export async function* parseNdjsonStream(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        yield JSON.parse(trimmed);
      } catch {
        console.warn("[ollama-stream] Skipping malformed NDJSON line:", trimmed.slice(0, 120));
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim());
    } catch {
      console.warn(
        "[ollama-stream] Skipping malformed trailing data:",
        buffer.trim().slice(0, 120),
      );
    }
  }
}
// ── Main StreamFn factory ───────────────────────────────────────────────────
function resolveOllamaChatUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const normalizedBase = trimmed.replace(/\/v1$/i, "");
  const apiBase = normalizedBase || OLLAMA_NATIVE_BASE_URL;
  return `${apiBase}/api/chat`;
}
export function createOllamaStreamFn(baseUrl) {
  const chatUrl = resolveOllamaChatUrl(baseUrl);
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      try {
        const ollamaMessages = convertToOllamaMessages(
          context.messages ?? [],
          context.systemPrompt,
        );
        const ollamaTools = extractOllamaTools(context.tools);
        // Ollama defaults to num_ctx=4096 which is too small for large
        // system prompts + many tool definitions. Use model's contextWindow.
        const ollamaOptions = { num_ctx: model.contextWindow ?? 65536 };
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === "number") {
          ollamaOptions.num_predict = options.maxTokens;
        }
        const body = {
          model: model.id,
          messages: ollamaMessages,
          stream: true,
          ...(ollamaTools.length > 0 ? { tools: ollamaTools } : {}),
          options: ollamaOptions,
        };
        const headers = {
          "Content-Type": "application/json",
          ...options?.headers,
        };
        if (options?.apiKey) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }
        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Ollama API error ${response.status}: ${errorText}`);
        }
        if (!response.body) {
          throw new Error("Ollama API returned empty response body");
        }
        const reader = response.body.getReader();
        let accumulatedContent = "";
        const accumulatedToolCalls = [];
        let finalResponse;
        for await (const chunk of parseNdjsonStream(reader)) {
          if (chunk.message?.content) {
            accumulatedContent += chunk.message.content;
          }
          // Ollama sends tool_calls in intermediate (done:false) chunks,
          // NOT in the final done:true chunk. Collect from all chunks.
          if (chunk.message?.tool_calls) {
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }
          if (chunk.done) {
            finalResponse = chunk;
            break;
          }
        }
        if (!finalResponse) {
          throw new Error("Ollama API stream ended without a final response");
        }
        finalResponse.message.content = accumulatedContent;
        if (accumulatedToolCalls.length > 0) {
          finalResponse.message.tool_calls = accumulatedToolCalls;
        }
        const assistantMessage = buildAssistantMessage(finalResponse, {
          api: model.api,
          provider: model.provider,
          id: model.id,
        });
        const reason = assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop";
        stream.push({
          type: "done",
          reason,
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };
    queueMicrotask(() => void run());
    return stream;
  };
}
