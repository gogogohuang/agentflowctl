import { describe, expect, it } from "vitest";
import { displayWidth, padDisplay } from "./util.js";

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
