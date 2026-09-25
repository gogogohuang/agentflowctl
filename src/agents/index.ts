import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { command } from "./command.js";
import { gemini } from "./gemini.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: Record<"claude" | "codex" | "gemini" | "command", Adapter> = { claude, codex, gemini, command };
export type AdapterName = keyof typeof ADAPTERS;

/** 沒有設定時，依序偵測這些已安裝的 CLI 組成輪替順序 */
export const DEFAULT_CYCLE = ["claude", "codex", "gemini"] as const;
