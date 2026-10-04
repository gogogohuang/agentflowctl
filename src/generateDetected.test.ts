import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstExecutable, isTrivialCommand, proposalDirOk, validateProposal, type ValidateDeps } from "./generateDetected.js";

const deps = (over: Partial<ValidateDeps> & { fail?: string[] } = {}): ValidateDeps & { ran: string[] } => {
  const ran: string[] = [];
  return {
    ran,
    files: [],
    hasExecutable: () => true,
    dirOk: () => true,
    run: async (cmd) => { ran.push(cmd); return { ok: !over.fail?.includes(cmd), output: "" }; },
    ...over,
  };
};

describe("isTrivialCommand／firstExecutable", () => {
  it("空指令與永遠成功的指令視為無效", () => {
    for (const c of ["", "  ", "true", ":", "exit 0", "echo ok", "echo 'all good'"]) expect(isTrivialCommand(c)).toBe(true);
    for (const c of ["make test", "go test ./...", "true && make test"]) expect(isTrivialCommand(c)).toBe(false);
  });

  it("取第一個可執行檔，略過 VAR=值 的環境變數前綴", () => {
    expect(firstExecutable("make test")).toBe("make");
    expect(firstExecutable("CI=1 FOO=bar npm test")).toBe("npm");
    expect(firstExecutable("   ")).toBeUndefined();
  });
});

describe("validateProposal：沒有可用 testPattern 的 test", () => {
  const reason = "沒有可用的 testPattern，無法走紅綠燈；改當一般檢查執行";

  it("test 通過但沒給 testPattern：不當 test，改放進 checks 的 unit-tests", async () => {
    const out = await validateProposal({ test: "bundle exec rspec", checks: [{ name: "lint", cmd: "make lint" }] }, deps());
    expect(out.test).toBeUndefined();
    expect(out.checks).toEqual([{ name: "unit-tests", cmd: "bundle exec rspec" }, { name: "lint", cmd: "make lint" }]);
    expect(out.dropped).toEqual([{ field: "test", reason }]);
  });

  it("testPattern 被驗證丟掉時同樣降級", async () => {
    const out = await validateProposal({ test: "make test", testPattern: "([" }, deps());
    expect(out.test).toBeUndefined();
    expect(out.checks).toEqual([{ name: "unit-tests", cmd: "make test" }]);
    expect(out.dropped.map((d) => d.field)).toEqual(["testPattern", "test"]);
  });
});

describe("validateProposal 失敗輸出", () => {
  it("丟棄原因附上輸出尾巴（限制長度）", async () => {
    const output = "x".repeat(1000) + "FINAL-ERROR";
    const out = await validateProposal({ test: "make test", testPattern: "a" }, deps({ fail: ["make test"], run: async () => ({ ok: false, output }) }));
    const r = out.dropped[0].reason;
    expect(r.startsWith("在基底上沒有通過：make test")).toBe(true);
    expect(r).toContain("FINAL-ERROR");
    expect(r.length).toBeLessThan(600);
  });
});

describe("validateProposal", () => {
  it("全部通過時原樣保留，且先 install 再 test 再 checks", async () => {
    const d = deps();
    const out = await validateProposal({ install: "make deps", test: "make test", checks: [{ name: "lint", cmd: "make lint", finalOnly: true }], testPattern: "_spec\\.rb$" }, d);
    expect(out).toEqual({ install: "make deps", test: "make test", checks: [{ name: "lint", cmd: "make lint", finalOnly: true }], testPattern: "_spec\\.rb$", dropped: [], profileExtras: {} });
    expect(d.ran).toEqual(["make deps", "make test", "make lint"]);
  });

  it("test 在基底上沒通過就丟掉（視為沒有測試框架），其餘欄位不受影響", async () => {
    const out = await validateProposal({ install: "make deps", test: "make test", checks: [{ name: "build", cmd: "make build" }] }, deps({ fail: ["make test"] }));
    expect(out.test).toBeUndefined();
    expect(out.install).toBe("make deps");
    expect(out.checks).toEqual([{ name: "build", cmd: "make build" }]);
    expect(out.dropped).toEqual([{ field: "test", reason: "在基底上沒有通過：make test" }]);
  });

  it("只丟掉壞的那一項 check", async () => {
    const out = await validateProposal({ checks: [{ name: "a", cmd: "make a" }, { name: "b", cmd: "make b" }] }, deps({ fail: ["make a"] }));
    expect(out.checks).toEqual([{ name: "b", cmd: "make b" }]);
    expect(out.dropped.map((x) => x.field)).toEqual(["checks.a"]);
  });

  it("空指令與不存在的可執行檔不會被執行就丟掉", async () => {
    const d = deps({ hasExecutable: (bin) => bin !== "nope" });
    const out = await validateProposal({ install: "true", test: "nope test", checks: [{ name: "x", cmd: "echo hi" }] }, d);
    expect(d.ran).toEqual([]);
    expect(out.install).toBeUndefined();
    expect(out.test).toBeUndefined();
    expect(out.checks).toEqual([]);
    expect(out.dropped.map((x) => x.field)).toEqual(["install", "test", "checks.x"]);
  });

  it("install 沒通過仍會嘗試 test（有些專案不需要安裝）", async () => {
    const d = deps({ fail: ["make deps"] });
    const out = await validateProposal({ install: "make deps", test: "make test", testPattern: "_spec\\.rb$" }, d);
    expect(out.install).toBeUndefined();
    expect(out.test).toBe("make test");
    expect(d.ran).toEqual(["make deps", "make test"]);
  });

  it("testPattern：無法編譯、或專案有測試檔卻一個都沒命中時丟掉", async () => {
    const bad = await validateProposal({ testPattern: "([" }, deps());
    expect(bad.testPattern).toBeUndefined();
    expect(bad.dropped[0]?.field).toBe("testPattern");
    const miss = await validateProposal({ testPattern: "_spec\\.rb$" }, deps({ files: ["test/a_test.rb", "src/a.rb"] }));
    expect(miss.testPattern).toBeUndefined();
    const hit = await validateProposal({ testPattern: "_test\\.rb$" }, deps({ files: ["test/a_test.rb"] }));
    expect(hit.testPattern).toBe("_test\\.rb$");
    const none = await validateProposal({ testPattern: "_spec\\.rb$" }, deps({ files: ["src/a.rb"] }));
    expect(none.testPattern).toBe("_spec\\.rb$");
  });
});

describe("validateProposal：profile 欄位", () => {
  it("範例比對不到的正規表示式、不存在的目錄會被丟掉", async () => {
    const v = await validateProposal(
      { checks: [], skipPatterns: [{ pattern: "@slow\\b", example: "@slow" }, { pattern: "@fast\\b", example: "@slow" }], assertPattern: { pattern: "(", example: "x" },
        depDirs: [".venv", "nope"], failureFormat: "pytest" },
      deps({ dirOk: (d) => d === ".venv" }),
    );
    expect(v.profileExtras.skipPatterns).toEqual(["@slow\\b"]);
    expect(v.profileExtras.assertPattern).toBeUndefined();
    expect(v.profileExtras.depDirs).toEqual([".venv"]);
    expect(v.profileExtras.failureFormat).toBe("pytest");
    expect(v.dropped.map((d) => d.field).sort()).toEqual(["assertPattern", "depDirs", "skipPatterns"]);
  });
});

describe("validateProposal：目錄名稱限制", () => {
  it("depDirs 擋掉空字串、.、..、路徑、-開頭、已追蹤的目錄，並逐項記錄原因", async () => {
    const bad = ["", ".", "..", "../x", "-v", "a/b", "src"];
    const v = await validateProposal({ checks: [], depDirs: [...bad, ".venv", "node_modules"] }, deps({ files: ["src/a.ts"], dirOk: () => true }));
    expect(v.profileExtras.depDirs).toEqual([".venv", "node_modules"]);
    expect(v.dropped.filter((d) => d.field === "depDirs")).toHaveLength(bad.length);
  });

  it("skipDirs 同樣擋不安全的名稱，但允許已追蹤的目錄", async () => {
    const v = await validateProposal({ checks: [], skipDirs: ["..", "a/b", "src", "vendor"] }, deps({ files: ["src/a.ts"], dirOk: () => true }));
    expect(v.profileExtras.skipDirs).toEqual(["src", "vendor"]);
    expect(v.dropped).toHaveLength(2);
  });
});

describe("proposalDirOk", () => {
  const repo = mkdtempSync(join(tmpdir(), "agentflowctl-dirok-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), "ignored-thing\n");
  mkdirSync(join(repo, ".venv"));
  writeFileSync(join(repo, "package.json"), "{}");

  it("目錄與被忽略的路徑通過；plain file、不安全名稱、像選項的值回傳 false 而不丟例外", () => {
    expect(proposalDirOk(repo, ".venv", "skipDirs")).toBe(true);
    expect(proposalDirOk(repo, "ignored-thing", "skipDirs")).toBe(true);
    for (const d of ["package.json", "nope", "", "..", "-v", "--stdin"]) expect(proposalDirOk(repo, d, "skipDirs"), d).toBe(false);
  });
});

describe("proposalDirOk：依賴目錄", () => {
  const repo = mkdtempSync(join(tmpdir(), "agentflowctl-depdir-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), ".env\nnot-yet\n.venv\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  mkdirSync(join(repo, ".venv"));
  mkdirSync(join(repo, ".flow"));
  mkdirSync(join(repo, ".agentflowctl"));

  it("依賴目錄必須是已存在的真目錄：被忽略的一般檔案（.env）與還不存在的被忽略名稱都不算", () => {
    expect(proposalDirOk(repo, ".venv", "depDirs")).toBe(true);
    expect(proposalDirOk(repo, ".env", "depDirs")).toBe(false);
    expect(proposalDirOk(repo, "not-yet", "depDirs")).toBe(false);
  });

  it("引擎自己的目錄（.git、.flow、.agentflowctl…）不能當依賴目錄，即使它們真的是目錄", () => {
    for (const d of [".git", ".flow", ".agentflowctl", ".FLOW", ".worktree", ".worktrees", "tmp-review"]) expect(proposalDirOk(repo, d, "depDirs"), d).toBe(false);
  });

  it("skipDirs 仍接受被忽略但不存在的名稱", () => {
    expect(proposalDirOk(repo, "not-yet", "skipDirs")).toBe(true);
  });
});

describe("validateProposal：依賴目錄的保留名稱", () => {
  it(".flow、.agentflowctl、.git 即使 dirOk 為真也被丟掉並記錄原因", async () => {
    const v = await validateProposal({ checks: [], depDirs: [".flow", ".agentflowctl", ".git", ".venv"] }, deps({ dirOk: () => true }));
    expect(v.profileExtras.depDirs).toEqual([".venv"]);
    expect(v.dropped.filter((d) => d.field === "depDirs")).toHaveLength(3);
  });
});

describe("validateProposal：有回溯風險的規則", () => {
  it("巢狀量詞、反向參照、具名群組、太長的規則即使範例比對得到也被丟掉並附原因", async () => {
    const pats = [
      { pattern: "(a+)+$", example: "aaa" },
      { pattern: "(a*)*", example: "aaa" },
      { pattern: "(a)\\1", example: "aa" },
      { pattern: "(?<n>skip)", example: "skip" },
      { pattern: "a".repeat(400), example: "a".repeat(400) },
    ];
    const v = await validateProposal({ checks: [], skipPatterns: pats, failureLine: { pattern: "(x+)+y", example: "xxy" } }, deps());
    expect(v.profileExtras.skipPatterns).toBeUndefined();
    expect(v.profileExtras.failureLine).toBeUndefined();
    const reasons = v.dropped.filter((d) => d.field === "skipPatterns" || d.field === "failureLine");
    expect(reasons).toHaveLength(6);
    for (const d of reasons) expect(d.reason).toMatch(/不安全/);
  });
});
