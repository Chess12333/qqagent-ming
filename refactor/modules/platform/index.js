// M3 platform —— 对外唯一出口（README §4：别的模块只能从 index.js 进）。
// 本模块是"搬"来的：onebot(协议接入) / sender(发送队列) / send-recovery(失败恢复) / reply-recovery(回复校验) / salvage(正文成稿判定)。
// 这里只做 re-export，不含任何新逻辑。
export * from './onebot.js';
export * from './sender.js';
export * from './send-recovery.js';
export * from './reply-recovery.js';
export * from './salvage.js';
