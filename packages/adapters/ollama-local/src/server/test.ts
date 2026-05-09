/**
 * Ollama adapter 环境检测
 * 验证 Ollama 服务可达性和模型可用性
 */

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_BASE_URL } from "../index.js";
import { checkOllamaReachable, fetchOllamaModels } from "./ollama-client.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config;

  const baseUrl =
    typeof config.baseUrl === "string" && config.baseUrl.trim()
      ? config.baseUrl.trim()
      : DEFAULT_OLLAMA_BASE_URL;
  const configuredModel =
    typeof config.model === "string" ? config.model.trim() : "";

  // 检查 baseUrl 格式
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      checks.push({
        code: "ollama_invalid_url_protocol",
        level: "error",
        message: `baseUrl 协议无效: ${url.protocol}`,
        hint: "Ollama 服务地址应使用 http:// 或 https:// 协议",
      });
      return {
        adapterType: "ollama_local",
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  } catch {
    checks.push({
      code: "ollama_invalid_url",
      level: "error",
      message: `baseUrl 格式无效: ${baseUrl}`,
      hint: "请提供有效的 URL，例如 http://localhost:11434",
    });
    return {
      adapterType: "ollama_local",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // 检查 Ollama 服务可达性
  const reachable = await checkOllamaReachable(baseUrl);
  if (!reachable) {
    checks.push({
      code: "ollama_unreachable",
      level: "error",
      message: `Ollama 服务不可达: ${baseUrl}`,
      hint: "请确保 Ollama 已启动。运行 `ollama serve` 启动服务，或检查 baseUrl 配置是否正确。",
    });
    return {
      adapterType: "ollama_local",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "ollama_reachable",
    level: "info",
    message: `Ollama 服务可达: ${baseUrl}`,
  });

  // 获取模型列表
  try {
    const tagsResponse = await fetchOllamaModels(baseUrl);
    const modelCount = tagsResponse.models.length;

    checks.push({
      code: "ollama_models_available",
      level: "info",
      message: `发现 ${modelCount} 个本地模型`,
      detail: modelCount > 0
        ? `可用模型: ${tagsResponse.models.map((m) => m.name).join(", ")}`
        : null,
    });

    if (modelCount === 0) {
      checks.push({
        code: "ollama_no_models",
        level: "warn",
        message: "未发现本地已安装的模型",
        hint: "运行 `ollama pull llama3.3` 下载模型",
      });
      return {
        adapterType: "ollama_local",
        status: "warn",
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    // 检查配置的模型是否已安装
    if (configuredModel) {
      const modelNames = tagsResponse.models.map((m) => m.name);
      // Ollama 模型名可能带有 :latest 后缀
      const modelInstalled = modelNames.some(
        (name) =>
          name === configuredModel ||
          name === `${configuredModel}:latest` ||
          name.startsWith(`${configuredModel}:`),
      );

      if (!modelInstalled) {
        checks.push({
          code: "ollama_model_not_installed",
          level: "warn",
          message: `配置的模型 "${configuredModel}" 未在本地安装`,
          hint: `运行 \`ollama pull ${configuredModel}\` 下载该模型`,
        });
        return {
          adapterType: "ollama_local",
          status: "warn",
          checks,
          testedAt: new Date().toISOString(),
        };
      }

      checks.push({
        code: "ollama_model_installed",
        level: "info",
        message: `模型 "${configuredModel}" 已安装`,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    checks.push({
      code: "ollama_models_fetch_error",
      level: "warn",
      message: `获取模型列表失败: ${errorMessage}`,
    });
    return {
      adapterType: "ollama_local",
      status: "warn",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  return {
    adapterType: "ollama_local",
    status: "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
