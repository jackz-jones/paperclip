/**
 * Agent Loop 核心引擎
 * 实现 ReAct 模式的多轮 tool calling 对话循环
 */

import type {
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaToolCall,
  OllamaToolDefinition,
} from "./ollama-client.js";
import { callOllamaChat } from "./ollama-client.js";
import { executeToolCall, type ToolExecutorOptions } from "./tools/tool-executor.js";

// ============ 文本 Tool Call 解析 ============

/**
 * 从模型的纯文本输出中解析 tool call
 * 支持多种格式：
 * 1. JSON 格式: {"name": "tool_name", "arguments": {...}}
 * 2. 双花括号格式: {{"name": "tool_name", "arguments": {...}}}
 * 3. <use_skill> XML 格式
 * 4. [TOOL_CALL] 标记格式（qwen3 等模型使用）
 * 5. ```tool_call 代码块格式
 */
function parseToolCallsFromText(text: string): OllamaToolCall[] | null {
  const results: OllamaToolCall[] = [];

  // 方法 0：尝试 [TOOL_CALL] 标记格式（qwen3 等模型使用）
  // 格式：[TOOL_CALL]\nname: tool_name\narguments:\nkey: value\n...\n[TOOL_CALL] 或 [/TOOL_CALL]
  const toolCallBlocks = extractToolCallBlocks(text);
  if (toolCallBlocks.length > 0) {
    for (const block of toolCallBlocks) {
      const parsed = parseToolCallBlock(block);
      if (parsed) {
        const mappedName = mapSkillNameToToolName(parsed.name);
        const mappedArgs = mapSkillArgsToToolArgs(mappedName, parsed.arguments);
        results.push({
          function: {
            name: mappedName,
            arguments: mappedArgs,
          },
        });
      }
    }
    if (results.length > 0) return results;
  }

  // 方法 1：尝试直接 JSON 解析整个文本（或去掉双花括号后）
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    // 去掉双花括号
    trimmed.replace(/^\{\{/, "{").replace(/\}\}$/, "}"),
  ];

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj.name === "string" && obj.arguments && typeof obj.arguments === "object") {
        const mappedName = mapSkillNameToToolName(obj.name);
        const mappedArgs = mapSkillArgsToToolArgs(mappedName, obj.arguments);
        results.push({
          function: {
            name: mappedName,
            arguments: mappedArgs,
          },
        });
        return results;
      }
    } catch {
      // 不是有效的 JSON，继续尝试其他方法
    }
  }

  // 方法 2：从文本中提取 JSON 对象（查找 {"name": 开头的 JSON）
  const jsonStartPatterns = [
    /\{\{\s*"name"\s*:/g,
    /\{\s*"name"\s*:/g,
  ];

  for (const startPattern of jsonStartPatterns) {
    let match: RegExpExecArray | null;
    while ((match = startPattern.exec(text)) !== null) {
      const startIdx = match.index;
      // 尝试从这个位置提取完整的 JSON 对象
      const extracted = extractJsonObject(text, startIdx);
      if (extracted) {
        try {
          // 去掉可能的双花括号
          const cleaned = extracted.replace(/^\{\{/, "{").replace(/\}\}$/, "}");
          const obj = JSON.parse(cleaned);
          if (obj && typeof obj.name === "string" && obj.arguments && typeof obj.arguments === "object") {
            const mappedName = mapSkillNameToToolName(obj.name);
            const mappedArgs = mapSkillArgsToToolArgs(mappedName, obj.arguments);
            results.push({
              function: {
                name: mappedName,
                arguments: mappedArgs,
              },
            });
          }
        } catch {
          // 解析失败，忽略
        }
      }
    }
    if (results.length > 0) break;
  }

  // 方法 3：尝试 <use_skill> XML 格式
  if (results.length === 0) {
    const xmlPattern = /<use_skill>\s*<name>([^<]+)<\/name>\s*<arguments>\s*([\s\S]*?)\s*<\/arguments>\s*<\/use_skill>/g;
    let match: RegExpExecArray | null;
    while ((match = xmlPattern.exec(text)) !== null) {
      const toolName = match[1].trim();
      const argsStr = match[2].trim();
      try {
        const args = JSON.parse(argsStr);
        const mappedName = mapSkillNameToToolName(toolName);
        const mappedArgs = mapSkillArgsToToolArgs(mappedName, args);
        results.push({
          function: {
            name: mappedName,
            arguments: mappedArgs,
          },
        });
      } catch {
        // JSON 解析失败，忽略
      }
    }
  }

  // 方法 4：尝试 ```tool_call 代码块格式
  if (results.length === 0) {
    const codeBlockPattern = /```(?:tool_call|json)?\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = codeBlockPattern.exec(text)) !== null) {
      const blockContent = match[1].trim();
      try {
        const obj = JSON.parse(blockContent);
        if (obj && typeof obj.name === "string" && obj.arguments && typeof obj.arguments === "object") {
          const mappedName = mapSkillNameToToolName(obj.name);
          const mappedArgs = mapSkillArgsToToolArgs(mappedName, obj.arguments);
          results.push({
            function: {
              name: mappedName,
              arguments: mappedArgs,
            },
          });
        }
      } catch {
        // 不是 JSON，忽略
      }
    }
  }

  return results.length > 0 ? results : null;
}

/**
 * 从文本中提取 [TOOL_CALL]...[TOOL_CALL] 或 [TOOL_CALL]...[/TOOL_CALL] 块
 */
function extractToolCallBlocks(text: string): string[] {
  const blocks: string[] = [];

  // 模式 1：[TOOL_CALL]...[TOOL_CALL]（两个相同标记包裹）
  // 模式 2：[TOOL_CALL]...[/TOOL_CALL]（开闭标记）
  const pattern = /\[TOOL_CALL\]\s*\n([\s\S]*?)(?:\[\/TOOL_CALL\]|\[TOOL_CALL\])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const block = match[1].trim();
    if (block) {
      blocks.push(block);
    }
  }

  // 如果上面没匹配到，尝试只有一个 [TOOL_CALL] 开头的情况（到文本末尾）
  if (blocks.length === 0) {
    const singlePattern = /\[TOOL_CALL\]\s*\n([\s\S]+?)$/g;
    let match2: RegExpExecArray | null;
    while ((match2 = singlePattern.exec(text)) !== null) {
      const block = match2[1].trim();
      if (block) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

/**
 * 解析 [TOOL_CALL] 块内容
 * 格式：
 *   name: tool_name
 *   arguments:
 *   key1: "value1"
 *   key2: "value2"
 * 或者：
 *   name: tool_name
 *   arguments:
 *   {"key1": "value1", "key2": "value2"}
 */
function parseToolCallBlock(block: string): { name: string; arguments: Record<string, unknown> } | null {
  const lines = block.split("\n");
  let name = "";
  let argsStartIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 解析 name
    if (line.startsWith("name:")) {
      name = line.slice(5).trim();
      // 去掉可能的引号
      name = name.replace(/^["']|["']$/g, "");
    }

    // 找到 arguments: 行
    if (line === "arguments:" || line.startsWith("arguments:")) {
      const inlineArgs = line.slice(10).trim();
      if (inlineArgs) {
        // arguments: {...} 在同一行
        try {
          const args = JSON.parse(inlineArgs);
          if (name && typeof args === "object") {
            return { name, arguments: args };
          }
        } catch {
          // 不是内联 JSON
        }
      }
      argsStartIdx = i + 1;
      break;
    }
  }

  if (!name) return null;

  // 如果没有找到 arguments: 行，尝试将 name 之后的所有内容作为参数
  if (argsStartIdx === -1) {
    // 尝试找 name 行之后的内容
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("name:")) {
        argsStartIdx = i + 1;
        break;
      }
    }
  }

  if (argsStartIdx < 0 || argsStartIdx >= lines.length) {
    return name ? { name, arguments: {} } : null;
  }

  // 提取 arguments 部分
  const argsLines = lines.slice(argsStartIdx);
  const argsText = argsLines.join("\n").trim();

  // 尝试 1：整体作为 JSON 解析
  try {
    const args = JSON.parse(argsText);
    if (typeof args === "object" && args !== null) {
      return { name, arguments: args };
    }
  } catch {
    // 不是 JSON
  }

  // 尝试 2：从 argsText 中提取 JSON 对象
  const jsonMatch = argsText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const args = JSON.parse(jsonMatch[0]);
      if (typeof args === "object" && args !== null) {
        return { name, arguments: args };
      }
    } catch {
      // 不是有效 JSON
    }
  }

  // 尝试 3：逐行解析 key: value 格式
  const args: Record<string, unknown> = {};
  let currentKey = "";
  let currentValue = "";

  for (const line of argsLines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // 检查是否是新的 key: value 行
    const kvMatch = trimmedLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      // 保存之前的 key-value
      if (currentKey) {
        args[currentKey] = parseValue(currentValue.trim());
      }
      currentKey = kvMatch[1];
      currentValue = kvMatch[2];
    } else if (currentKey) {
      // 多行值的续行
      currentValue += "\n" + trimmedLine;
    }
  }

  // 保存最后一个 key-value
  if (currentKey) {
    args[currentKey] = parseValue(currentValue.trim());
  }

  if (Object.keys(args).length > 0) {
    return { name, arguments: args };
  }

  return name ? { name, arguments: {} } : null;
}

/**
 * 解析值字符串为适当的类型
 */
function parseValue(value: string): unknown {
  // 去掉首尾引号
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // 尝试解析为 JSON
  try {
    return JSON.parse(value);
  } catch {
    // 返回原始字符串
    return value;
  }
}

/**
 * 从文本中提取完整的 JSON 对象（处理嵌套花括号）
 */
function extractJsonObject(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}

/**
 * 将 skill 名称映射为 tool 名称
 * 例如 "paperclip-create-agent" → "create_agent_hire"
 */
function mapSkillNameToToolName(name: string): string {
  const mapping: Record<string, string> = {
    "paperclip-create-agent": "create_agent_hire",
    "create-agent": "create_agent_hire",
    "create_agent": "create_agent_hire",
  };
  return mapping[name] || name;
}

/**
 * 将 skill 格式的参数映射为 tool 格式的参数
 * 例如 paperclip-create-agent skill 使用 "description"、"systemPrompt" 等字段，
 * 而 create_agent_hire tool 使用 "capabilities"、"instructionsContent" 等字段
 */
function mapSkillArgsToToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "create_agent_hire") {
    return args;
  }

  const mapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    switch (key) {
      case "description":
        // skill 的 description → tool 的 capabilities
        mapped.capabilities = value;
        break;
      case "systemPrompt":
      case "system_prompt":
      case "prompt":
      case "instructions":
        // skill 的 systemPrompt/instructions → tool 的 instructionsContent
        mapped.instructionsContent = value;
        break;
      case "skills":
        // skill 的 skills 数组 → tool 的 desiredSkills（逗号分隔字符串）
        if (Array.isArray(value)) {
          mapped.desiredSkills = value.join(",");
        } else if (typeof value === "string") {
          mapped.desiredSkills = value;
        }
        break;
      case "type":
        // 忽略 "type": "agent" 字段
        break;
      case "adapter":
      case "adapter_type":
        mapped.adapterType = value;
        break;
      case "model":
        // model 字段放入 adapterConfig
        if (!mapped.adapterConfig) {
          mapped.adapterConfig = "{}";
        }
        try {
          const cfg = JSON.parse(mapped.adapterConfig as string);
          cfg.model = value;
          mapped.adapterConfig = JSON.stringify(cfg);
        } catch {
          mapped.adapterConfig = JSON.stringify({ model: value });
        }
        break;
      case "baseUrl":
      case "base_url":
        // baseUrl 字段放入 adapterConfig
        if (!mapped.adapterConfig) {
          mapped.adapterConfig = "{}";
        }
        try {
          const cfg = JSON.parse(mapped.adapterConfig as string);
          cfg.baseUrl = value;
          mapped.adapterConfig = JSON.stringify(cfg);
        } catch {
          mapped.adapterConfig = JSON.stringify({ baseUrl: value });
        }
        break;
      default:
        // 其他字段直接传递
        mapped[key] = value;
        break;
    }
  }

  // 如果没有 adapterType，默认使用 ollama_local
  if (!mapped.adapterType) {
    mapped.adapterType = "ollama_local";
  }

  return mapped;
}

// ============ 类型定义 ============

export interface AgentLoopOptions {
  /** Ollama 模型名称 */
  model: string;
  /** Ollama 服务地址 */
  baseUrl: string;
  /** 初始消息列表（包含 system prompt 和 user message） */
  messages: OllamaChatMessage[];
  /** 可用的 tools 定义 */
  tools: OllamaToolDefinition[];
  /** Tool 执行器配置 */
  toolExecutorOptions: ToolExecutorOptions;
  /** 最大轮次限制 */
  maxTurns: number;
  /** 模型选项 */
  modelOptions?: {
    temperature?: number;
    num_ctx?: number;
  };
  /** 日志回调 */
  onLog: (stream: "stdout" | "stderr", data: string) => Promise<void>;
  /** 中止信号 */
  abortSignal?: AbortSignal;
}

export interface AgentLoopResult {
  /** 最终文本输出 */
  output: string;
  /** 总轮次数 */
  totalTurns: number;
  /** 总 tool call 次数 */
  totalToolCalls: number;
  /** 累计 token 使用量 */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** 从 tool call 中推断的 issue disposition */
  inferredDisposition: string | null;
  /** 是否因为模型不支持 tool calling 而退回 */
  fallbackToTextMode: boolean;
  /** 是否达到最大轮次 */
  maxTurnsReached: boolean;
  /** 错误信息（如果有） */
  error?: string;
}

// ============ Agent Loop 实现 ============

/**
 * 运行 Agent Loop
 * 多轮对话循环，直到模型不再调用 tool 或达到最大轮次
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    model,
    baseUrl,
    messages,
    tools,
    toolExecutorOptions,
    maxTurns,
    modelOptions,
    onLog,
    abortSignal,
  } = options;

  // 工作消息列表（会在循环中不断追加）
  const workingMessages: OllamaChatMessage[] = [...messages];

  let totalTurns = 0;
  let totalToolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let inferredDisposition: string | null = null;
  let consecutiveInvalidCalls = 0;
  let lastTextOutput = "";
  const MAX_CONSECUTIVE_INVALID = 3;

  try {
    while (totalTurns < maxTurns) {
      // 检查中止信号
      if (abortSignal?.aborted) {
        return buildResult({
          output: lastTextOutput,
          totalTurns,
          totalToolCalls,
          inputTokens,
          outputTokens,
          inferredDisposition,
          error: "Agent loop aborted",
        });
      }

      totalTurns++;
      await onLog("stdout", `[ollama] Turn ${totalTurns}/${maxTurns}\n`);

      // 构建请求
      const request: OllamaChatRequest = {
        model,
        messages: workingMessages,
        tools: tools.length > 0 ? tools : undefined,
        stream: false,
        options: modelOptions,
      };

      // 调用 Ollama API（非流式，以获取完整的 tool_calls）
      let response: OllamaChatResponse;
      try {
        response = await callOllamaChat(request, baseUrl, abortSignal);
      } catch (error) {
        // Ollama 服务断开
        const errorMsg = error instanceof Error ? error.message : String(error);
        await onLog("stderr", `[ollama] Ollama API error: ${errorMsg}\n`);
        return buildResult({
          output: lastTextOutput,
          totalTurns,
          totalToolCalls,
          inputTokens,
          outputTokens,
          inferredDisposition,
          error: errorMsg,
        });
      }

      // 累计 token 使用量
      if (response.prompt_eval_count) {
        inputTokens += response.prompt_eval_count;
      }
      if (response.eval_count) {
        outputTokens += response.eval_count;
      }

      const assistantMessage = response.message;
      const toolCalls = assistantMessage.tool_calls;

      // 情况 1：模型没有通过 API 返回 tool_calls
      if (!toolCalls || toolCalls.length === 0) {
        if (assistantMessage.content) {
          // 尝试从文本中解析 tool call（模型可能以文本形式输出了 tool call）
          const parsedToolCalls = parseToolCallsFromText(assistantMessage.content);

          if (parsedToolCalls && parsedToolCalls.length > 0) {
            // 成功从文本中解析出 tool call，继续执行
            await onLog("stdout", `[ollama] Parsed ${parsedToolCalls.length} tool call(s) from text output\n`);

            // 将 assistant 消息加入消息列表（作为包含 tool_calls 的消息）
            workingMessages.push({
              role: "assistant",
              content: assistantMessage.content,
              tool_calls: parsedToolCalls,
            });

            // 执行解析出的 tool calls
            for (const toolCall of parsedToolCalls) {
              totalToolCalls++;
              const { name, arguments: toolArgs } = toolCall.function;
              const argsObj = (typeof toolArgs === "object" && toolArgs !== null)
                ? toolArgs as Record<string, unknown>
                : {};

              const argsStr = JSON.stringify(argsObj);
              await onLog("stdout", `[ollama] Tool call (parsed from text): ${name}(${argsStr})\n`);

              // 执行 tool call
              const result = await executeToolCall(name, argsObj, toolExecutorOptions);

              const statusStr = result.success ? "success" : "error";
              await onLog("stdout", `[ollama] Tool result: ${statusStr} (${result.duration}ms)\n`);

              // 将 tool result 加入消息列表
              const resultContent = JSON.stringify(result.data);
              workingMessages.push({
                role: "tool",
                content: resultContent,
              });

              // 推断 disposition
              if (name === "update_issue" && result.success) {
                const status = argsObj.status;
                if (status === "done") inferredDisposition = "done";
                else if (status === "blocked") inferredDisposition = "blocked";
                else if (status === "cancelled") inferredDisposition = "cancelled";
              }
            }

            // 继续下一轮循环
            continue;
          }

          // 没有解析出 tool call，正常处理文本输出
          lastTextOutput += assistantMessage.content;
          await onLog("stdout", assistantMessage.content);
          if (!assistantMessage.content.endsWith("\n")) {
            await onLog("stdout", "\n");
          }
        }

        // 如果是第一轮就没有 tool_calls 也没有文本 tool call，说明模型不支持 tool calling
        if (totalTurns === 1) {
          await onLog("stdout", `[ollama] Model did not use tool calling, falling back to text mode\n`);
          return buildResult({
            output: lastTextOutput,
            totalTurns,
            totalToolCalls,
            inputTokens,
            outputTokens,
            inferredDisposition,
            fallbackToTextMode: true,
          });
        }

        // 正常结束
        break;
      }

      // 情况 2：模型调用了 tool(s)
      // 先将 assistant 消息（包含 tool_calls）加入消息列表
      workingMessages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        tool_calls: toolCalls,
      });

      // 如果 assistant 有文本内容，也输出
      if (assistantMessage.content) {
        lastTextOutput += assistantMessage.content;
        await onLog("stdout", assistantMessage.content);
        if (!assistantMessage.content.endsWith("\n")) {
          await onLog("stdout", "\n");
        }
      }

      // 逐个执行 tool calls
      for (const toolCall of toolCalls) {
        totalToolCalls++;
        const { name, arguments: toolArgs } = toolCall.function;

        // 验证 tool call 格式
        if (!name || typeof name !== "string") {
          consecutiveInvalidCalls++;
          await onLog("stderr", `[ollama] Invalid tool call: missing function name\n`);

          if (consecutiveInvalidCalls >= MAX_CONSECUTIVE_INVALID) {
            await onLog("stderr", `[ollama] ${MAX_CONSECUTIVE_INVALID} consecutive invalid tool calls, ending loop\n`);
            return buildResult({
              output: lastTextOutput,
              totalTurns,
              totalToolCalls,
              inputTokens,
              outputTokens,
              inferredDisposition,
              error: `${MAX_CONSECUTIVE_INVALID} consecutive invalid tool calls`,
            });
          }

          workingMessages.push({
            role: "tool",
            content: JSON.stringify({ error: "Invalid tool call: missing function name" }),
          });
          continue;
        }

        // 重置连续无效计数器
        consecutiveInvalidCalls = 0;

        const argsObj = (typeof toolArgs === "object" && toolArgs !== null)
          ? toolArgs as Record<string, unknown>
          : {};

        const argsStr = JSON.stringify(argsObj);
        await onLog("stdout", `[ollama] Tool call: ${name}(${argsStr})\n`);

        // 执行 tool call
        const result = await executeToolCall(name, argsObj, toolExecutorOptions);

        const statusStr = result.success ? "success" : "error";
        await onLog("stdout", `[ollama] Tool result: ${statusStr} (${result.duration}ms)\n`);

        // 将 tool result 加入消息列表
        const resultContent = JSON.stringify(result.data);
        workingMessages.push({
          role: "tool",
          content: resultContent,
        });

        // 推断 disposition：如果 update_issue 设置了 status
        if (name === "update_issue" && result.success) {
          const status = argsObj.status;
          if (status === "done") {
            inferredDisposition = "done";
          } else if (status === "blocked") {
            inferredDisposition = "blocked";
          } else if (status === "cancelled") {
            inferredDisposition = "cancelled";
          }
        }
      }
    }

    // 检查是否达到最大轮次
    const maxTurnsReached = totalTurns >= maxTurns;
    if (maxTurnsReached) {
      await onLog("stderr", `[ollama] Max turns reached (${maxTurns})\n`);
    }

    await onLog("stdout", `[ollama] Agent loop completed: ${totalTurns} turns, ${totalToolCalls} tool calls\n`);

    return buildResult({
      output: lastTextOutput,
      totalTurns,
      totalToolCalls,
      inputTokens,
      outputTokens,
      inferredDisposition,
      maxTurnsReached,
    });
  } catch (error) {
    // 未预期的错误
    const errorMsg = error instanceof Error ? error.message : String(error);
    await onLog("stderr", `[ollama] Unexpected error in agent loop: ${errorMsg}\n`);
    return buildResult({
      output: lastTextOutput,
      totalTurns,
      totalToolCalls,
      inputTokens,
      outputTokens,
      inferredDisposition,
      error: errorMsg,
    });
  }
}

// ============ 辅助函数 ============

function buildResult(params: {
  output: string;
  totalTurns: number;
  totalToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  inferredDisposition: string | null;
  fallbackToTextMode?: boolean;
  maxTurnsReached?: boolean;
  error?: string;
}): AgentLoopResult {
  return {
    output: params.output,
    totalTurns: params.totalTurns,
    totalToolCalls: params.totalToolCalls,
    usage: {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
    },
    inferredDisposition: params.inferredDisposition,
    fallbackToTextMode: params.fallbackToTextMode ?? false,
    maxTurnsReached: params.maxTurnsReached ?? false,
    error: params.error,
  };
}
