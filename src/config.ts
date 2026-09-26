export const config = {
  /** 指定 Claude Code 使用的模型；未設定則用 Claude Code 預設值 */
  model: process.env.AGENTFLOWCTL_MODEL,
  /** 單一 Agent 執行最多幾輪工具迴圈，避免卡在迴圈裡 */
  maxTurns: Number(process.env.AGENTFLOWCTL_MAX_TURNS ?? 80),
  /** 同一個關卡連續失敗幾次後停止 */
  maxAttempts: Number(process.env.AGENTFLOWCTL_MAX_ATTEMPTS ?? 3),
  /** 終端機是否印出 agent 的文字、工具呼叫與專案指令；預設安靜，-v 或 AGENTFLOWCTL_VERBOSE=1 開啟 */
  verbose: process.env.AGENTFLOWCTL_VERBOSE === "1",
};
