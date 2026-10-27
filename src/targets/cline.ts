import { join } from "node:path";
import type { AppSelection, Catalog, TargetApp } from "../types.js";
import { clineSettingsDir } from "../paths.js";
import { readJson, writeJsonAtomic } from "../fsutil.js";
import { matchProvider, getModel } from "../catalog.js";
import { withV1 } from "../url.js";

interface ClineProviderSettings {
  provider?: string;
  apiKey?: string;
  model?: string;
  contextWindow?: number;
  baseUrl?: string;
  headers?: Record<string, string>;
  reasoning?: { enabled?: boolean; effort?: string };
  [k: string]: unknown;
}

interface ClineProvidersDoc {
  version?: number;
  lastUsedProvider?: string;
  providers?: Record<string, { settings?: ClineProviderSettings; updatedAt?: string; tokenSource?: string }>;
}

function providersPath(): string {
  return join(clineSettingsDir(), "providers.json");
}

/** Cline 桌面版在 providers.json 中的槽位：openai-compatible 网关最通用 */
function clineSlotFor(providerProtocol: string | undefined): string {
  switch (providerProtocol) {
    case "gemini":
      return "gemini";
    case "anthropic":
      return "anthropic";
    default:
      return "openai-compatible";
  }
}

/**
 * Cline 桌面版：唯一有效配置是 ~/.cline/data/settings/providers.json。
 * （同目录的 models.json / secrets.json 是程序遗留的陈旧数据，Cline 并不读取，无需同步。）
 */
export const clineTarget: TargetApp = {
  id: "cline",
  name: "Cline",

  paths: () => [providersPath()],

  detect(catalog) {
    const doc = readJson<ClineProvidersDoc>(providersPath());
    const slot = doc?.lastUsedProvider;
    const settings = slot ? doc?.providers?.[slot]?.settings : undefined;

    if (settings) {
      const current = {
        provider: matchProvider(catalog, { apiKey: settings.apiKey, baseURL: settings.baseUrl }),
        baseURL: settings.baseUrl ?? null,
        model: settings.model ?? null,
        apiKey: settings.apiKey ?? null,
      };
      return {
        id: "cline",
        name: "Cline",
        paths: [providersPath()],
        current,
      };
    }

    return {
      id: "cline",
      name: "Cline",
      paths: [providersPath()],
      current: null,
    };
  },

  /** 当前 providers.json 是否已经等于该选择 */
  isCurrent(sel: AppSelection, catalog: Catalog): boolean {
    const cur = this.detect(catalog).current;
    const provider = catalog.providers[sel.provider];
    if (!cur || !provider) return false;
    /* openai-compatible 协议写入时会补 /v1，比较须用补全后的地址 */
    return (
      cur.provider === sel.provider &&
      cur.model === sel.model &&
      cur.baseURL === withV1(sel.baseURL) &&
      cur.apiKey === provider.apiKey
    );
  },

  apply(sel: AppSelection, catalog: Catalog) {
    const provider = catalog.providers[sel.provider];
    const model = getModel(catalog, sel.model);
    if (!provider) return { ok: false, changedFiles: [], error: `未知 provider: ${sel.provider}` };
    if (!model) return { ok: false, changedFiles: [], error: `未知 model: ${sel.model}` };
    if (!provider.baseUrls.includes(sel.baseURL)) {
      return { ok: false, changedFiles: [], error: `${sel.baseURL} 不在 ${sel.provider} 的 base_urls 中` };
    }

    const slot = clineSlotFor(provider.protocol);

    try {
      const pp = providersPath();
      const doc = readJson<ClineProvidersDoc>(pp) ?? {};
      doc.version = doc.version ?? 1;
      doc.providers = doc.providers ?? {};

      const entry = doc.providers[slot] ?? {};
      const s = entry.settings ?? {};
      s.provider = slot;
      s.apiKey = provider.apiKey;
      s.model = sel.model;
      if (model.contextWindow > 0) s.contextWindow = model.contextWindow;
      /* openai-compatible 协议：自动补 /v1 后缀 */
      s.baseUrl = withV1(sel.baseURL);
      if (slot === "openai-compatible") {
        s.headers = s.headers ?? {};
        s.reasoning = s.reasoning ?? { enabled: true, effort: "high" };
      }
      entry.settings = s;
      entry.updatedAt = new Date().toISOString();
      entry.tokenSource = entry.tokenSource ?? "manual";
      doc.providers[slot] = entry;
      doc.lastUsedProvider = slot;

      writeJsonAtomic(pp, doc);
      return { ok: true, changedFiles: [pp] };
    } catch (e) {
      return { ok: false, changedFiles: [], error: `写入失败：${(e as Error).message}` };
    }
  },
};
