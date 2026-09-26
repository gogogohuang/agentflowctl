import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { command } from "./command.js";
import { gemini } from "./gemini.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: Record<"claude" | "codex" | "gemini" | "command", Adapter> = { claude, codex, gemini, command };
export type AdapterName = keyof typeof ADAPTERS;
