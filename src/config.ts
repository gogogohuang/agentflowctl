/** 重試上限的下限：低於這個值時，修正與審查來不及往返一輪 */
export const MIN_ATTEMPTS = 3;

/** 執行期旗標；沒有環境變數，設定一律來自 flow.config.json 與命令列選項 */
export const config = {
  /** 終端機是否印出 agent 的文字、工具呼叫與專案指令；預設安靜，flow.config.json 的 verbose 或 -v 開啟 */
  verbose: false,
};
