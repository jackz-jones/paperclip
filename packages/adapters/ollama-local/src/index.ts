export const type = "ollama_local";
export const label = "Ollama (local)";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_TIMEOUT_SEC = 900;

export const DEFAULT_OLLAMA_MODEL = "llama3.3";

export const models: Array<{ id: string; label: string }> = [
  { id: "llama3.3", label: "Llama 3.3" },
  { id: "llama3.1", label: "Llama 3.1" },
  { id: "codellama", label: "Code Llama" },
  { id: "mistral", label: "Mistral" },
  { id: "qwen2.5-coder", label: "Qwen 2.5 Coder" },
  { id: "qwen2.5", label: "Qwen 2.5" },
  { id: "deepseek-coder-v2", label: "DeepSeek Coder V2" },
  { id: "gemma2", label: "Gemma 2" },
  { id: "phi3", label: "Phi-3" },
];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want Paperclip to run a local Ollama model as the agent runtime
- You want zero-cost local inference without external API keys
- You have Ollama installed and running locally with models pulled
- You want Agent Loop (tool calling) support for multi-step task execution

Don't use when:
- You need high-quality reasoning from frontier models (use claude_code, opencode_local, etc.)
- Ollama is not installed on the machine

Core fields:
- baseUrl (string, optional): Ollama API base URL, defaults to "http://localhost:11434"
- model (string, required): model name as shown by \`ollama list\` (e.g. "llama3.3", "codellama", "mistral")
- systemPrompt (string, optional): system message prepended to the conversation
- temperature (number, optional): generation temperature, defaults to model's default
- contextLength (number, optional): context window size override (num_ctx)
- promptTemplate (string, optional): task prompt template

Agent Loop fields:
- agentLoopEnabled (boolean, optional): enable Agent Loop with tool calling, defaults to true
- maxTurns (number, optional): maximum tool calling loop iterations, defaults to 20
- toolCallTimeout (number, optional): timeout per tool call in seconds, defaults to 30

Operational fields:
- timeoutSec (number, optional): overall request timeout in seconds, defaults to 900 (15 minutes, suitable for large local models)

Notes:
- Ollama must be running locally (\`ollama serve\`) before using this adapter.
- Use \`ollama list\` to see available models, or \`ollama pull <model>\` to download new ones.
- This adapter communicates via Ollama's HTTP API (POST /api/chat).
- Cost is always $0 since inference runs locally.
- Token usage is reported when Ollama provides it in the response.
- Agent Loop mode requires models that support tool calling (llama3.1+, qwen2.5+, mistral-nemo+).
- When Agent Loop is enabled and authToken is available, the adapter will use Paperclip API tools.
- If the model does not support tool calling, it automatically falls back to text generation mode.
`;
