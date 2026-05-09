/**
 * Agent Loop 集成测试
 * 测试场景：正常多轮 tool calling、模型不支持 tool calling 退回、
 * 最大轮次限制、tool call 超时、连续无效 tool call、disposition 推断
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop } from "../src/server/agent-loop.js";
import { getPaperclipToolDefinitions } from "../src/server/tools/paperclip-tools.js";
import { buildAgentLoopSystemPrompt } from "../src/server/tools/system-prompt.js";
import { executeToolCall } from "../src/server/tools/tool-executor.js";
import type { OllamaChatMessage } from "../src/server/ollama-client.js";

// Mock ollama-client 模块
vi.mock("../src/server/ollama-client.js", () => ({
  callOllamaChat: vi.fn(),
}));

// Mock tool-executor 模块
vi.mock("../src/server/tools/tool-executor.js", () => ({
  executeToolCall: vi.fn(),
}));

import { callOllamaChat } from "../src/server/ollama-client.js";

const mockCallOllamaChat = vi.mocked(callOllamaChat);
const mockExecuteToolCall = vi.mocked(executeToolCall);

const baseMessages: OllamaChatMessage[] = [
  { role: "system", content: "You are a test agent." },
  { role: "user", content: "Do something." },
];

const baseOptions = {
  model: "llama3.3",
  baseUrl: "http://localhost:11434",
  tools: getPaperclipToolDefinitions(),
  toolExecutorOptions: {
    authToken: "test-jwt-token",
    apiBaseUrl: "http://localhost:3000",
    runId: "test-run-123",
    timeoutMs: 30000,
  },
  maxTurns: 20,
  onLog: vi.fn().mockResolvedValue(undefined),
};

describe("Agent Loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("正常多轮 tool calling", () => {
    it("应该执行多轮 tool call 然后以文本响应结束", async () => {
      // 第一轮：模型调用 get_my_identity
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "get_my_identity", arguments: {} } },
          ],
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 20,
      });

      mockExecuteToolCall.mockResolvedValueOnce({
        success: true,
        data: { agentId: "agent-1", name: "CEO", companyId: "company-1" },
        status: 200,
        duration: 50,
      });

      // 第二轮：模型调用 update_issue
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "update_issue", arguments: { issueId: "issue-1", status: "done" } } },
          ],
        },
        done: true,
        prompt_eval_count: 150,
        eval_count: 30,
      });

      mockExecuteToolCall.mockResolvedValueOnce({
        success: true,
        data: { id: "issue-1", status: "done" },
        status: 200,
        duration: 80,
      });

      // 第三轮：模型输出纯文本（结束循环）
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:02Z",
        message: {
          role: "assistant",
          content: "Task completed successfully.",
        },
        done: true,
        prompt_eval_count: 200,
        eval_count: 10,
      });

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
      });

      expect(result.totalTurns).toBe(3);
      expect(result.totalToolCalls).toBe(2);
      expect(result.output).toContain("Task completed successfully.");
      expect(result.inferredDisposition).toBe("done");
      expect(result.fallbackToTextMode).toBe(false);
      expect(result.maxTurnsReached).toBe(false);
      expect(result.usage.inputTokens).toBe(450); // 100 + 150 + 200
      expect(result.usage.outputTokens).toBe(60); // 20 + 30 + 10
    });
  });

  describe("模型不支持 tool calling 退回", () => {
    it("第一轮无 tool_calls 时应该退回文本模式", async () => {
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: "I cannot use tools. Here is my text response.\n[DONE]",
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 50,
      });

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
      });

      expect(result.fallbackToTextMode).toBe(true);
      expect(result.totalTurns).toBe(1);
      expect(result.totalToolCalls).toBe(0);
      expect(result.output).toContain("I cannot use tools");
    });
  });

  describe("最大轮次限制", () => {
    it("达到 maxTurns 时应该强制结束", async () => {
      const maxTurns = 3;

      // 每轮都返回 tool call，永不结束
      for (let i = 0; i < maxTurns; i++) {
        mockCallOllamaChat.mockResolvedValueOnce({
          model: "llama3.3",
          created_at: "2024-01-01T00:00:00Z",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "get_inbox", arguments: {} } },
            ],
          },
          done: true,
          prompt_eval_count: 50,
          eval_count: 10,
        });

        mockExecuteToolCall.mockResolvedValueOnce({
          success: true,
          data: { issues: [] },
          status: 200,
          duration: 30,
        });
      }

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
        maxTurns,
      });

      expect(result.maxTurnsReached).toBe(true);
      expect(result.totalTurns).toBe(maxTurns);
      expect(result.totalToolCalls).toBe(maxTurns);
    });
  });

  describe("tool call 执行失败", () => {
    it("tool call 失败时应该将错误反馈给模型而非终止循环", async () => {
      // 第一轮：模型调用 checkout_issue，但返回 409
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "checkout_issue", arguments: { issueId: "issue-1" } } },
          ],
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 20,
      });

      mockExecuteToolCall.mockResolvedValueOnce({
        success: false,
        data: { error: "API returned 409 Conflict", details: "Issue already checked out" },
        status: 409,
        duration: 40,
      });

      // 第二轮：模型收到错误后输出文本
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: "The issue is already checked out by another agent. I'll skip it.",
        },
        done: true,
        prompt_eval_count: 150,
        eval_count: 30,
      });

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
      });

      expect(result.totalTurns).toBe(2);
      expect(result.totalToolCalls).toBe(1);
      expect(result.output).toContain("already checked out");
      expect(result.error).toBeUndefined();
    });
  });

  describe("连续无效 tool call", () => {
    it("连续 3 次无效 tool call 后应该强制结束", async () => {
      // 3 轮都返回无效的 tool call（name 为空）
      for (let i = 0; i < 3; i++) {
        mockCallOllamaChat.mockResolvedValueOnce({
          model: "llama3.3",
          created_at: "2024-01-01T00:00:00Z",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "", arguments: {} } },
            ],
          },
          done: true,
          prompt_eval_count: 50,
          eval_count: 10,
        });
      }

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
      });

      expect(result.error).toContain("consecutive invalid tool calls");
      expect(result.totalTurns).toBeLessThanOrEqual(3);
    });
  });

  describe("Ollama 服务断开", () => {
    it("Ollama 服务中途断开时应该返回已有输出和错误", async () => {
      // 第一轮正常
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: "Starting work...",
          tool_calls: [
            { function: { name: "get_my_identity", arguments: {} } },
          ],
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 20,
      });

      mockExecuteToolCall.mockResolvedValueOnce({
        success: true,
        data: { agentId: "agent-1" },
        status: 200,
        duration: 50,
      });

      // 第二轮：Ollama 断开
      mockCallOllamaChat.mockRejectedValueOnce(
        new Error("fetch failed: connection refused"),
      );

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
      });

      expect(result.error).toContain("connection refused");
      expect(result.totalTurns).toBe(2);
      expect(result.output).toContain("Starting work...");
    });
  });

  describe("Disposition 推断", () => {
    it("从 update_issue status=done 推断 disposition", async () => {
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "update_issue", arguments: { issueId: "issue-1", status: "done" } } },
          ],
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 20,
      });

      mockExecuteToolCall.mockResolvedValueOnce({
        success: true,
        data: { id: "issue-1", status: "done" },
        status: 200,
        duration: 50,
      });

      // 结束
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: "Done.",
        },
        done: true,
        prompt_eval_count: 150,
        eval_count: 10,
      });

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
      });

      expect(result.inferredDisposition).toBe("done");
    });

    it("从 update_issue status=blocked 推断 disposition", async () => {
      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "update_issue", arguments: { issueId: "issue-1", status: "blocked" } } },
          ],
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 20,
      });

      mockExecuteToolCall.mockResolvedValueOnce({
        success: true,
        data: { id: "issue-1", status: "blocked" },
        status: 200,
        duration: 50,
      });

      mockCallOllamaChat.mockResolvedValueOnce({
        model: "llama3.3",
        created_at: "2024-01-01T00:00:01Z",
        message: {
          role: "assistant",
          content: "Blocked - need more info.",
        },
        done: true,
        prompt_eval_count: 150,
        eval_count: 10,
      });

      const result = await runAgentLoop({
        ...baseOptions,
        messages: [...baseMessages],
      });

      expect(result.inferredDisposition).toBe("blocked");
    });
  });
});

describe("Paperclip Tools 定义", () => {
  it("应该返回所有 13 个核心 tools", () => {
    const tools = getPaperclipToolDefinitions();
    expect(tools).toHaveLength(13);

    const toolNames = tools.map((t) => t.function.name);
    expect(toolNames).toContain("get_my_identity");
    expect(toolNames).toContain("get_inbox");
    expect(toolNames).toContain("checkout_issue");
    expect(toolNames).toContain("get_issue_context");
    expect(toolNames).toContain("update_issue");
    expect(toolNames).toContain("add_comment");
    expect(toolNames).toContain("create_issue");
    expect(toolNames).toContain("release_issue");
    expect(toolNames).toContain("list_agents");
    expect(toolNames).toContain("get_dashboard");
    expect(toolNames).toContain("create_agent_hire");
    expect(toolNames).toContain("get_agent_configuration");
    expect(toolNames).toContain("get_agent_icons");
  });

  it("每个 tool 都应该有 description 和 parameters", () => {
    const tools = getPaperclipToolDefinitions();
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeDefined();
      expect(tool.function.parameters.type).toBe("object");
    }
  });
});

describe("System Prompt 构建", () => {
  it("应该包含 agent 身份信息", () => {
    const prompt = buildAgentLoopSystemPrompt({
      agentId: "agent-1",
      companyId: "company-1",
      role: "CEO",
      agentName: "TestAgent",
    });

    expect(prompt).toContain("TestAgent");
    expect(prompt).toContain("agent-1");
    expect(prompt).toContain("company-1");
    expect(prompt).toContain("CEO");
  });

  it("应该包含 heartbeat 协议和 tools 使用指南", () => {
    const prompt = buildAgentLoopSystemPrompt({});

    expect(prompt).toContain("Heartbeat Protocol");
    expect(prompt).toContain("Tools Usage Guide");
    expect(prompt).toContain("Issue Status Rules");
    expect(prompt).toContain("Critical Constraints");
  });

  it("应该追加自定义 system prompt", () => {
    const prompt = buildAgentLoopSystemPrompt(
      {},
      "Always respond in Chinese.",
    );

    expect(prompt).toContain("Additional Instructions");
    expect(prompt).toContain("Always respond in Chinese.");
  });
});
