import { describe, expect, it } from "vitest";
import { displayWidth, padDisplay, failureTail } from "./util.js";

describe("顯示寬度", () => {
  it("中文與全形符號算兩格", () => {
    expect(displayWidth("Agent 執行失敗")).toBe(14);
    expect(displayWidth("（舊 run）")).toBe(10);
  });

  it("依顯示寬度補空白，超過時不截斷", () => {
    expect(padDisplay("未寫測試", 10)).toBe("未寫測試  ");
    expect(padDisplay("Agent 執行失敗", 10)).toBe("Agent 執行失敗");
  });
});

describe("failureTail", () => {
  const tap = (n: number) => [
    ...Array.from({ length: n }, (_, i) => `ok ${i + 1} - case ${i + 1}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...`),
    "not ok 99 - the broken one\n  ---\n  error: \"Cannot read properties of null (reading 'length')\"\n  ...",
    ...Array.from({ length: n }, (_, i) => `ok ${n + i + 100} - tail ${i + 1}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...`),
    "# fail 1",
  ].join("\n");

  it("夠短就原樣回傳", () => {
    expect(failureTail("ok 1 - a\n# fail 0", 4000)).toBe("ok 1 - a\n# fail 0");
  });

  it("太長時保留失敗區塊（不只尾端），並標示前略", () => {
    const out = failureTail(tap(60), 1500);
    expect(out).toContain("not ok 99 - the broken one");
    expect(out).toContain("Cannot read properties of null");
    expect(out).toContain("# fail 1");
    expect(out).toContain("前略");
    expect(out.length).toBeLessThanOrEqual(1500 + 200);
  });

  it("尾端本來就含失敗區塊時不重複", () => {
    const out = failureTail(`${"x\n".repeat(3000)}not ok 1 - last\n  ---\n  error: 'boom'\n  ...\n# fail 1`, 500);
    expect(out.match(/not ok 1 - last/g)).toHaveLength(1);
  });

  it("沒有 TAP 失敗區塊時行為同 tail", () => {
    const s = "y".repeat(5000);
    expect(failureTail(s, 100)).toBe(`…（前略）\n${s.slice(-100)}`);
  });
});
