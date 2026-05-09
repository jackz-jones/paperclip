/**
 * Ollama 模型发现模块
 * 负责从 Ollama 服务获取可用模型列表，并提供缓存机制
 */

import { models as fallbackModels, DEFAULT_OLLAMA_BASE_URL } from "../index.js";
import { fetchOllamaModels, type OllamaModelInfo } from "./ollama-client.js";

export interface OllamaModelEntry {
  id: string;
  label: string;
  size?: number;
  parameterSize?: string;
  family?: string;
}

// 缓存相关
let cachedModels: OllamaModelEntry[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 缓存有效期 60 秒

/**
 * 将 Ollama API 返回的模型信息转换为标准格式
 */
function toModelEntry(info: OllamaModelInfo): OllamaModelEntry {
  return {
    id: info.name,
    label: info.name,
    size: info.size,
    parameterSize: info.details?.parameter_size,
    family: info.details?.family,
  };
}

/**
 * 获取 Ollama 本地已安装的模型列表
 * 带缓存机制，避免频繁请求
 * 当 Ollama 服务不可达时返回 fallback 模型列表
 */
export async function listOllamaModels(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
): Promise<OllamaModelEntry[]> {
  const now = Date.now();

  // 检查缓存是否有效
  if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  try {
    const response = await fetchOllamaModels(baseUrl);
    cachedModels = response.models.map(toModelEntry);
    cacheTimestamp = now;
    return cachedModels;
  } catch {
    // Ollama 服务不可达时返回 fallback 列表
    return fallbackModels.map((m) => ({
      id: m.id,
      label: m.label,
    }));
  }
}

/**
 * 强制刷新模型列表缓存
 */
export async function refreshOllamaModels(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
): Promise<OllamaModelEntry[]> {
  // 清除缓存，强制重新获取
  cachedModels = null;
  cacheTimestamp = 0;
  return listOllamaModels(baseUrl);
}

/**
 * 清除模型缓存（用于测试）
 */
export function clearModelCache(): void {
  cachedModels = null;
  cacheTimestamp = 0;
}
