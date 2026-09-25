export const config = {
  /** 指定 Claude Code 使用的模型；未設定則用 Claude Code 預設值 */
  model: process.env.AGENTFLOWCTL_MODEL,
  /** 單一 Agent 執行最多幾輪工具迴圈，避免卡在迴圈裡 */
  maxTurns: Number(process.env.AGENTFLOWCTL_MAX_TURNS ?? 80),
  /** 同一個關卡連續失敗幾次後停止 */
  maxAttempts: Number(process.env.AGENTFLOWCTL_MAX_ATTEMPTS ?? 3),
};
