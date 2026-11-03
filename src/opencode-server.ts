/**
 * OpenCode 官方 server API 客户端。
 *
 * opencode v2 把 API key 存在 ~/.local/share/opencode/opencode.db 的 credential 表，
 * 且生效凭据优先于 opencode.json 里的 options.apiKey——改 key 必须写凭据存储。
 * 直写数据库会耦合 opencode 的内部 schema（且绕过 active 标记与事件），因此这里走
 * 官方给程序化操作留的入口：本地 server 的 /api/credential。
 *
 * server 的获取顺序（与官方 CLI `opencode auth login` 的连接逻辑一致）：
 *   1. 托管后台服务：`opencode service status` 发现 URL，`opencode service get password`
 *      拿 Basic auth 密码；
 *   2. 服务没在跑：瞬时拉起 `opencode serve --stdio --port 0` 子进程（随机密码），
 *      从 stdout 读 ready 行拿 URL，用完关 stdin——server 视 EOF 为租约结束自动退出；
 *   3. 两条路都失败：调用方回退为把 key 写进 opencode.json 的 options.apiKey。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

export interface OpenCodeServer {
  /** 形如 http://127.0.0.1:40963 */
  url: string;
  /** Basic auth 密码；server 未设密码时为 null */
  password: string | null;
  /** 释放连接：瞬时 server 关闭 stdin（EOF 即退出），托管服务为 no-op */
  close(): void;
}

export interface CredentialEntry {
  id: string;
  integrationID: string;
  label: string;
  /** opencode 侧算好的「当前生效」标记（每个 integration 至多一个） */
  active: boolean;
  value: { type: string; key?: string };
}

/* ---------- 连接 ---------- */

/** Windows 上 spawn 不带 shell 解析不到 .cmd/.ps1 包装器 */
const needShell = process.platform === "win32";

/** 托管后台服务发现；任何一步失败返回 null */
function discoverManagedServer(): OpenCodeServer | null {
  let status: ReturnType<typeof spawnSync>;
  try {
    status = spawnSync("opencode", ["service", "status"], { encoding: "utf8", timeout: 5000, shell: needShell });
  } catch {
    return null;
  }
  const url = status.status === 0 ? String(status.stdout ?? "").trim() : "";
  if (!url.startsWith("http")) return null;

  let password: string | null = null;
  try {
    const pw = spawnSync("opencode", ["service", "get", "password"], { encoding: "utf8", timeout: 5000, shell: needShell });
    password = pw.status === 0 ? String(pw.stdout ?? "").trim() || null : null;
  } catch {
    password = null;
  }
  return { url, password, close() {} };
}

const READY_TIMEOUT_MS = 15_000;

/** 瞬时拉起一个私有 server；与官方 CLI standalone 模式同款机制 */
function spawnTransientServer(): Promise<OpenCodeServer> {
  return new Promise((resolve, reject) => {
    const password = randomBytes(32).toString("base64url");
    let child: ChildProcess;
    try {
      child = spawn("opencode", ["serve", "--stdio", "--port", "0"], {
        env: { ...process.env, OPENCODE_PASSWORD: password },
        stdio: ["pipe", "pipe", "ignore"],
        shell: needShell,
      });
    } catch (e) {
      reject(e as Error);
      return;
    }

    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      rl.close();
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGTERM");
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error("opencode serve 启动超时")), READY_TIMEOUT_MS);
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", (line) => {
      try {
        const ready = JSON.parse(line) as { url?: string };
        if (!ready.url) throw new Error("ready 行缺少 url");
        settled = true;
        cleanup();
        child.stdout?.resume(); /* 丢弃后续输出，避免管道写满阻塞 */
        resolve({
          url: ready.url,
          password,
          close() {
            child.stdin?.end(); /* EOF → server 视为租约结束并退出 */
            const killer = setTimeout(() => child.kill("SIGTERM"), 3000);
            killer.unref();
            child.once("exit", () => clearTimeout(killer));
          },
        });
      } catch (e) {
        fail(e as Error);
      }
    });
    child.once("error", (e) => fail(e));
    child.once("exit", (code) => fail(new Error(`opencode serve 提前退出（code ${code ?? "?"}）`)));
  });
}

async function reachable(server: OpenCodeServer): Promise<boolean> {
  try {
    const res = await fetch(`${server.url}/api/credential`, {
      headers: authHeaders(server.password),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 连接官方 server：托管服务优先，否则瞬时拉起。两条路都不可用时返回 null */
export async function connectOpenCodeServer(): Promise<OpenCodeServer | null> {
  const managed = discoverManagedServer();
  if (managed) {
    if (await reachable(managed)) return managed;
  }
  try {
    return await spawnTransientServer();
  } catch {
    return null;
  }
}

/* ---------- /api/credential ---------- */

function authHeaders(password: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (password) h.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  return h;
}

async function apiJson<T>(server: OpenCodeServer, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: authHeaders(server.password),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 列出全部凭据（官方响应自带每个 integration 的 active 标记，含明文 value） */
export async function listCredentials(server: OpenCodeServer): Promise<CredentialEntry[]> {
  const json = await apiJson<{ data: CredentialEntry[] }>(server, "GET", "/api/credential");
  return json.data ?? [];
}

/**
 * 创建凭据并激活（activate 默认 true：新行置 active，同 integration 旧行停用，
 * 并广播 credential.switched 事件——与 `opencode auth login` 同一条路径）。
 * 返回新建的凭据条目。
 */
export async function createCredential(
  server: OpenCodeServer,
  integrationID: string,
  apiKey: string,
): Promise<CredentialEntry> {
  const json = await apiJson<{ data: CredentialEntry }>(server, "POST", "/api/credential", {
    integrationID,
    label: "API key",
    activate: true,
    value: { type: "key", key: apiKey },
  });
  return json.data;
}

export async function removeCredential(server: OpenCodeServer, credentialID: string): Promise<void> {
  await apiJson(server, "DELETE", `/api/credential/${encodeURIComponent(credentialID)}`);
}
