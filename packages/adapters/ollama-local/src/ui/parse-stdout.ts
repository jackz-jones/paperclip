import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * 解析 Ollama adapter 的 stdout 日志行为 UI 可展示的 TranscriptEntry
 *
 * Ollama adapter 的输出格式：
 * - `[ollama] Turn N/M` — Agent Loop 轮次标记
 * - `[ollama] Tool call: name(args)` — Tool 调用
 * - `[ollama] Tool result: status (duration)` — Tool 执行结果
 * - `[ollama] Agent loop completed: N turns, M tool calls` — 循环结束摘要
 * - `[ollama] ...` 其他系统信息
 * - 其余为模型生成的文本内容
 */
export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line) return [];

  // Tool call 日志: [ollama] Tool call: name({...})
  const toolCallMatch = line.match(/^\[ollama\] Tool call: (\w+)\((.+)\)$/);
  if (toolCallMatch) {
    const [, name, argsStr] = toolCallMatch;
    let input: unknown = {};
    try {
      input = JSON.parse(argsStr);
    } catch {
      input = { raw: argsStr };
    }
    return [{ kind: "tool_call", ts, name: name!, input }];
  }

  // Tool result 日志: [ollama] Tool result: status (duration)
  const toolResultMatch = line.match(/^\[ollama\] Tool result: (\w+) \((\d+)ms\)$/);
  if (toolResultMatch) {
    const [, status, duration] = toolResultMatch;
    const isError = status !== "success";
    return [{
      kind: "tool_result",
      ts,
      toolUseId: "",
      content: `${status} (${duration}ms)`,
      isError,
    }];
  }

  // 系统信息行（Turn、Agent loop completed 等）
  if (line.startsWith("[ollama]")) {
    return [{ kind: "system", ts, text: line.replace(/^\[ollama\]\s*/, "") }];
  }

  // 模型生成的文本内容
  return [{ kind: "assistant", ts, text: line }];
}
