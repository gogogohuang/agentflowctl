import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectProjectDefaults, NO_INSTALL, type ProjectDefaults } from "./detect.js";
import { DetectedFile } from "./schemas.js";

/** 判斷未知類型專案「有沒有變」的特徵檔：內容都納入指紋 */
const FINGERPRINT_FILES = ["Makefile", "justfile", "CMakeLists.txt", "pom.xml", "Gemfile", "composer.json", "mix.exs"];
const FINGERPRINT_PATTERNS = [/^build\.gradle/, /\.sln$/, /\.csproj$/];

const detectedFile = (root: string) => join(root, ".agentflowctl", "detected.json");

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function detectFingerprint(root: string): string {
  const names = new Set(FINGERPRINT_FILES);
  try {
    for (const f of readdirSync(root)) if (FINGERPRINT_PATTERNS.some((re) => re.test(f))) names.add(f);
  } catch {
    // 讀不到目錄就只看固定的檔名
  }
  const parts = [...names].sort().map((name) => `${name}\n${readText(join(root, name))}`);
  const workflows = join(root, ".github", "workflows");
  if (existsSync(workflows)) {
    for (const f of readdirSync(workflows).filter((f) => /\.ya?ml$/.test(f)).sort()) parts.push(`.github/workflows/${f}\n${readText(join(workflows, f))}`);
  }
  return createHash("sha1").update(parts.join("\n--\n")).digest("hex");
}

export function readDetected(root: string): DetectedFile | undefined {
  try {
    const parsed = DetectedFile.safeParse(JSON.parse(readFileSync(detectedFile(root), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 原子寫入：先寫暫存檔再改名，中斷時不會留下半份 JSON */
export function writeDetected(root: string, file: DetectedFile): void {
  const path = detectedFile(root);
  mkdirSync(join(root, ".agentflowctl"), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, path);
}

export function overlayGenerated(base: ProjectDefaults, g: DetectedFile): ProjectDefaults {
  return {
    ...base,
    ecosystem: "generated",
    manager: "動態偵測",
    source: ".agentflowctl/detected.json",
    install: g.install ?? NO_INSTALL,
    test: g.test ?? base.test,
    checks: [...(g.test ? [{ name: "test", cmd: g.test }] : []), ...g.checks],
    testFramework: g.test !== undefined,
    testPattern: g.testPattern,
  };
}

/** 內建偵測；只有未知類型且 detected.json 的指紋相符時，才疊上動態產生的結果 */
export function effectiveDefaults(root: string): ProjectDefaults {
  const base = detectProjectDefaults(root);
  if (base.ecosystem !== "unknown") return base;
  const generated = readDetected(root);
  return generated && generated.fingerprint === detectFingerprint(root) ? overlayGenerated(base, generated) : base;
}
