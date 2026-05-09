# Ollama Adapter Tuning Guide

This document records common issues, root cause analysis, and solutions encountered when using the Ollama (local) adapter in production.

---

## 1. Agent Loop Timeout Abort ("This operation was aborted")

### Symptoms

- Run fails after some time with: `[ollama] Ollama API error: This operation was aborted`
- Adapter result JSON shows `"stopReason": "adapter_failed"`
- The model may have partially or fully completed the task, but the final round was interrupted

### Root Cause

The Ollama adapter has a global timeout mechanism (`timeoutSec`). When the total Agent Loop execution time exceeds this value, `AbortController.abort()` is triggered, interrupting the current Ollama API call.

Local LLMs (e.g., qwen3:32b, llama3.3:70b) have slow inference speeds — each conversation turn may take 30–90 seconds. When the Agent Loop executes multiple rounds (7+) of tool calling, the total time easily exceeds the default timeout.

### Solutions

**Option A: Increase timeout (recommended)**

In the Paperclip UI Agent configuration page, set the "Timeout (seconds)" field to a larger value:

| Model Size | Recommended Timeout |
|-----------|-------------------|
| 7B–14B    | 600s (10 minutes) |
| 32B–36B   | 900s (15 minutes) |
| 70B+      | 1800s (30 minutes) |

The default has been adjusted from 300s to **900s** (15 minutes).

**Option B: Reduce maxTurns**

If the task doesn't require many rounds, reduce "Max turns" from the default 20 to 10–15 to decrease total execution time.

**Option C: Use a smaller/faster model**

For simple tasks, using 7B–14B models (e.g., qwen2.5:14b) can significantly reduce per-turn inference time.

---

## 2. Issues Created with "backlog" Status Won't Auto-Execute

### Symptoms

- Agent creates sub-issues via tool calling, but they remain in `backlog` status
- Issues in `backlog` status are not automatically assigned or executed

### Root Cause

The server-side `createIssueSchema` defaults `status` to `"backlog"`, which is a reasonable default for manually created issues. However, sub-tasks created by agents via tool calling should default to `"todo"` status to be automatically picked up for execution.

### Solution

The `create_issue` tool in `paperclip-tools.ts` has been updated to default status to `"todo"`. If this issue persists, verify that the tool definition correctly passes the status field.

---

## 3. Model Doesn't Support Tool Calling — Cannot Enter Agent Loop

### Symptoms

- Agent executes only once and marks the issue as done
- No tool call records in logs
- Model only outputs text without invoking any tools

### Root Cause

Not all Ollama models support tool calling. You must use a model that supports function calling.

### Solution

Ensure you're using a model that supports tool calling:
- ✅ `qwen2.5:7b+`, `qwen3:*`
- ✅ `llama3.1:8b+`, `llama3.3:*`
- ✅ `mistral-nemo`, `mistral-large`
- ❌ `codellama` (no tool calling support)
- ❌ `phi3` (some versions lack support)

Refer to the Ollama official documentation to confirm tool calling support for your model.

---

## 4. Ollama Service Connection Failure

### Symptoms

- Configuration page cannot load the model list
- Execution fails with "Ollama service unreachable"

### Solution

1. Confirm Ollama is running: `ollama serve`
2. Verify the Base URL is correct (default: `http://localhost:11434`)
3. If Ollama runs on a different port or remote machine, update the Base URL accordingly

---

## 5. Insufficient Context Window Causes Degraded Inference Quality

### Symptoms

- Model output quality noticeably degrades in later Agent Loop turns
- Model starts repeating previous content or producing irrelevant output

### Root Cause

Multi-turn conversations accumulate a large number of tokens (system prompt + message history + tool results), potentially exceeding the model's context window.

### Solution

Set "Context length" (`num_ctx`) in the configuration:

| Model | Recommended num_ctx |
|-------|-------------------|
| 7B models | 8192–16384 |
| 32B+ models | 16384–32768 |

Note: Increasing `num_ctx` will increase VRAM usage and inference time.

---

## 6. Environment Variables

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `PAPERCLIP_AGENT_JWT_SECRET` | JWT signing secret for agents. Required for tool calling within Agent Loop to authenticate Paperclip API requests. |

### Setup

```bash
export PAPERCLIP_AGENT_JWT_SECRET="your-secret-key"
```

If this variable is not set, all tool calls within the Agent Loop will fail authentication, causing all API calls to fail.

---

## 7. Configuration Parameters Quick Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `baseUrl` | string | `http://localhost:11434` | Ollama API endpoint |
| `model` | string | (required) | Model name, must match output of `ollama list` |
| `systemPrompt` | string | (empty) | Custom system prompt |
| `temperature` | number | (model default) | Generation temperature |
| `contextLength` | number | (model default) | Context window size |
| `timeoutSec` | number | 900 | Global timeout in seconds |
| `agentLoopEnabled` | boolean | true | Whether Agent Loop is enabled |
| `maxTurns` | number | 20 | Maximum Agent Loop turns |
| `toolCallTimeout` | number | 30 | Per-tool-call timeout in seconds |

---

## 8. Troubleshooting Flowchart

When encountering Agent execution issues, follow this order:

```
1. Check if Ollama service is running → ollama serve
2. Check if model is pulled → ollama list
3. Check if model supports tool calling → see Section 3
4. Check Run detail stderr logs → identify specific error
5. If timeout → increase timeoutSec (see Section 1)
6. If API auth failure → check PAPERCLIP_AGENT_JWT_SECRET
7. If issues don't auto-execute → verify issue status is "todo"
```
