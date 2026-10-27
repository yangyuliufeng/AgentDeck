/** agent-deck.yaml 的数据模型 */

export interface PriceInfo {
  /** 每百万 tokens 输入价格（¥，照抄台账数字） */
  input: number;
  /** 每百万 tokens 输出价格（¥，照抄台账数字） */
  output: number;
  /** 每百万 tokens 缓存读取价格（¥，可选） */
  cacheRead?: number;
}

export interface ModelInfo {
  /** 上下文窗口（tokens） */
  contextWindow: number;
  /** 最大输出 tokens（可选） */
  maxOutputTokens?: number;
  price: PriceInfo;
}

export interface ProviderInfo {
  apiKey: string;
  /** 一个 provider 可以有多个可用 baseURL */
  baseUrls: string[];
  /** API 协议：openai-compatible / anthropic / gemini，默认 openai-compatible */
  protocol?: string;
}

export interface Catalog {
  providers: Record<string, ProviderInfo>;
  models: Record<string, ModelInfo>;
}

/** 界面上一次选择（某个目标程序要切换到的配置） */
export interface AppSelection {
  provider: string;
  baseURL: string;
  model: string;
}

/** 从目标程序配置文件中检测到的当前配置 */
export interface DetectedConfig {
  /** 检测到的 provider（agent-deck.yaml 中的 id，无法匹配时为 null） */
  provider: string | null;
  baseURL: string | null;
  model: string | null;
  apiKey: string | null;
}

export interface AppState {
  id: string;
  name: string;
  /** 涉及的配置文件路径 */
  paths: string[];
  current: DetectedConfig | null;
}

export interface ApplyResult {
  ok: boolean;
  changedFiles: string[];
  /** 当前配置已与选择一致，无需写入 */
  skipped?: boolean;
  error?: string;
}

export interface TargetApp {
  id: string;
  name: string;
  paths(): string[];
  /** 读取当前生效配置 */
  detect(catalog: Catalog | null): AppState;
  /** 当前生效配置是否已经等于该选择（相等则无需写入） */
  isCurrent(sel: AppSelection, catalog: Catalog): boolean;
  /** 将选择写入目标程序配置文件 */
  apply(sel: AppSelection, catalog: Catalog): ApplyResult;
}
