# AgentDeck

统一管理 **Cline** / **Claude Code** / **OpenCode** 的 Provider、Base URL、Model 配置。

- 读取 `~/.config/agent-deck.yaml` 作为唯一的 provider/model 台账（API key、多个 baseURL、上下文窗口、价格）
- 启动后打开一个**独立桌面窗口**（Chrome 应用模式，无地址栏无标签页，像本地 App），为三个程序分别选择 provider / baseURL / model
- 点「保存配置」后自动修改各程序的真实配置文件（修改前自动备份）

## 快速开始

```bash
./run.sh              # macOS / Linux（首次自动安装依赖）
.\run.ps1             # Windows PowerShell
```

或手动方式：

```bash
npm install
npm start        # 编译并启动，自动弹出独立窗口（需装有 Chrome/Edge/Brave，否则退回打开浏览器标签页）
```

常用参数：

```bash
node dist/index.js --port 48080   # 换端口
node dist/index.js --no-open      # 不自动打开浏览器
AGENT_DECK_PORT=48080 npm start   # 用环境变量指定端口
```

服务只监听 `127.0.0.1`，不会暴露到局域网。

## 配置台账 `~/.config/agent-deck.yaml`

`providers` 与 `models` 平级；模型名即 ID，不需要再写 `name`：

```yaml
providers:
  my-relay:                    # provider 名即 ID，无需再写 name
    api_key: "sk-xxx"       # 必填，一个 provider 一个 key
    base_urls:              # 必填，规范地址（不带 /v1），也可只写一个字符串
      - https://api.example.com
    protocol: openai-compatible  # 可选：openai-compatible(默认) / anthropic / gemini

models:
  glm-5.3:                  # 模型名即 ID，与 provider 无绑定，界面中独立选择
    context_window: 1048576    # 必填，上下文窗口（tokens）
    max_output_tokens: 131072  # 可选，最大输出
    price:                     # 必填，每百万 tokens 价格（¥）
      input: 8
      output: 28
      cache_read: 2            # 可选
```

**baseURL 自动拼接**：台账里只存规范地址（如 `https://api.example.com`）。

- 写入 **Cline / OpenCode**（openai-compatible 协议）时自动补 `/v1` → `https://api.example.com/v1`（地址已带 `/v1` 则不会重复追加）
- 写入 **Claude Code** 时原样使用 → `https://api.example.com`

字段同时兼容 snake_case / camelCase 写法（`api_key` / `apiKey` 均可）。

## 各程序写入的配置文件

| 程序 | 写入文件 | 内容 |
|---|---|---|
| Cline（桌面版） | `~/.cline/data/settings/providers.json` | `lastUsedProvider` 与对应槽位的 apiKey / model / baseUrl / contextWindow（唯一被 Cline 读取的文件；同目录的 models.json / secrets.json 是程序遗留的陈旧数据，不会同步） |
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` / 上下文与输出上限 |
| OpenCode | `~/.config/opencode/opencode.json` | 顶层 `model`（`provider/model`）与 `provider.<id>.options.baseURL`、模型 limit/cost |
| | `~/.local/share/opencode/opencode.db` | v2 的 API key 权威存储：`credential` 表（`{"type":"key","key":...}`）。**运行中的 opencode 服务会实时读取该表，改完即生效，无需重启**。`auth.json` 是 v1 遗留文件，v2 运行时不再读取，本程序也不再写它。DB 尚未初始化（全新机器）时回退为把 key 写进 opencode.json 的 `options.apiKey` |

所有写入都会：

1. 先把原文件备份为 `<文件名>.agentdeck.bak`
2. 写临时文件后原子 rename，避免写坏原文件
3. 保留文件中的其他配置（mcp、permissions、其他 provider 等）

## 界面行为

- 打开页面时读取各程序**当前生效**的配置并回显到下拉框；当前配置在台账中找不到对应时会有一行警告
- 保存时服务端把选择与各程序**当前实际配置**逐一对比（含 URL 自动补 `/v1` 后的比较）：**有变化才写入**，无变化的程序显示「无变化，未写入」，不会被触碰

## 开发

```bash
npm run build      # tsc 编译到 dist/
npm run typecheck  # 仅类型检查
```
