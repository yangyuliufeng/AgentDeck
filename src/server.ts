import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.js";
import { catalogPath, displayPath } from "./paths.js";
import { targets, findTarget } from "./targets/index.js";
import type { ApplyResult } from "./types.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const MAX_BODY = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendIndex(res: ServerResponse): void {
  try {
    const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("index.html 缺失，请先运行 npm run build");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface ApplyRequestBody {
  apps?: Record<string, { enabled?: boolean; provider?: string; baseURL?: string; model?: string }>;
}

export function startServer(port: number): ReturnType<typeof createServer> {
  let shuttingDown = false;
  /** 保存成功后：等服务响应送达浏览器，然后关闭服务并退出进程 */
  function exitAfterSave(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => {
      console.log("保存完成，AgentDeck 退出");
      server.close(() => process.exit(0));
      /* close 回调可能因 keep-alive 连接挂起，兜底强制退出 */
    }, 500);
    setTimeout(() => process.exit(0), 2000).unref();
  }

  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    try {
      // 页面
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        sendIndex(res);
        return;
      }

      // 身份探针：端口被占用时，用于判断占用者是不是另一个 AgentDeck
      if (req.method === "GET" && url === "/api/health") {
        sendJson(res, 200, { app: "agent-deck", pid: process.pid });
        return;
      }

      // 状态：catalog + 三个程序的当前配置（路径以 ~ 形式展示）
      if (req.method === "GET" && url === "/api/state") {
        const { catalog, error } = loadCatalog(catalogPath());
        sendJson(res, 200, {
          catalog,
          catalogPath: displayPath(catalogPath()),
          error,
          apps: targets.map((t) => {
            const s = t.detect(catalog);
            return { ...s, paths: s.paths.map(displayPath) };
          }),
        });
        return;
      }

      // 保存：把选择写入各程序配置文件
      if (req.method === "POST" && url === "/api/apply") {
        const bodyText = await readBody(req);
        let body: ApplyRequestBody;
        try {
          body = JSON.parse(bodyText) as ApplyRequestBody;
        } catch {
          sendJson(res, 400, { error: "请求体不是合法 JSON" });
          return;
        }

        const { catalog, error } = loadCatalog(catalogPath());
        if (!catalog) {
          sendJson(res, 400, { error: `agent-deck.yaml 不可用：${error ?? ""}` });
          return;
        }

        const results: Record<string, ApplyResult> = {};
        const requested = body.apps ?? {};
        for (const [id, sel] of Object.entries(requested)) {
          const target = findTarget(id);
          if (!target) {
            results[id] = { ok: false, changedFiles: [], error: `未知程序: ${id}` };
            continue;
          }
          if (!sel?.provider || !sel.baseURL || !sel.model) {
            results[id] = { ok: false, changedFiles: [], error: "provider / baseURL / model 不能为空" };
            continue;
          }
          const selection = { provider: sel.provider, baseURL: sel.baseURL, model: sel.model };
          /* 与当前生效配置对比，无变化则不写入 */
          if (target.isCurrent(selection, catalog)) {
            results[id] = { ok: true, changedFiles: [], skipped: true };
            continue;
          }
          results[id] = target.apply(selection, catalog);
        }

        const failed = Object.values(results).some((r) => !r.ok);
        const tilde = (r: ApplyResult): ApplyResult =>
          r.ok ? { ...r, changedFiles: r.changedFiles.map(displayPath) } : r;
        const shown = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, tilde(v)]));
        sendJson(res, failed ? 500 : 200, { results: shown });
        /* 保存全部成功（或无变化）→ 响应送达后退出程序；有失败则继续运行以便重试 */
        if (!failed) exitAfterSave();
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  });

  server.listen(port, "127.0.0.1");
  return server;
}
