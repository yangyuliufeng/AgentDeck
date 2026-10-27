import type { TargetApp } from "../types.js";
import { clineTarget } from "./cline.js";
import { claudeCodeTarget } from "./claude-code.js";
import { opencodeTarget } from "./opencode.js";

export const targets: TargetApp[] = [clineTarget, claudeCodeTarget, opencodeTarget];

export function findTarget(id: string): TargetApp | undefined {
  return targets.find((t) => t.id === id);
}
