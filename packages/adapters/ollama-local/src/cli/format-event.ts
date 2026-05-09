import pc from "picocolors";

/**
 * 将 Ollama adapter 的 stdout 日志格式化为 CLI 终端友好的输出
 * 支持 Agent Loop 的 tool call / tool result 日志
 */
export function printOllamaStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  // Tool call 日志 — 黄色高亮
  if (line.startsWith("[ollama] Tool call:")) {
    console.log(pc.yellow(line));
    return;
  }

  // Tool result 日志 — 成功绿色，失败红色
  if (line.startsWith("[ollama] Tool result:")) {
    if (line.includes("success")) {
      console.log(pc.green(line));
    } else {
      console.log(pc.red(line));
    }
    return;
  }

  // Turn 日志 — 青色
  if (line.match(/^\[ollama\] Turn \d+/)) {
    console.log(pc.cyan(line));
    return;
  }

  // Agent loop completed 摘要 — 蓝色加粗
  if (line.startsWith("[ollama] Agent loop completed:")) {
    console.log(pc.bold(pc.blue(line)));
    return;
  }

  // 其他系统信息行 — 蓝色
  if (line.startsWith("[ollama]")) {
    console.log(pc.blue(line));
    return;
  }

  // 模型生成的文本内容 — 绿色
  console.log(pc.green(line));
}
