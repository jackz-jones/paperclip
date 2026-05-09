/**
 * Ollama HTTP 客户端工具模块
 * 封装与 Ollama API 的所有 HTTP 通信
 */

import { DEFAULT_OLLAMA_BASE_URL } from "../index.js";

// ============ 类型定义 ============

/** Ollama /api/tags 返回的模型信息 */
export interface OllamaModelInfo {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

/** Ollama /api/tags 响应 */
export interface OllamaTagsResponse {
  models: OllamaModelInfo[];
}

// ============ Tool Calling 类型定义 ============

/** Ollama tool 参数定义（JSON Schema 格式） */
export interface OllamaToolParameters {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
  }>;
  required?: string[];
}

/** Ollama tool 定义 */
export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: OllamaToolParameters;
  };
}

/** Ollama 模型返回的 tool call */
export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** Ollama chat 请求消息 */
export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** 仅在 role=assistant 且模型调用 tool 时出现 */
  tool_calls?: OllamaToolCall[];
}

/** Ollama chat 请求体 */
export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  /** Tool Calling: 提供给模型的可用工具列表 */
  tools?: OllamaToolDefinition[];
  options?: {
    temperature?: number;
    num_ctx?: number;
    [key: string]: unknown;
  };
}

/** Ollama chat 流式响应的单个 chunk */
export interface OllamaChatStreamChunk {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    /** Tool Calling: 模型请求调用的工具列表 */
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  /** 仅在 done=true 时出现 */
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/** 非流式 Ollama chat 响应（用于 Agent Loop 中的 tool calling） */
export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// ============ 客户端实现 ============

/**
 * 检查 Ollama 服务是否可达
 */
export async function checkOllamaReachable(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 获取 Ollama 本地已安装的模型列表
 */
export async function fetchOllamaModels(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
): Promise<OllamaTagsResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(
        `Ollama API 返回错误: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as OllamaTagsResponse;
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Ollama API 请求超时 (baseUrl: ${baseUrl})`);
    }
    throw error;
  }
}

/**
 * 流式调用 Ollama chat API
 * 返回一个异步迭代器，逐个 yield 响应 chunk
 */
export async function* streamOllamaChat(
  request: OllamaChatRequest,
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
  abortSignal?: AbortSignal,
): AsyncGenerator<OllamaChatStreamChunk> {
  const body: OllamaChatRequest = {
    ...request,
    stream: true,
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Ollama chat API 错误: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
    );
  }

  if (!response.body) {
    throw new Error("Ollama chat API 未返回响应体");
  }

  // 解析 NDJSON 流
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // 保留最后一个可能不完整的行
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const chunk = JSON.parse(trimmed) as OllamaChatStreamChunk;
          yield chunk;
        } catch {
          // 跳过无法解析的行
        }
      }
    }

    // 处理缓冲区中剩余的数据
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim()) as OllamaChatStreamChunk;
        yield chunk;
      } catch {
        // 忽略
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 非流式调用 Ollama chat API（用于 Agent Loop 中的 tool calling）
 * 返回完整的响应对象，包含可能的 tool_calls
 */
export async function callOllamaChat(
  request: OllamaChatRequest,
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
  abortSignal?: AbortSignal,
): Promise<OllamaChatResponse> {
  const body: OllamaChatRequest = {
    ...request,
    stream: false,
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Ollama chat API 错误: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
    );
  }

  return (await response.json()) as OllamaChatResponse;
}
