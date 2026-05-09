import type { CreateConfigValues } from "@paperclipai/adapter-utils";

/**
 * 从 UI 表单值构建 Ollama adapter 配置
 */
export function buildOllamaLocalConfig(
  values: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (values.model?.trim()) ac.model = values.model.trim();
  if (values.cwd) ac.cwd = values.cwd;
  if (values.instructionsFilePath) ac.instructionsFilePath = values.instructionsFilePath;

  // Ollama 特有的 schema 字段
  if (values.adapterSchemaValues) {
    Object.assign(ac, values.adapterSchemaValues);
  }

  return ac;
}
