/** URL 规范化工具 */

/**
 * openai-compatible 网关（cline / opencode）通常要求 /v1 后缀：
 * 缺失时自动补全，已有（或以 / 结尾的完整路径）则不重复追加。
 */
export function withV1(url: string): string {
  const u = url.replace(/\/+$/, "");
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}

/**
 * URL 归一化比较（忽略末尾斜杠与 /v1 差异）。
 * 台账里存规范地址（不带 /v1），程序配置文件里可能是补全后的地址，对账时需要归一化。
 */
export function urlEquals(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "").replace(/\/v1$/, "");
  return norm(a) === norm(b);
}
