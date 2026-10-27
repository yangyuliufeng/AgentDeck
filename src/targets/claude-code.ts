import type { AppSelection, Catalog, TargetApp } from "../types.js";
import { claudeSettingsPath } from "../paths.js";
import { readJson, writeJsonAtomic } from "../fsutil.js";
import { matchProvider, getModel } from "../catalog.js";

interface ClaudeSettings {
  env?: Record<string, string>;
  [k: string]: unknown;
}

/** Claude Code：通过 ~/.claude/settings.json 的 env 变量注入 provider / baseURL / model */
export const claudeCodeTarget: TargetApp = {
  id: "claude-code",
  name: "Claude Code",

  paths: () => [claudeSettingsPath()],

  detect(catalog) {
    const cfg = readJson<ClaudeSettings>(claudeSettingsPath());
    const env = cfg?.env;
    const hasEnv = !!(env?.ANTHROPIC_BASE_URL || env?.ANTHROPIC_API_KEY || env?.ANTHROPIC_MODEL);
    if (hasEnv) {
      const current = {
        provider: matchProvider(catalog, { apiKey: env?.ANTHROPIC_API_KEY, baseURL: env?.ANTHROPIC_BASE_URL }),
        baseURL: env?.ANTHROPIC_BASE_URL ?? null,
        model: env?.ANTHROPIC_MODEL ?? null,
        apiKey: env?.ANTHROPIC_API_KEY ?? null,
      };
      return {
        id: "claude-code",
        name: "Claude Code",
        paths: [claudeSettingsPath()],
        current,
      };
    }
    return {
      id: "claude-code",
      name: "Claude Code",
      paths: [claudeSettingsPath()],
      current: null,
    };
  },

  /** 当前 env 是否已经等于该选择 */
  isCurrent(sel: AppSelection, catalog: Catalog): boolean {
    const cur = this.detect(catalog).current;
    const provider = catalog.providers[sel.provider];
    if (!cur || !provider) return false;
    /* claude code 原样使用台账地址 */
    return (
      cur.provider === sel.provider &&
      cur.model === sel.model &&
      cur.baseURL === sel.baseURL &&
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

    const p = claudeSettingsPath();
    const cfg = readJson<ClaudeSettings>(p) ?? {};
    cfg.env = typeof cfg.env === "object" && cfg.env !== null ? cfg.env : {};

    cfg.env.ANTHROPIC_BASE_URL = sel.baseURL;
    cfg.env.ANTHROPIC_API_KEY = provider.apiKey;
    cfg.env.ANTHROPIC_MODEL = sel.model;
    if (model.contextWindow > 0) {
      cfg.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(model.contextWindow);
    }
    if (model.maxOutputTokens) {
      cfg.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(model.maxOutputTokens);
    }

    try {
      writeJsonAtomic(p, cfg);
      return { ok: true, changedFiles: [p] };
    } catch (e) {
      return { ok: false, changedFiles: [], error: `写入失败：${(e as Error).message}` };
    }
  },
};
