import { createRequire } from "node:module";
import type { AppSelection, Catalog, TargetApp } from "../types.js";
import { opencodeConfigPath, opencodeDbPath } from "../paths.js";
import { readJson, writeJsonAtomic } from "../fsutil.js";
import { matchProvider, getModel } from "../catalog.js";
import { withV1 } from "../url.js";
import {
  connectOpenCodeServer,
  createCredential,
  listCredentials,
  removeCredential,
} from "../opencode-server.js";

interface OpenCodeModelEntry {
  name?: string;
  options?: Record<string, unknown>;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache?: number };
}

interface OpenCodeProviderEntry {
  npm?: string;
  name?: string;
  options?: { baseURL?: string; apiKey?: string };
  models?: Record<string, OpenCodeModelEntry>;
}

interface OpenCodeConfig {
  model?: string;
  provider?: Record<string, OpenCodeProviderEntry>;
  [k: string]: unknown;
}

/* ---------- node:sqlite 兼容加载（仅用于只读检测） ----------
 * node:sqlite 自 Node 22.13 起才默认可用（更早版本需 --experimental-sqlite 或根本没有）。
 * 用 createRequire + try/catch 加载：老版本 Node 上程序仍能启动，
 * 只是「当前生效 key」的检测退化为读 opencode.json 的 options.apiKey。
 * 注意：AgentDeck 不再写 opencode.db——key 的写入一律走官方 server API，
 * 详见 opencode-server.ts。
 */
interface SqliteStatement {
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

let sqliteCtor: SqliteCtor | null | undefined;

function getSqlite(): SqliteCtor | null {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const mod = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync?: SqliteCtor };
    sqliteCtor = mod.DatabaseSync ?? null;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

/* ---------- credential 表只读检测 ---------- */

interface CredentialRow {
  value: string;
}

/**
 * 读取某 provider 当前生效的凭据 key；DB 不存在或读不到返回 null。
 * 排序复刻 opencode 的选择语义（core/credential.ts 按 asc(active), asc(time_created), asc(id)
 * 排序后倒序取第一个）：active=1 的最新行优先，其后按时间新的优先。
 */
function readCredentialKey(dbPath: string, providerId: string): string | null {
  const DatabaseSync = getSqlite();
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1",
        )
        .get(providerId) as CredentialRow | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.value) as { type?: string; key?: string };
      return parsed.type === "key" && typeof parsed.key === "string" ? parsed.key : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 该 provider 在凭据库中是否已有凭据行；无法判断（无 node:sqlite / DB 不存在）返回 false */
function hasCredentialRow(dbPath: string, providerId: string): boolean {
  const DatabaseSync = getSqlite();
  if (!DatabaseSync) return false;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return !!db.prepare("SELECT 1 FROM credential WHERE integration_id = ? LIMIT 1").get(providerId);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** 检测当前生效的 API key：优先 credential 表（只读），其次 opencode.json 的 options.apiKey */
function detectApiKey(providerId: string): string | null {
  const fromDb = readCredentialKey(opencodeDbPath(), providerId);
  if (fromDb !== null) return fromDb;
  const cfg = readJson<OpenCodeConfig>(opencodeConfigPath());
  return cfg?.provider?.[providerId]?.options?.apiKey ?? null;
}

/** OpenCode：model 与 provider 段写 opencode.json；API key 走官方 server API 写凭据存储 */
export const opencodeTarget: TargetApp = {
  id: "opencode",
  name: "OpenCode",

  paths: () => [opencodeConfigPath()],

  detect(catalog) {
    const cfg = readJson<OpenCodeConfig>(opencodeConfigPath());

    let providerId: string | null = null;
    let model: string | null = null;
    if (cfg?.model && cfg.model.includes("/")) {
      const idx = cfg.model.indexOf("/");
      providerId = cfg.model.slice(0, idx);
      model = cfg.model.slice(idx + 1) || null;
    }

    const baseURL = providerId ? cfg?.provider?.[providerId]?.options?.baseURL ?? null : null;
    const apiKey = providerId ? detectApiKey(providerId) : null;

    if (providerId) {
      const current = {
        provider: matchProvider(catalog, { apiKey, baseURL }),
        baseURL,
        model,
        apiKey,
      };
      return {
        id: "opencode",
        name: "OpenCode",
        paths: [opencodeConfigPath()],
        current,
      };
    }

    return {
      id: "opencode",
      name: "OpenCode",
      paths: [opencodeConfigPath()],
      current: null,
    };
  },

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

  async apply(sel: AppSelection, catalog: Catalog) {
    const provider = catalog.providers[sel.provider];
    const model = getModel(catalog, sel.model);
    if (!provider) return { ok: false, changedFiles: [], error: `未知 provider: ${sel.provider}` };
    if (!model) return { ok: false, changedFiles: [], error: `未知 model: ${sel.model}` };
    if (!provider.baseUrls.includes(sel.baseURL)) {
      return { ok: false, changedFiles: [], error: `${sel.baseURL} 不在 ${sel.provider} 的 base_urls 中` };
    }

    const configPath = opencodeConfigPath();
    const changedFiles: string[] = [];

    // 1. API key —— 走 opencode 官方 server API 写凭据存储。
    //    凭据库里的生效凭据优先于 opencode.json 的 options.apiKey，只写配置文件对
    //    已有凭据的 provider 不生效，所以 key 必须从这里过。
    let keyViaApi = false;
    const server = await connectOpenCodeServer();
    if (server) {
      try {
        const entries = await listCredentials(server);
        const mine = entries.filter((e) => e.integrationID === sel.provider);
        let active = mine.find((e) => e.active);
        /* 幂等：生效凭据已是目标 key 则不再创建，重复 apply 不会累积凭据行 */
        if (!(active?.value.type === "key" && active.value.key === provider.apiKey)) {
          active = await createCredential(server, sel.provider, provider.apiKey);
        }
        /* 清理本工具历史上写入的旧行（label "API key"），保留当前生效行；用户自己登录产生的行不动 */
        for (const e of mine) {
          if (e.label === "API key" && e.id !== active?.id) {
            await removeCredential(server, e.id).catch(() => {});
          }
        }
        keyViaApi = true;
      } catch {
        /* API 路径失败 → 回退到配置文件 */
      } finally {
        server.close();
      }
    }

    // 2. opencode.json —— 默认 model 与 provider 段
    try {
      const cfg = readJson<OpenCodeConfig>(configPath) ?? {};
      cfg.provider = cfg.provider ?? {};

      let entry = cfg.provider[sel.provider];
      if (!entry) {
        entry = cfg.provider[sel.provider] = {
          npm: "@ai-sdk/openai-compatible",
          name: sel.provider,
          options: {},
          models: {},
        };
      }
      entry.name = entry.name ?? sel.provider;
      entry.options = entry.options ?? {};
      /* openai-compatible 协议：自动补 /v1 后缀 */
      entry.options.baseURL = withV1(sel.baseURL);

      entry.models = entry.models ?? {};
      const m = entry.models[sel.model] ?? {};
      m.name = m.name ?? sel.model;
      m.limit = {
        ...(m.limit ?? {}),
        context: model.contextWindow,
        ...(model.maxOutputTokens !== undefined ? { output: model.maxOutputTokens } : {}),
      };
      m.cost = {
        ...(m.cost ?? {}),
        input: model.price.input,
        output: model.price.output,
        ...(model.price.cacheRead !== undefined ? { cache: model.price.cacheRead } : {}),
      };
      entry.models[sel.model] = m;

      cfg.model = `${sel.provider}/${sel.model}`;

      if (keyViaApi) {
        /* key 已在凭据库中生效，配置里不再留副本（凭据存在时配置里的 key 本就被忽略） */
        delete entry.options.apiKey;
      } else {
        /* 官方接口不可用时的兜底：写 options.apiKey（opencode 无凭据行时会使用它） */
        entry.options.apiKey = provider.apiKey;
      }

      writeJsonAtomic(configPath, cfg);
      changedFiles.push(configPath);
    } catch (e) {
      return { ok: false, changedFiles, error: `写入失败：${(e as Error).message}` };
    }

    if (!keyViaApi && hasCredentialRow(opencodeDbPath(), sel.provider)) {
      return {
        ok: true,
        changedFiles,
        warning:
          "opencode 官方接口不可用，key 已写入 opencode.json 兜底；但凭据库中已有该 provider 的凭据，实际生效的可能仍是旧 key。可启动 opencode 后重试，或运行 opencode auth login 更新",
      };
    }

    return { ok: true, changedFiles };
  },
};
