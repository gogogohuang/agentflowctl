/** 重試上限的下限：低於這個值時，修正與審查來不及往返一輪 */
export const MIN_ATTEMPTS = 3;

export const config = {
  /** 單一 Agent 執行最多幾輪工具迴圈，避免卡在迴圈裡 */
  maxTurns: Number(process.env.AGENTFLOWCTL_MAX_TURNS ?? 200),
  /** 同一個關卡連續失敗幾次後停止；環境變數低於 3 時以 3 計 */
  maxAttempts: Math.max(MIN_ATTEMPTS, Number(process.env.AGENTFLOWCTL_MAX_ATTEMPTS ?? 5) || 5),
  /** 終端機是否印出 agent 的文字、工具呼叫與專案指令；預設安靜，-v 或 AGENTFLOWCTL_VERBOSE=1 開啟 */
  verbose: process.env.AGENTFLOWCTL_VERBOSE === "1",
};
