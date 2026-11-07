/**
 * M5 scenario · errors.js —— 本模块唯一的错误类型。
 *
 * 为什么要有单独的 `code`：阶段 A 出错时必须**一眼看出是哪一步没还原出来**
 * （时间缺失？入参不是对象？契约校验没过？），而不是一句 `Error: 出错了`。
 * 上层（第 3 批装配）按 `code` 决定"这条消息丢不丢"。
 */
export class ScenarioError extends Error {
  constructor(code, message, extra = null) {
    super(message);
    this.name = 'ScenarioError';
    this.code = code;
    if (extra) this.extra = extra;
  }
}

export const SCENARIO_ERROR_CODES = Object.freeze({
  RAW_NOT_OBJECT: 'E_RAW_NOT_OBJECT',
  NO_TIME: 'E_NO_TIME',
  CONTRACT_INVALID: 'E_CONTRACT_INVALID'
});
