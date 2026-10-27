import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { AppSelection, Catalog, TargetApp } from "../types.js";
import { opencodeConfigPath, opencodeDbPath } from "../paths.js";
import { readJson, writeJsonAtomic } from "../fsutil.js";
import { matchProvider, getModel } from "../catalog.js";
import { withV1 } from "../url.js";

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

/* ---------- node:sqlite 兼容加载 ----------
 * node:sqlite 自 Node 22.13 起才默认可用（更早版本需 --experimental-sqlite 或根本没有）。
 * 用 createRequire + try/catch 加载：老版本 Node 上程序仍能启动，
 * 只是 OpenCode 的 key 会回退写入 opencode.json 的 options.apiKey。
 */
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
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

/* ---------- credential 表（opencode v2 的 API key 存储于 opencode.db） ---------- */

interface CredentialRow {
  id: string;
  value: string;
}

/** 读取某 provider 在 credential 表中的 key；DB 不存在或无行返回 null */
function readCredentialKey(dbPath: string, providerId: string): string | null {
  const DatabaseSync = getSqlite();
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM credential WHERE integration_id = ?").get(providerId) as
        | CredentialRow
        | undefined;
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

/** 生成形如 cred_xxx 的凭据行 id */
function newCredentialId(): string {
  return `cred_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * 把 key 写入 credential 表（运行中的 opencode 服务会实时读到，无需重启）。
 * DB 文件或表不存在时返回 false（调用方回退为把 key 写进 opencode.json 的 options.apiKey）。
 */
function writeCredentialKey(dbPath: string, providerId: string, apiKey: string): boolean {
  if (!existsSync(dbPath)) return false;
  const DatabaseSync = getSqlite();
  if (!DatabaseSync) return false;
  let db: SqliteDatabase;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    return false;
  }
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credential'")
      .get();
    if (!hasTable) return false;

    const now = Date.now();
    const valueJson = JSON.stringify({ type: "key", key: apiKey });
    const existing = db.prepare("SELECT id FROM credential WHERE integration_id = ?").get(providerId) as
      | CredentialRow
      | undefined;
    if (existing) {
      db.prepare("UPDATE credential SET value = ?, time_updated = ? WHERE integration_id = ?").run(
        valueJson,
        now,
        providerId,
      );
    } else {
      db.prepare(
        "INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(newCredentialId(), providerId, "API key", valueJson, now, now);
    }
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** 检测当前生效的 API key：优先 credential 表，其次 opencode.json 的 options.apiKey */
function detectApiKey(providerId: string): string | null {
  const fromDb = readCredentialKey(opencodeDbPath(), providerId);
  if (fromDb !== null) return fromDb;
  const cfg = readJson<OpenCodeConfig>(opencodeConfigPath());
  return cfg?.provider?.[providerId]?.options?.apiKey ?? null;
}

/** OpenCode：model 与 provider 段写 opencode.json；API key 写 opencode.db 的 credential 表 */
export const opencodeTarget: TargetApp = {
  id: "opencode",
  name: "OpenCode",

  paths: () => [opencodeConfigPath(), opencodeDbPath()],

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
        paths: [opencodeConfigPath(), opencodeDbPath()],
        current,
      };
    }

    return {
      id: "opencode",
      name: "OpenCode",
      paths: [opencodeConfigPath(), opencodeDbPath()],
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

  apply(sel: AppSelection, catalog: Catalog) {
    const provider = catalog.providers[sel.provider];
    const model = getModel(catalog, sel.model);
    if (!provider) return { ok: false, changedFiles: [], error: `未知 provider: ${sel.provider}` };
    if (!model) return { ok: false, changedFiles: [], error: `未知 model: ${sel.model}` };
    if (!provider.baseUrls.includes(sel.baseURL)) {
      return { ok: false, changedFiles: [], error: `${sel.baseURL} 不在 ${sel.provider} 的 base_urls 中` };
    }

    const changedFiles: string[] = [];
    try {
      // 1. opencode.json —— 默认 model 与 provider 段
      const configPath = opencodeConfigPath();
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

      // 2. API key —— 优先写 opencode.db 的 credential 表（v2 的权威存储，运行中的服务实时生效）
      const dbPath = opencodeDbPath();
      if (writeCredentialKey(dbPath, sel.provider, provider.apiKey)) {
        /* DB 凭据存在时会覆盖配置里的 key，无须写入 */
        delete entry.options.apiKey;
        changedFiles.push(dbPath);
      } else {
        /* DB 不可用（尚未初始化）时回退：写入 options.apiKey，opencode 无凭据时会使用它 */
        entry.options.apiKey = provider.apiKey;
      }

      writeJsonAtomic(configPath, cfg);
      changedFiles.push(configPath);

      return { ok: true, changedFiles };
    } catch (e) {
      return { ok: false, changedFiles, error: `写入失败：${(e as Error).message}` };
    }
  },
};
