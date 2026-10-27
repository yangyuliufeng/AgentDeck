import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Catalog, ModelInfo, PriceInfo, ProviderInfo } from "./types.js";
import { urlEquals } from "./url.js";
import { displayPath } from "./paths.js";

export interface CatalogLoadResult {
  catalog: Catalog | null;
  error?: string;
}

/* ---------- 字段取值兼容（snake_case / camelCase 都接受） ---------- */

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asUrlList(v: unknown): string[] | undefined {
  /* 单个字符串也接受（只有一个 baseURL 时可省略列表写法） */
  if (typeof v === "string" && v.trim() !== "") return [v.trim()];
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  return items.length > 0 ? items : undefined;
}

/* ---------- 解析与校验 ---------- */

function parsePrice(raw: unknown, where: string): PriceInfo {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where}: price 必须是包含 input / output 的对象`);
  }
  const obj = raw as Record<string, unknown>;
  const input = asNumber(pick(obj, "input"));
  const output = asNumber(pick(obj, "output"));
  if (input === undefined || output === undefined) {
    throw new Error(`${where}: price.input / price.output 必须是数字（每百万 tokens 价格）`);
  }
  const cacheRead = asNumber(pick(obj, "cache_read", "cacheRead"));
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) };
}

function parseProvider(id: string, raw: unknown, where: string): ProviderInfo {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where}: provider 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  const apiKey = asString(pick(obj, "api_key", "apiKey", "key"));
  if (apiKey === undefined) {
    throw new Error(`${where}: 缺少 api_key`);
  }

  const baseUrls = asUrlList(pick(obj, "base_urls", "baseUrls"));
  if (baseUrls === undefined) {
    throw new Error(`${where}: base_urls 必须是至少包含一个 URL 的数组`);
  }

  const protocol = asString(pick(obj, "protocol", "kind"));

  return {
    apiKey,
    baseUrls,
    ...(protocol !== undefined ? { protocol } : {}),
  };
}

function parseModel(id: string, raw: unknown, where: string): ModelInfo {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where}: model 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  const contextWindow = asNumber(pick(obj, "context_window", "contextWindow", "context"));
  if (contextWindow === undefined || contextWindow <= 0) {
    throw new Error(`${where}: context_window 必须是正整数（tokens）`);
  }

  const price = parsePrice(pick(obj, "price", "cost"), `${where}.price`);
  const maxOutputTokens = asNumber(pick(obj, "max_output_tokens", "maxOutputTokens", "max_output"));

  return {
    contextWindow,
    price,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

/** 加载并校验 ~/.config/agent-deck.yaml（providers 与 models 平级） */
export function loadCatalog(path: string): CatalogLoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { catalog: null, error: `无法读取 ${displayPath(path)}，请先创建（格式见 README）` };
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { catalog: null, error: `${displayPath(path)} 不是合法的 YAML：${(e as Error).message}` };
  }

  if (typeof raw !== "object" || raw === null) {
    return { catalog: null, error: `${displayPath(path)} 内容为空或格式不正确` };
  }
  const root = raw as Record<string, unknown>;

  try {
    // providers
    const providersRaw = pick(root, "providers");
    if (typeof providersRaw !== "object" || providersRaw === null || Object.keys(providersRaw).length === 0) {
      return { catalog: null, error: `${displayPath(path)} 缺少 providers 配置（至少一个 provider）` };
    }
    const providers: Record<string, ProviderInfo> = {};
    for (const [id, provRaw] of Object.entries(providersRaw as Record<string, unknown>)) {
      providers[id] = parseProvider(id, provRaw, `providers.${id}`);
    }

    // models（与 providers 平级，模型名即 ID，不与 provider 绑定）
    const modelsRaw = pick(root, "models");
    if (typeof modelsRaw !== "object" || modelsRaw === null || Object.keys(modelsRaw).length === 0) {
      return { catalog: null, error: `${displayPath(path)} 缺少 models 配置（至少一个 model）` };
    }
    const models: Record<string, ModelInfo> = {};
    for (const [id, modelRaw] of Object.entries(modelsRaw as Record<string, unknown>)) {
      models[id] = parseModel(id, modelRaw, `models.${id}`);
    }

    return { catalog: { providers, models } };
  } catch (e) {
    return { catalog: null, error: `${displayPath(path)} 校验失败：${(e as Error).message}` };
  }
}

/** 根据 apiKey / baseURL 反查 catalog 中的 provider id */
export function matchProvider(
  catalog: Catalog | null,
  hints: { apiKey?: string | null; baseURL?: string | null },
): string | null {
  if (!catalog) return null;
  const { apiKey, baseURL } = hints;
  if (apiKey) {
    for (const [id, p] of Object.entries(catalog.providers)) {
      if (p.apiKey === apiKey) return id;
    }
  }
  if (baseURL) {
    for (const [id, p] of Object.entries(catalog.providers)) {
      if (p.baseUrls.some((u) => urlEquals(u, baseURL))) return id;
    }
  }
  return null;
}

/** 取台账中的指定 model，不存在返回 null */
export function getModel(catalog: Catalog, modelId: string): ModelInfo | null {
  return catalog.models[modelId] ?? null;
}
