// 主流模型官方价格表（用于成本核算）。
//
// 单位统一为：**元 / 每百万 token**（人民币）。
// 美元价格按 1 USD ≈ 7.2 CNY 换算。
//
// 数据核对时间：2026-09-03（联网检索各厂商官方定价页与实时价格聚合站）
//   · DeepSeek 段 **2026-10-17 重核**（官方现行模型名/价格/峰谷规则，见该段头注释）。
//   · 其它厂商仍是 2026-09-03 口径（本轮未动；价格会变，用时以官方页为准）。
//
// 字段：
//   in      输入（未命中缓存）
//   out     输出
//   cached  输入且命中前缀缓存（多数厂商比 in 便宜很多；无缓存优惠的填 null）
//   created 显式缓存创建单价（**只有官方明确给出时才填**；未填 = 没有创建费，
//           创建 token 按普通输入价计。旧实现"未单列时按 in×1.25"是百炼显式缓存的规则，
//           2026-10-17 起不再套给其它厂商——DeepSeek 没有单独的缓存创建费）
//   peak    高峰时段价格（目前仅 DeepSeek 有；时段判定见 isPeakHour）
//   image   图片计费规则（maxTokensPerImage 等；仅视觉模型有）
//   note    备注（口径/促销/阶梯说明）
//
// ── 来源分级（见每条的 src 字段）──
//   'official' = 从厂商官方定价文档 / 价格页直接取到；人民币原价照录，未做汇率换算
//   'derived'  = 官方页面未能直连（Cloudflare 拦截 / 地区限制），
//                依据官方公告与可信转载折算，美元价按 1 USD ≈ 7.2 CNY 换算。
//                这类仅供粗略参考，实际请以厂商官网为准。
//
// ⚠️ 大模型价格变动极快，且促销价、峰谷价、长短上下文价差异很大。
//    走中转站时实际单价通常与官方不同 —— 此时请关闭「使用官方价格」并手填单价。
//
// 匹配方式见 resolveOfficialPrice()：精确 → 去 provider 前缀 → 前缀匹配。

export const OFFICIAL_PRICES = {
  // ══ DeepSeek ══
  // 来源：DeepSeek 官方「模型 & 价格」https://api-docs.deepseek.com/zh-cn/quick_start/pricing
  //   **2026-10-17 现取**（页面未标最后更新日期；以下按当日原文）。
  //   官方现名：`deepseek-flash`（模型版本 DeepSeek-V4.1-Flash）、`deepseek-v4-pro`（DeepSeek-V4-Pro-0813，id 仍为 deepseek-v4-pro）。
  //   旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 官方注明**仍可调用**，
  //   由 V4.1-Flash 服务并按 Flash 价格计费。
  //   币种：人民币；单位：元 / 百万 tokens。下表 in/out/cached 取**空闲时段**价，
  //   peak 为高峰价（官方：空闲价 = 高峰价的一半）。
  //   峰谷：北京时间**周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00** 为高峰；
  //   其余时段（含周末及法定节假日全天）为空闲。节假日日历只收录官方公布为凭的年份
  //   （2026 已内置 gov.cn 国办发明电〔2025〕7号，见 PEAK_HOLIDAYS）；日历未公布的年份
  //   仍按"工作日窗口"估算：节假日会被当成高峰，属**偏高**估算（见该函数注释）。
  'deepseek-flash': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '官方现名（V4.1-Flash）；空闲价，高峰翻倍', src: 'official' },
  'deepseek-v4-flash': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '旧模型名（2026-10-17 官方仍可调用，按 Flash 价计费）', src: 'official' },
  // 视觉版：旧名，现由 V4.1-Flash 服务、按 Flash 价计费；图片 token 规则来自旧视觉文档
  // （官方现页未复述）：自动缩放到约 800×800，单张封顶 384 token。
  'deepseek-v4-flash-vision-exp': {
    in: 1, out: 4, cached: 0.02,
    peak: { in: 2, out: 8, cached: 0.04 },
    image: {
      mode: 'capped',
      maxTokensPerImage: 384,
      note: '旧视觉文档口径：自动缩放到约 800×800 后按 384 token/张 封顶；与原始尺寸无关'
    },
    note: '旧视觉模型名（现由 V4.1-Flash 服务、按 Flash 价计费）；图片 token 规则按旧文档',
    src: 'official'
  },
  'deepseek-v4-flash-0731': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '旧快照名；官方现页未列出（2026-10-17），按 Flash 现价近似', src: 'derived' },
  // 版本号写法：网关/前端有时返回 DeepSeek-V4.1-Flash / deepseek-v4.1-flash / deepseek-v4-1-flash。
  // 官方**请求名**是 `deepseek-flash`；这些是别名（不是官方模型 id）⇒ 标 derived。
  'deepseek-v4.1-flash': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '别名（版本号写法）；对应 V4.1-Flash，按 Flash 现价', src: 'derived' },
  'deepseek-v4-1-flash': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '别名（连字符写法）；对应 V4.1-Flash，按 Flash 现价', src: 'derived' },
  'deepseek-v4-pro': { in: 4.5, out: 13.5, cached: 0.15, peak: { in: 9, out: 27, cached: 0.30 }, note: '官方现价（V4-Pro）；空闲价，高峰翻倍', src: 'official' },
  'deepseek-v4-pro-0813': { in: 4.5, out: 13.5, cached: 0.15, peak: { in: 9, out: 27, cached: 0.30 }, note: '版本号写法（V4-Pro-0813）；按 V4-Pro 现价', src: 'derived' },
  // 旧别名：官方现页（2026-10-17）未列出，是否仍可调用、是否走峰谷**未确认**。
  // 按对应档位近似并保留峰谷档（仅当它确实路由到 V4.1-Flash/V4-Pro 时成立）⇒ src=derived，展示须标"近似"。
  'deepseek-chat': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '旧别名（官方现页未列出）；按 V4.1-Flash 现价近似，含峰谷', src: 'derived' },
  'deepseek-reasoner': { in: 4.5, out: 13.5, cached: 0.15, peak: { in: 9, out: 27, cached: 0.30 }, note: '旧别名（官方现页未列出）；按 V4-Pro 现价近似，含峰谷', src: 'derived' },
  'deepseek-v3.1-terminus': { in: 1.5, out: 4.5, cached: 0.05, note: '旧代；官方现页未列出，按旧表近似（峰谷未确认，未套用）', src: 'derived' },
  'deepseek-r1-0528': { in: 4.5, out: 13.5, cached: 0.15, note: '旧代；官方现页未列出，按旧表近似（峰谷未确认，未套用）', src: 'derived' },

  // ══ 智谱 Z.ai / GLM ══
  // 来源：智谱官方价格页 https://open.bigmodel.cn/pricing（2026-09-03 直取），人民币原价。
  // 缓存存储限时免费；带阶梯的取最低档（≤32K 输入）。
  'glm-5.3': { in: 8, out: 28, cached: 2, note: '1M 上下文；缓存存储限时免费', src: 'official' },
  // 促销价（用户实测确认 2026-09-05）：输入 0.4 / 输出 1.4 / 缓存 0.115
  // 原价 0.8/1.4/0.23 —— 输入与缓存五折，输出不打折。
  'glm-5.3-flash': { in: 0.4, out: 1.4, cached: 0.115, note: '促销价；原价 0.8/1.4/0.23（输入与缓存五折，输出不打折）', src: 'official' },
  'glm-5.2': { in: 8, out: 28, cached: 2, note: '1M 上下文', src: 'official' },
  'glm-5.1': { in: 6, out: 24, cached: 1.3, note: '≤32K 档；>32K 为 8/28/2', src: 'official' },
  'glm-5-turbo': { in: 5, out: 22, cached: 1.2, note: '≤32K 档；>32K 为 7/26/1.8', src: 'official' },
  'glm-5': { in: 4, out: 18, cached: 1, note: '≤32K 档；>32K 为 6/22/1.5', src: 'official' },
  'glm-5v-turbo': { in: 5, out: 22, cached: 1.2, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '多模态；>32K 为 7/26/1.8', src: 'official' },
  'glm-4.7': { in: 2, out: 8, cached: 0.4, note: '≤32K 且输出<0.2K；其余档更高', src: 'official' },
  'glm-4.7-flash': { in: 0, out: 0, cached: 0, note: '官方免费', src: 'official' },
  'glm-4.7-flashx': { in: 0.5, out: 3, cached: 0.1, note: '200K 上下文', src: 'official' },
  'glm-4.6': { in: 4, out: 16, cached: 0.8, note: '按 4.7 同档近似', src: 'official' },
  'glm-4.5': { in: 4, out: 16, cached: 0.8, note: '按 4.7 同档近似', src: 'official' },
  'glm-4.5-air': { in: 0.8, out: 2, cached: 0.16, note: '≤32K 且输出<0.2K', src: 'official' },
  'glm-4.6v': { in: 1, out: 3, cached: 0.2, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤32K；32-128K 为 2/6/0.4', src: 'official' },
  'glm-4.6v-flashx': { in: 0.15, out: 1.5, cached: 0.03, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤32K', src: 'official' },
  'glm-4.5v': { in: 2, out: 6, cached: 0.4, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤32K；32-64K 为 4/12/0.8', src: 'official' },
  'glm-4-plus': { in: 5, out: 5, cached: null, note: '旧代 GLM-4 系列', src: 'official' },
  'glm-4-long': { in: 1, out: 1, cached: null, note: '旧代，1M 上下文', src: 'official' },
  'glm-4-flash': { in: 0, out: 0, cached: 0, note: '官方免费', src: 'official' },

  // ══ 月之暗面 Kimi / Moonshot ══
  // 来源：月之暗面开放平台公示标准（多来源交叉验证：腾讯云开发者社区对照表、行业报道均一致）。
  // K3 定价偏高：缓存未命中 20 / 输出 100；但官方称编程场景缓存命中率>90%，命中价仅 2。
  'kimi-k3': { in: 20, out: 100, cached: 2, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '缓存命中率>90% 时实际成本低得多', src: 'derived' },
  'kimi-k2.7-code': { in: 20, out: 100, cached: 2, note: '编程版，按 K3 档近似', src: 'derived' },
  'kimi-k2.6': { in: 8, out: 32, cached: 1, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代，按美元价折算', src: 'derived' },
  'kimi-k2': { in: 4.32, out: 14.4, cached: 0.5, note: '旧代', src: 'derived' },

  // ══ MiniMax ══
  // 来源：MiniMax 官方文档 https://platform.minimaxi.com/docs/guides/pricing-paygo（2026-09-03 直取），人民币原价。
  // M3 标注"永久五折"，下表为折后价；>512K 输入翻倍。优先服务（service_tier=priority）按标准价 1.5 倍计。
  'minimax-m3': { in: 2.1, out: 8.4, cached: 0.42, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤512K 五折价；>512K 为 4.2/16.8/0.84', src: 'official' },
  'minimax-m2.7': { in: 2.1, out: 8.4, cached: 0.42, note: '缓存写入 2.625', src: 'official' },
  'minimax-m2.7-highspeed': { in: 4.2, out: 16.8, cached: 0.42, note: '高速版，缓存写入 2.625', src: 'official' },
  'minimax-m2.5': { in: 2.1, out: 8.4, cached: 0.21, note: '缓存写入 2.625', src: 'official' },
  'minimax-m2.5-highspeed': { in: 4.2, out: 16.8, cached: 0.21, note: '高速版', src: 'official' },
  'minimax-m2.1': { in: 2.1, out: 8.4, cached: 0.21, note: '缓存写入 2.625', src: 'official' },
  'minimax-m2.1-highspeed': { in: 4.2, out: 16.8, cached: 0.21, note: '高速版', src: 'official' },
  'minimax-m2': { in: 2.1, out: 8.4, cached: 0.21, note: '缓存写入 2.625', src: 'official' },
  'minimax-m1': { in: 2.1, out: 8.4, cached: 0.21, note: '旧代，按现价近似', src: 'official' },

  // ══ 小米 MiMo ══
  // 来源：小米官方定价（对标高通 DeepSeek 同档）+ 带真实账单的公开对照表交叉验证。
  // 注意：缓存命中价极低（0.02~0.075），是编码场景省钱关键；UltraSpeed 为 Pro 版 3 倍价。
  'mimo-v2.5': { in: 1.0, out: 2.0, cached: 0.02, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '对标 DeepSeek V4-Flash 同档', src: 'derived' },
  'mimo-v2.5-pro': { in: 3.0, out: 6.0, cached: 0.025, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '对标 DeepSeek V4-Pro 同档', src: 'derived' },
  'mimo-v2.5-pro-ultraspeed': { in: 9.0, out: 18.0, cached: 0.075, note: '极速版，为 Pro 版 3 倍价', src: 'derived' },
  'mimo-v2.5-flash': { in: 0.72, out: 2.16, cached: null, note: '轻量档，按美元价折算（$0.10/$0.30）', src: 'derived' },

  // ══ 阿里通义千问 ══
  // 官方人民币刊例价（华北2/北京，≤128K 档）已直取到文档页，标 official：
  //   qwen3.8-flash 0.8/2.7（缓存 0.1）  https://developer.aliyun.com/article/1761526
  //   qwen-flash    0.15/1.5（缓存 0.03） https://help.aliyun.com/zh/model-studio/qwen-flash
  //   qwen3-vl-flash 0.15/1.5（缓存 0.03）https://help.aliyun.com/zh/model-studio/qwen3-vl-flash
  //   qwen3.5-flash 0.2/2、qwen3.6-flash 1.2/7.2（人民币价表）
  // 其余仍为美元公开报价按 7.2 折算（derived）；实际价以百炼控制台为准。
  'qwen3.8-max': { in: 14.4, out: 43.2, cached: 3.6, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文；旗舰档', src: 'derived' },
  'qwen3.8-max-0902': { in: 14.4, out: 43.2, cached: 3.6, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文', src: 'derived' },
  'qwen3.8-flash': { in: 0.8, out: 2.7, cached: 0.1, created: 1.25, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文；显式缓存创建 1.25（官方价，华北2 ≤128K）', src: 'official' },
  'qwen3.7-max': { in: 9, out: 27, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '按 $1.25/$3.75 折算', src: 'derived' },
  'qwen3.7-plus': { in: 2.3, out: 9, cached: 0.23, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文；均衡主力（$0.32/$1.25）', src: 'derived' },
  'qwen3.7-plus-2026-05-26': { in: 2.3, out: 9, cached: 0.23, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '快照版', src: 'derived' },
  'qwen3.7-flash': { in: 0.2, out: 0.78, cached: 0.043, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文；官方价 0.028/0.11 USD（华北2 ≤32k，按 7.1 折算）；隐式缓存 0.006 USD、显式缓存读 0.003 USD；默认思考可关', src: 'official' },
  'qwen3.6-flash': { in: 1.2, out: 7.2, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '官方价（华北2 ≤256K）；默认思考', src: 'official' },
  'qwen3.5-flash': { in: 0.2, out: 2, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '官方价（华北2 ≤128K）；默认思考', src: 'official' },
  'qwen3-vl-flash': { in: 0.15, out: 1.5, cached: 0.03, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '视觉理解小尺寸（官方价，华北2 ≤32K）；默认非思考、支持工具调用', src: 'official' },
  'qwen3.5-plus': { in: 2.88, out: 12.96, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'qwen3.5-397b-a17b': { in: 4.32, out: 25.92, cached: null, note: '开源大尺寸', src: 'derived' },
  'qwen3-235b-a22b': { in: 1.44, out: 5.76, cached: null, note: '开源', src: 'derived' },
  'qwen3-235b-a22b-thinking-2507': { in: 2.16, out: 21.6, cached: null, note: '思考版', src: 'derived' },
  'qwen3-coder-plus': { in: 4, out: 20, cached: null, note: '编程版，≤32K 档', src: 'derived' },
  'qwen-plus': { in: 5.76, out: 14.4, cached: null, note: '旧代', src: 'derived' },
  'qwen-max': { in: 14.4, out: 43.2, cached: null, note: '映射到 3.8-Max 档', src: 'derived' },
  'qwen-flash': { in: 0.15, out: 1.5, cached: 0.03, note: '官方价（华北2 ≤128K）；纯文本，不支持图片输入', src: 'official' },
  'qwen-turbo': { in: 2.16, out: 4.32, cached: null, note: '旧代', src: 'derived' },
  'qwen-long': { in: 3.6, out: 14.4, cached: null, note: '10M 上下文', src: 'derived' },

  // ══ 腾讯混元 ══
  // 来源：腾讯云官方文档 https://cloud.tencent.com/document/product/1729/97731（2026-06-26 更新），人民币刊例价。
  'hunyuan-a13b': { in: 0.5, out: 2, cached: null, note: '腾讯云刊例价', src: 'official' },
  'hunyuan-role-latest': { in: 2.4, out: 9.6, cached: null, note: '腾讯云刊例价', src: 'official' },
  'hunyuan-translation': { in: 1.2, out: 3.6, cached: null, note: '翻译模型', src: 'official' },
  'hunyuan-translation-lite': { in: 1, out: 3, cached: null, note: '翻译轻量版', src: 'official' },
  'hunyuan-embedding': { in: 0.7, out: 0.7, cached: null, note: '向量模型', src: 'official' },
  // Hy 系列：腾讯云开发者社区对照表（广州地域在线推理按量价，2026 年）
  'hy4-preview': { in: 6, out: 18, cached: 0.3, note: '960K 输入 / 64K 输出', src: 'derived' },
  'hy3': { in: 1.15, out: 4.6, cached: 0.29, note: '262K 上下文，按美元价折算（$0.16/$0.64）', src: 'derived' },
  'hunyuan': { in: 0.5, out: 2, cached: null, note: '映射到 a13b 档（腾讯云官方刊例）', src: 'official' },

  // ══ 字节豆包 ══
  'doubao-pro': { in: 3.2, out: 7.2, cached: null, note: '旗舰档', src: 'derived' },
  'doubao-lite': { in: 0.54, out: 1.44, cached: null, note: '轻量档', src: 'derived' },

  // ══ 百度文心 ══
  'ernie-5.0': { in: 8.64, out: 25.92, cached: null, note: '旗舰档', src: 'derived' },
  'ernie-4.5': { in: 2.88, out: 8.64, cached: null, note: '旧代', src: 'derived' },

  // ══ OpenAI GPT-5.6 系列 ══
  // 促销价（至少持续到 2026-11-21）：短上下文 / 长上下文(>272K) 双档
  'gpt-5.6-sol': { in: 28.8, out: 144, cached: 2.88, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价；长上下文 57.6/216', src: 'derived' },
  'gpt-5.6-terra': { in: 14.4, out: 86.4, cached: 1.44, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价；长上下文 28.8/129.6', src: 'derived' },
  'gpt-5.6-luna': { in: 1.44, out: 8.64, cached: 0.14, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价；长上下文 2.88/12.96', src: 'derived' },
  'gpt-5.6-cyber': { in: 90, out: 540, cached: 9, note: 'Daybreak 计划', src: 'derived' },
  'gpt-5.5': { in: 36, out: 216, cached: 3.6, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代旗舰', src: 'derived' },
  'gpt-5.5-pro': { in: 216, out: 1296, cached: null, note: 'Pro 档', src: 'derived' },
  'gpt-5.4': { in: 18, out: 108, cached: 1.8, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-5.4-mini': { in: 5.4, out: 32.4, cached: 0.54, note: '旧代', src: 'derived' },
  'gpt-5.4-nano': { in: 1.44, out: 9, cached: 0.14, note: '旧代', src: 'derived' },
  'gpt-5.2': { in: 12.6, out: 100.8, cached: null, note: '旧代', src: 'derived' },
  'gpt-5.1': { in: 9, out: 72, cached: null, note: '旧代', src: 'derived' },
  'gpt-5': { in: 9, out: 72, cached: null, note: '旧代', src: 'derived' },
  'gpt-5-mini': { in: 1.8, out: 14.4, cached: null, note: '旧代', src: 'derived' },
  'gpt-5-nano': { in: 0.36, out: 2.88, cached: null, note: '旧代', src: 'derived' },
  'gpt-4.1': { in: 14.4, out: 57.6, cached: 2.88, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-4.1-mini': { in: 2.88, out: 11.52, cached: 0.58, note: '旧代', src: 'derived' },
  'gpt-4.1-nano': { in: 0.72, out: 2.88, cached: 0.14, note: '旧代', src: 'derived' },
  'gpt-4o': { in: 18, out: 72, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-4o-mini': { in: 1.08, out: 4.32, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-oss-120b': { in: 0.22, out: 1.22, cached: null, note: '开源权重', src: 'derived' },
  'gpt-oss-20b': { in: 0.14, out: 0.72, cached: null, note: '开源权重', src: 'derived' },

  // ══ Anthropic Claude ══
  'claude-fable-5.1': { in: 72, out: 360, cached: 1.8, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '缓存读已降 75%', src: 'derived' },
  'claude-mythos-5.1': { in: 72, out: 360, cached: 1.8, note: '受限供应', src: 'derived' },
  'claude-fable-5': { in: 72, out: 360, cached: 7.2, note: '旧版缓存贵 4 倍', src: 'derived' },
  'claude-mythos-5': { in: 72, out: 360, cached: 7.2, note: '受限供应', src: 'derived' },
  'claude-opus-5': { in: 36, out: 180, cached: 3.6, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '1M 上下文，无长上下文档附加费', src: 'derived' },
  'claude-opus-4.8': { in: 36, out: 180, cached: 3.6, note: '旧代旗舰', src: 'derived' },
  'claude-opus-4.7': { in: 36, out: 180, cached: 3.6, note: '旧代', src: 'derived' },
  'claude-opus-4.6': { in: 36, out: 180, cached: 3.6, note: '旧代', src: 'derived' },
  'claude-opus-4.5': { in: 36, out: 180, cached: 3.6, note: '旧代', src: 'derived' },
  'claude-opus-4.1': { in: 108, out: 540, cached: null, note: '已退役', src: 'derived' },
  'claude-sonnet-5': { in: 14.4, out: 72, cached: 1.44, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价已转正', src: 'derived' },
  'claude-sonnet-4.6': { in: 21.6, out: 108, cached: 2.16, note: '旧代', src: 'derived' },
  'claude-haiku-4.5': { in: 7.2, out: 36, cached: 0.72, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '最便宜', src: 'derived' },
  'claude-haiku-4.5-batch': { in: 3.6, out: 18, cached: 0.36, note: 'Batch 五折', src: 'derived' },

  // ══ Google Gemini ══
  // 3.6/3.7/3.8 Flash 三档同价，属促销价，2027-01-01 起翻倍
  'gemini-3.8-flash': { in: 5.4, out: 27, cached: 0.54, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价至 2026-12-31', src: 'derived' },
  'gemini-3.7-flash': { in: 5.4, out: 27, cached: 0.54, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价至 2026-12-31', src: 'derived' },
  'gemini-3.6-flash': { in: 5.4, out: 27, cached: 0.54, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价至 2026-12-31', src: 'derived' },
  'gemini-3.5-flash': { in: 10.8, out: 64.8, cached: 1.08, note: '原价档', src: 'derived' },
  'gemini-3.5-flash-lite': { in: 2.16, out: 18, cached: 0.22, note: '轻量档', src: 'derived' },
  'gemini-3.1-pro': { in: 14.4, out: 86.4, cached: 1.44, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤200K；>200K 翻倍', src: 'derived' },
  'gemini-3.1-flash-lite': { in: 1.8, out: 10.8, cached: 0.18, note: '预览', src: 'derived' },
  'gemini-3-flash': { in: 3.6, out: 21.6, cached: 0.36, note: '预览', src: 'derived' },
  'gemini-2.5-pro': { in: 9, out: 72, cached: 0.9, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gemini-2.5-flash': { in: 2.16, out: 18, cached: 0.22, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gemini-2.5-flash-lite': { in: 0.72, out: 2.88, cached: 0.07, note: '旧代', src: 'derived' },

  // ══ xAI Grok ══
  'grok-4.6': { in: 14.4, out: 43.2, cached: 3.6, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≥200K 输入翻倍', src: 'derived' },
  'grok-4.5': { in: 21.6, out: 64.8, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'grok-4': { in: 21.6, out: 64.8, cached: null, note: '旧代', src: 'derived' },

  // ══ Meta ══
  'muse-spark-1.3': { in: 9, out: 30.6, cached: null, note: 'Contributor 档 0.72/1.44', src: 'derived' },
  'muse-spark-1.2': { in: 9, out: 30.6, cached: null, note: 'Contributor 档 0.72/1.44', src: 'derived' },
  'muse-spark-1.1': { in: 9, out: 30.6, cached: null, note: '旧代', src: 'derived' },
  'llama-4-maverick': { in: 1.44, out: 5.01, cached: null, note: '开源权重', src: 'derived' },
  'llama-3.3-70b': { in: 1.44, out: 1.44, cached: null, note: '开源权重', src: 'derived' },

  // ══ 其他海外 ══
  'mistral-large-3': { in: 3.6, out: 10.8, cached: null, note: '', src: 'derived' },
  'mistral-medium-3.5': { in: 10.8, out: 54, cached: null, note: '', src: 'derived' },
  'command-a': { in: 18, out: 72, cached: null, note: 'Cohere', src: 'derived' },
  'nemotron-3-ultra': { in: 4.32, out: 25.92, cached: null, note: 'NVIDIA', src: 'derived' },
  'nemotron-3.5-lightning': { in: 0, out: 0, cached: null, note: '免费额度', src: 'derived' },
  'solar-pro-4': { in: 0.22, out: 0.86, cached: 0.043, note: 'Upstage', src: 'derived' },
  'step-3.7-flash': { in: 1.15, out: 6.62, cached: null, note: '阶跃星辰', src: 'derived' },
  'longcat-2.0': { in: 2.16, out: 8.64, cached: null, note: '美团；促销 0.3/1.2', src: 'derived' },
  'ling-3.0-flash': { in: 0.15, out: 0.45, cached: 0.029, note: 'InclusionAI', src: 'derived' },
  'granite-4.0-h-micro': { in: 0.12, out: 0.81, cached: null, note: 'IBM；最便宜付费档', src: 'derived' }
};

/**
 * 按模型 id 查官方价格。
 * 匹配顺序：精确 → 去 provider 前缀再精确 → 前缀匹配。
 * 查不到返回 null（此时应由用户手动填单价）。
 *
 * 保守归一化兜底：上述路径全部落空（即原本会返回 null）后，把 `_` 归一为 `-`
 * 再整条重试一遍。归一化只会为「原本落 null」的 id 增加命中（如中转站返回的
 * qwen_flash ↔ 表键 qwen-flash），原本能命中的 id 在归一化之前就已返回，行为逐字不变。
 */
export function resolveOfficialPrice(modelId) {
  const raw = String(modelId ?? '').trim().toLowerCase();
  if (!raw) return null;

  const lookup = (id) => {
    const table = EFFECTIVE_PRICES;
    if (table[id]) return { ...table[id], matched: id };

    // 去掉 provider 前缀：openai/gpt-5.6-luna → gpt-5.6-luna。
    // 多级前缀（嵌套网关，如 accounts/fireworks/models/deepseek-v4-flash、
    // openrouter/deepseek/deepseek-chat）必须取**最后一段**，与 matchPriceTable
    // 及前端镜像同口径 —— 否则前缀匹配要求表键从 id 开头，这类 id 永远
    // 漏匹配，估算成本恒为 0（source=unmatched 且只读）。
    const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
    if (bare && bare !== id && table[bare]) return { ...table[bare], matched: bare };

    // 前缀匹配：z-ai/glm-5.3 → glm-5.3（取最长匹配，避免 glm-5 抢先命中 glm-5.3）
    let best = null;
    for (const key of Object.keys(table)) {
      if (bare === key || bare.startsWith(key + '/') || bare.startsWith(key + '-') || bare.startsWith(key + '@') || bare.startsWith(key + ':')) {
        if (!best || key.length > best.length) best = key;
      }
    }
    if (best) return { ...table[best], matched: best };
    return null;
  };

  const direct = lookup(raw);
  if (direct) return direct;

  const norm = raw.replace(/_/g, '-');
  if (norm === raw) return null;   // 没有 _，归一化无意义，维持原判
  return lookup(norm);
}

/* ══════════════════════════════════════════════════════════════
   远程价格表（自托管 JSON，按 id 覆盖内置表）
   ══════════════════════════════════════════════════════════════

   内置表 OFFICIAL_PRICES 保持只读、随版本发布；
   远程表由 src/price-feed.js 拉取/校验后经 setRemotePrices 注入，
   与内置表**按模型 id 合并**（远程赢），内置表其余条目仍是兜底。
   查价时走 EFFECTIVE_PRICES —— 合并结果在注入时重建一次，
   不在每次查价时临时拼（用量统计要逐条解析几百次）。
*/
let REMOTE_OVERRIDES = {};                 // { 模型id(小写): 条目 }
let EFFECTIVE_PRICES = OFFICIAL_PRICES;    // 内置 + 远程的合并视图

/** 注入远程价格表（已校验的条目）。传 {} 即退回纯内置表。 */
export function setRemotePrices(map) {
  REMOTE_OVERRIDES = (map && typeof map === 'object') ? map : {};
  EFFECTIVE_PRICES = Object.keys(REMOTE_OVERRIDES).length
    ? { ...OFFICIAL_PRICES, ...REMOTE_OVERRIDES }
    : OFFICIAL_PRICES;
}

/** 当前生效的远程覆盖条目数（状态展示用）。 */
export function remoteOverrideCount() {
  return Object.keys(REMOTE_OVERRIDES).length;
}

/** 列出全部价格条目（给设置页展示/提示用）。远程覆盖的条目带 remote:true。 */
export function listOfficialPrices() {
  return Object.entries(EFFECTIVE_PRICES).map(([id, p]) => (
    Object.prototype.hasOwnProperty.call(REMOTE_OVERRIDES, id)
      ? { id, ...p, remote: true }
      : { id, ...p }
  ));
}

/**
 * 峰谷分时计价（DeepSeek 自 2026-08-16 起实行，其他厂商暂无此机制）。
 *
 * 官方规则原文：
 *   高峰时段 = 北京时间周一至周五 09:00-12:00、14:00-18:00
 *   其余时间（含整个周末）为闲时
 *   闲时价 = 高峰价的一半
 *
 * 之所以要单独处理：如果全按闲时价估算，会明显低估实际支出；
 * 全按高峰价又会高估。正确做法是**按每笔调用发生的时间分别取价**。
 */

// 高峰时段（北京时间）。weekday: 1=周一 … 5=周五；0/6 为周末，全天闲时。
export const PEAK_WINDOWS = [
  { from: 9, to: 12 },
  { from: 14, to: 18 }
];

// 目标时区相对 UTC 的小时偏移（北京 = UTC+8）。做成常量便于未来扩展其他厂商时区。
const PEAK_TZ_OFFSET_HOURS = 8;

/* ── 法定节假日日历（DeepSeek 计费口径：法定节假日全天空闲） ──
 *
 * ★ 2026-10-17（只认官方为凭，不编造）：DS 把"中国法定节假日"算全天空闲，但没有给固定表；
 *   节假日名单**逐年由国务院办公厅公布**。这里只收录官方原文公布过的年份：
 *
 *   · 2026 ——《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号，
 *     2025-11-04 发布）https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 *     （2026-10-17 核对原文）。收录的是**公告的放假日期范围**（含调休合并进假期的周末休息日，
 *     周末本来就全天空闲，收录与否不影响峰谷判定）；公告的"调休上班"周六/周日
 *     （2026-01-04、02-14、02-28、05-09、09-20、10-10）**不收录** —— DS 明文
 *     "包括周末及中国法定节假日全天均为空闲"，峰谷只认周一至周五，调休补班的周末仍属空闲，
 *     不与"周末调休"混淆。
 *
 *   日历未收录的年份：没有可凭的节假日信息 ⇒ isPeakHour 按"工作日窗口"估算
 *   （节假日会误判为高峰 ⇒ 成本**偏高**，不偏低）。统计层用 peakCalendarYears() /
 *   peakCalendarSources() 把"窗口覆盖到哪年/依据是什么"如实亮给用户，不假装知道。
 *
 * @type {Map<number, Set<string>>} 年份 → 'YYYY-MM-DD'（北京时间自然日）集合
 */
const PEAK_HOLIDAYS = new Map([
  [2026, new Set([
    // 元旦：1月1日(周四)–3日(周六)；1月4日(周日)上班
    '2026-01-01', '2026-01-02', '2026-01-03',
    // 春节：2月15日(周日)–23日(周一)；2月14日、2月28日(周六)上班
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    // 清明节：4月4日(周六)–6日(周一)
    '2026-04-04', '2026-04-05', '2026-04-06',
    // 劳动节：5月1日(周五)–5日(周二)；5月9日(周六)上班
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // 端午节：6月19日(周五)–21日(周日)
    '2026-06-19', '2026-06-20', '2026-06-21',
    // 中秋节：9月25日(周五)–27日(周日)
    '2026-09-25', '2026-09-26', '2026-09-27',
    // 国庆节：10月1日(周四)–7日(周三)；9月20日(周日)、10月10日(周六)上班
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
    '2026-10-06', '2026-10-07'
  ])]
]);

/** 已收录年份的官方日历来源（凭据与核对时间），给 API/OI 亮"这段日历是官方为凭"用的。 */
export const PEAK_HOLIDAY_SOURCES = Object.freeze({
  2026: Object.freeze({
    title: '国务院办公厅关于2026年部分节假日安排的通知（国办发明电〔2025〕7号，2025-11-04 发布）',
    url: 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm',
    verifiedAt: '2026-10-17'
  })
});

/** 带内置法定节假日日历的年份（统计层用它报"窗口覆盖到哪一年"，未覆盖年份是估算）。 */
export function peakCalendarYears() {
  return [...PEAK_HOLIDAYS.keys()].sort((a, b) => a - b);
}

/** 已收录年份的日历来源元数据（只读快照），配 peakCalendarYears() 一起用。 */
export function peakCalendarSources() {
  return PEAK_HOLIDAY_SOURCES;
}

/**
 * 把 usage 行的 `at` 归一成毫秒时间戳。**数字 / Date / ISO 字符串**三种都认：
 *   · 数字（含纯数字串）：>0 的有限值才算数；
 *   · ISO（`2026-10-17T09:30:00+08:00` / `...Z`）：用 `Date.parse` 得到绝对时刻
 *     （时区由字符串自己的偏移决定，不做任何本地时区假设）；
 *   · 其它/空/非法 ⇒ `null`（= 时间不可信，调用方按 unknown 处理，不按当前时间猜）。
 * 聚合统计（sumCostByTime / costOfRows）与 priceAt/isPeakHour 共用这一份判据。
 */
export function toEpochMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * 判断某个时刻是否处于高峰时段。
 *
 * 官方规则（2026-10-17 重核）：高峰 = 北京时间**周一至周五（不含中国法定节假日）
 * 9:00-12:00、14:00-18:00**；其余时段（含周末与法定节假日全天）为空闲。
 *
 * ⚠ 两项边界：
 *   ① **法定节假日**：官方把它们算空闲，节假日名单逐年由国办公布 ⇒ 只有**带官方日历的年份**
 *      才精确判定（2026 已内置 gov.cn 国办发明电〔2025〕7号，见 PEAK_HOLIDAYS）；
 *      日历未收录的年份没有可凭的节假日信息，按"工作日窗口"估算 ⇒ 节假日被当成高峰，
 *      成本**偏高**（不会偏低）。日历依据与覆盖年份由 peakCalendarYears()/peakCalendarSources()
 *      带出去，聚合层负责显示"哪些年份是估算"——不在价格里假装知道。
 *   ② 星期几必须和小时一样**先换算到北京时间**：UTC 16:00 之后北京已是次日，
 *      只对小时 +8 而星期取 UTC 的写法在跨日边界会错判（历史实现有这个问题，2026-10-17 修）。
 *
 * @param {number|Date} at 时间戳（毫秒）或 Date；**调用方必须传有效时刻**。
 *   不传才回退到当前时间（仅供交互式预览）；聚合统计请先校验 `r.at`（见 priceAt/sumCostByTime）。
 * @returns {boolean}
 */
export function isPeakHour(at = Date.now()) {
  const ms = toEpochMs(at);
  const d = new Date(ms != null ? ms : Date.now());
  // 整体平移 +8h 后读 UTC 字段 = 北京本地时间（年份/日期/星期会一起进位）。
  const bj = new Date(d.getTime() + PEAK_TZ_OFFSET_HOURS * 3600 * 1000);
  const localHour = bj.getUTCHours();
  const wd = bj.getUTCDay();
  // ① 法定节假日全天空闲 —— 只有收录了官方日历的年份才算数；
  //    未收录年份不装作知道（日历查不到 ⇒ 落到下面的工作日判定，节假日按偏高估算）。
  const dayKey = bj.getUTCFullYear() + '-' + String(bj.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bj.getUTCDate()).padStart(2, '0');
  if (PEAK_HOLIDAYS.get(bj.getUTCFullYear())?.has(dayKey)) return false;
  // 周六(6)、周日(0) 全天空闲（官方明文"包括周末"⇒ 调休补班的周末也空闲，与 DS 规则不混淆）
  if (wd === 0 || wd === 6) return false;
  return PEAK_WINDOWS.some((w) => localHour >= w.from && localHour < w.to);
}

/**
 * 按时刻取对应档位的价格。
 * 没有 peak 字段的模型（绝大多数）峰谷同价，直接返回基础价。
 *
 * ★ 2026-10-17（时间缺失不造假）：显式传 `null`（或非法值）表示"这笔调用没有可信时刻"，
 *   此时**不按当前时间猜**：返回基础（空闲）档并带 `peakUnknown:true`，由调用方标"部分估算"。
 *   不传参数时仍按当前时间（只供交互预览；聚合统计请传行内 `at` 并先校验）。
 * @returns {{in:number, out:number, cached:number, created:?number,
 *            peak:boolean, peakUnknown:boolean}}
 */
export function priceAt(price, at = Date.now()) {
  const ms = toEpochMs(at);
  const timeKnown = ms != null;
  const peak = timeKnown ? isPeakHour(ms) : null;
  const base = {
    in: Number(price?.in) || 0,
    out: Number(price?.out) || 0,
    cached: price?.cached == null ? Number(price?.in) || 0 : Number(price.cached) || 0,
    created: price?.created == null ? null : Number(price.created) || 0,
    peak: false,
    peakUnknown: peak === null
  };
  if (peak === true && price?.peak) {
    return {
      in: Number(price.peak.in) || Number(price.in) || 0,
      out: Number(price.peak.out) || Number(price.out) || 0,
      cached: price.peak.cached == null
        ? (price.cached == null ? Number(price.peak.in) || 0 : Number(price.cached) || 0)
        : Number(price.peak.cached) || 0,
      created: price.peak.created == null
        ? (price.created == null ? null : Number(price.created) || 0)
        : Number(price.peak.created) || 0,
      peak: true,
      peakUnknown: false
    };
  }
  return base;
}

/**
 * 对一批用量按各自发生时间分别计价后汇总。
 * 用于历史统计：每个会话都有 startedAt，逐条判定峰谷才准。
 *
 * ★ 2026-10-17：
 *   · **时间缺失不按当前时间猜**：`at` 非有限正数 ⇒ 用基础（空闲）档计价，
 *     并把成本/token 记进 `unknownTimeCost/unknownTimeTokens`（不进 peak/offPeak 两个桶），
 *     调用方据此标"部分估算"。
 *   · **创建价不套 125%**：只有价格条目**自己给了 `created` 单价**才算创建价；
 *     否则创建 token 按普通输入价计（DeepSeek 没有单独的缓存创建费；125% 是百炼显式缓存的规则）。
 *
 * @param {Array<{promptTokens,completionTokens,cachedTokens,cacheCreationTokens,at}>} rows
 * @param {object} price 价格条目
 * @returns {{cost:number, peakCost:number, offPeakCost:number, unknownTimeCost:number,
 *            peakTokens:number, offPeakTokens:number, unknownTimeTokens:number}}
 */
export function sumCostByTime(rows, price) {
  let cost = 0, peakCost = 0, offPeakCost = 0, unknownTimeCost = 0;
  let peakTokens = 0, offPeakTokens = 0, unknownTimeTokens = 0;
  for (const r of rows || []) {
    const atMs = toEpochMs(r?.at);
    const timeKnown = atMs != null;
    const p = priceAt(price, timeKnown ? atMs : null);
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const created = Math.min(Number(r.cacheCreationTokens) || 0, Math.max(0, prompt - cached));
    const fresh = Math.max(0, prompt - cached - created);
    // 只有条目明确给了 created 单价才算创建价；没有就按普通输入价（不套 1.25）。
    const createdPrice = Number(p.created != null ? p.created : p.in) || 0;
    const c = (fresh / 1_000_000) * p.in
      + (created / 1_000_000) * createdPrice
      + (cached / 1_000_000) * p.cached
      + (completion / 1_000_000) * p.out;
    cost += c;
    // 峰谷归属按"调用发生在哪个时段"判定，而不是按模型是否分档。
    // 否则一个无峰谷模型（如 GLM）在高峰时段花的钱会被算进闲时，
    // 用户看到的"高峰花了多少"就失真了。时间不可信 ⇒ 单独一桶，不冒充任何时段。
    if (!timeKnown) {
      unknownTimeCost += c;
      unknownTimeTokens += prompt + completion;
    } else if (isPeakHour(atMs)) {
      // 峰谷归属按**调用时刻**判定，与模型是否有分档无关（旧口径；GLM 等无峰谷模型
      // 在高峰时段花的钱也要算进"高峰花了多少"）。
      peakCost += c;
      peakTokens += prompt + completion;
    } else {
      offPeakCost += c;
      offPeakTokens += prompt + completion;
    }
  }
  return { cost, peakCost, offPeakCost, unknownTimeCost, peakTokens, offPeakTokens, unknownTimeTokens };
}

/**
 * 计算一张图片折算成多少输入 token。
 *
 * 各厂商规则差异极大 —— 有的按张封顶，有的按像素算，差可达 40 倍：
 *   - DeepSeek 视觉版：缩放到约 800×800 后**按张封顶 384 token**（与原图尺寸无关）
 *   - 千问（百炼）：**按像素** h×w/1024 + 2，上限 1600 万像素/图
 *     4096×4096 的图 → 15627 token，是 DeepSeek 的 40 倍
 *
 * @param {object} price 价格条目（取其 image 字段）
 * @param {number} width  图片宽（像素），可省略（capped 模式不需要）
 * @param {number} height 图片高（像素），可省略
 * @returns {number|null} token 数；该模型不支持图片则返回 null
 */
export function imageTokens(price, width, height) {
  const img = price?.image;
  if (!img) return null;

  // 按张封顶：无论原图多大，都是固定值（内部已缩放）
  if (img.mode === 'capped') return Number(img.maxTokensPerImage) || 0;

  // 按像素：h × w / divisor + base，像素数先按上限截断
  if (img.mode === 'pixel') {
    const divisor = Number(img.divisor) || 1024;
    const base = Number(img.base) || 0;
    const maxPx = Number(img.maxPixels) || 0;
    if (!width || !height) return null;   // 没给尺寸算不了
    let px = Number(width) * Number(height);
    if (maxPx) px = Math.min(px, maxPx);
    return Math.floor(px / divisor) + base;
  }

  // 只知道"有图片计费"但没给公式：给个保守提示值
  if (img.maxTokensPerImage) return Number(img.maxTokensPerImage) || 0;
  return null;
}

/** 该模型是否支持图片输入（有 image 规则即视为支持）。 */
export function supportsImage(price) {
  return Boolean(price?.image);
}

/**
 * 模型价格的统一解析入口。
 *
 * ── 第 10 条原则：成本只与"实际调用的模型"有关，与"当前选择的模型"无关 ──
 * 历史统计里每次调用都会带上它自己的 model（网关返回的真名），
 * 逐条解析各自的价格，而不是拿当前配置里的模型去套所有调用。
 *
 * 优先级（从高到低）：
 *   1. 用户在「模型 API → 成本核算」为**该模型**单独设定的价格（cfg.modelPrices）
 *      —— 一旦设定就用它，与内置官方表开关无关
 *   2. 开了「使用官方价格表」且该模型 id 能在内置表中匹配到
 *   3. 全局兜底单价（cfg.priceInputPerM 等）
 *
 * @param {string} modelId 模型 id（通常是网关返回的真名）
 * @param {object} cfg 配置对象（getConfig() 的结果）
 * @returns {{
 *   in:number, out:number, cached:number,
 *   peak:?{in:number,out:number,cached:number},
 *   image:?object,
 *   source:'custom'|'official'|'manual'|'none',
 *   matched:?string, locked:boolean
 * }}
 *   - source: custom=用户自定义 / official=内置官方表 / manual=全局兜底 / none=无单价
 *   - locked: 是否因"命中内置官方表且开关打开"而不可编辑
 */

/* ══════════════════════════════════════════════════════════════
   模型单价解析
   ══════════════════════════════════════════════════════════════

   规则（刻意做得简单）：
     开关开 → 一律走内置官方价格表，且**只读**
              匹配不到就是单价 0（估不出成本），提示关开关自填
     开关关 → **可编辑**，优先该模型的自定义价，没设则用全局兜底

   可编辑性**只跟开关绑定**：不看有没有匹配到、也不看该模型存没存过
   自定义价。绝不依赖保存状态。
*/

/**
 * @param {string} modelId 模型 id
 * @param {object} cfg 配置
 * @param {Array} [priceTable] 内置价格表（可选，默认用内置的 OFFICIAL_PRICES）
 * @returns {{in:number,out:number,cached:number,created:?number,peak:?object,image:?object,
 *            source:'official'|'unmatched'|'custom'|'manual'|'none',
 *            priced:boolean, zero:boolean, matched:?string, locked:boolean,
 *            approximate:boolean, priceSrc:string, remote:boolean, note:string}}
 *   · `priced=false`（unmatched/none）= **没有可信单价**：调用方必须显示"未知/未定价"，
 *     不许把相容字段里的 0 当成"免费"；
 *   · `zero=true` 且 `priced=true` = **来源明确的 0 价**（官方免费 / 用户手填 0）；
 *   · ★ 2026-10-17（official 之下仍要分层）：
 *     - `approximate=true` = 该命中条目是表内 `src:'derived'`（旧别名/折算近似），**不是官方精确现价**；
 *     - `priceSrc` = 命中条目自身的 src 分级（'official' / 'derived' / 远程表里的原样分级）；
 *     - `remote=true` = 该命中来自**远程价格表覆盖**（可能是旧缓存）≠ 内置表（内置表或已重核更新）；
 *     - `note` = 条目备注原样带出（"官方现页未列出"等口径说明），没有就空串。
 *     `source` 仍恒为 'official'（旧键/旧 UI 分支不动），分层靠上面四个字段。
 */
export function resolveModelPrice(modelId, cfg, priceTable = null) {
  const id = String(modelId || '').trim();
  const api = (cfg && cfg.api) || {};
  const useOfficial = api.useOfficialPrice === true;
  const zeroOf = (x) => !(Number(x?.in) || Number(x?.out) || Number(x?.cached));

  if (useOfficial) {
    const p = id ? (priceTable ? matchPriceTable(id, priceTable) : resolveOfficialPrice(id)) : null;
    if (p) {
      const matched = p.matched ?? id;
      // ★ 2026-10-17（来源可分，不许混装成官方精确现价）：迁移表在**注入时合并**（远程赢），
      //   这里只按 matched 键在 REMOTE_OVERRIDES 里的存在与否判定"远程来源"。
      const isRemote = matched ? Object.prototype.hasOwnProperty.call(REMOTE_OVERRIDES, matched) : false;
      return {
        in: Number(p.in) || 0,
        out: Number(p.out) || 0,
        cached: p.cached == null ? Number(p.in) || 0 : Number(p.cached) || 0,
        created: p.created == null ? null : Number(p.created) || 0,
        peak: p.peak || null,
        image: p.image || null,
        source: 'official',
        priced: true,
        zero: zeroOf(p),
        matched,
        locked: true,
        approximate: p.src === 'derived',
        priceSrc: p.src ?? 'official',
        remote: isRemote,
        note: typeof p.note === 'string' ? p.note : ''
      };
    }
    // 开关注定要读，但表里没有 —— 单价 0，仍然只读；**priced=false**：这是"查不到价"，不是免费
    return {
      in: 0, out: 0, cached: 0, created: null,
      peak: null, image: null,
      source: 'unmatched',
      priced: false,
      zero: false,
      matched: null,
      locked: true
    };
  }

  const priceTable_ = api.modelPrices || {};

  // 自定义键：原样精确命中（用户手填键与 id 逐字一致时行为不变）。
  // 落空才做保守归一化重试（大小写 + _ → -）：中转站返回 qwen_flash 而用户
  // 自定义价填 qwen-flash 时不再落 none。归一化可能为原本不命中的键增加命中，
  // 绝不改变已命中键的结果；若归一化后多个键同时命中，无法确定用户意图，
  // 按未命中处理并告警（宁缺毋错）。
  let custom = priceTable_[id];
  let customKey = custom ? id : null;
  if (!custom && id) {
    const norm = (s) => String(s).trim().toLowerCase().replace(/_/g, '-');
    const want = norm(id);
    if (want) {
      const hits = Object.keys(priceTable_).filter((k) => norm(k) === want);
      if (hits.length === 1) {
        custom = priceTable_[hits[0]];
        customKey = hits[0];
      } else if (hits.length > 1) {
        console.warn(`[model-prices] 自定义价格表键归一化后撞键（${hits.join(' / ')}），按未匹配处理：${id}`);
      }
    }
  }
  // ★ 2026-10-17：**键存在即视为用户显式定价** —— 包括显式的 0（免费模型）。
  //   旧实现要求 `in||out` 非 0，导致"手填 0"被当成没配、悄悄回落到官方价/全局价；
  //   而"没配置"与"配置为 0"是两件事（前者是未知，后者是免费）。
  if (custom && typeof custom === 'object') {
    return {
      in: Number(custom.in) || 0,
      out: Number(custom.out) || 0,
      cached: custom.cached == null ? Number(custom.in) || 0 : Number(custom.cached) || 0,
      created: custom.created == null ? null : Number(custom.created) || 0,
      peak: custom.peak || null,
      image: null,
      source: 'custom',
      priced: true,
      zero: zeroOf(custom),
      matched: customKey ?? id,
      locked: false
    };
  }

  const fi = Number(api.priceInputPerM) || 0;
  const fo = Number(api.priceOutputPerM) || 0;
  if (fi || fo) {
    return {
      in: fi,
      out: fo,
      cached: Number(api.priceCachedPerM) || fi,
      created: null,
      peak: null, image: null,
      source: 'manual',
      priced: true,
      zero: false,
      matched: null,
      locked: false
    };
  }

  return {
    in: 0, out: 0, cached: 0, created: null,
    peak: null, image: null,
    source: 'none',
    priced: false,
    zero: false,
    matched: null,
    locked: false
  };
}

/** 在一张价格表里匹配模型（供前端用本地数据算，不依赖接口往返）。 */
export function matchPriceTable(modelId, table) {
  const raw = String(modelId || '').trim();
  if (!raw) return null;

  // 与 resolveOfficialPrice 同一套保守归一化：原路径全部落空（原本会返回 null）
  // 后，才把 _ 归一为 - 重试一次；原本能命中的 id 在归一化之前就已返回，逐字不变。
  const lookup = (id) => {
    const list = table || [];

    const exact = list.find((x) => String(x.id).toLowerCase() === id);
    if (exact) return { ...exact, matched: exact.id };

    // 去 provider 前缀后再试（z-ai/glm-5.3 → glm-5.3）
    if (id.includes('/')) {
      const bare = id.split('/').pop();
      const hit = list.find((x) => String(x.id).toLowerCase() === bare);
      if (hit) return { ...hit, matched: hit.id };
    }

    // 前缀匹配：取最长的那条，避免 gpt-5 命中 gpt-5.6
    let best = null;
    for (const x of list) {
      const xid = String(x.id).toLowerCase();
      if (id.startsWith(xid) && (!best || xid.length > String(best.id).length)) best = x;
    }
    if (best) return { ...best, matched: best.id };
    return null;
  };

  const lower = raw.toLowerCase();
  const direct = lookup(lower);
  if (direct) return direct;

  const norm = lower.replace(/_/g, '-');
  if (norm === lower) return null;   // 没有 _，归一化无意义，维持原判
  return lookup(norm);
}

/* ══════════════════════════════════════════════════════════════
   渠道（vendor）
   ══════════════════════════════════════════════════════════════

   同一个模型 id 走不同**渠道**时，是两个不同的商品：
       「A6API中转站：z-ai/glm-5.3-flash」
       「OpenRouter：z-ai/glm-5.3-flash」
       「本地中转：z-ai/glm-5.3-flash」

   这里说的渠道 = 程序内配置的 API 端点（A6API / OpenRouter / 本地中转…），
   **不是**网关返回的下游供应商（raw.provider）—— 后者一次调用一个值、
   多达几十种，粒度太细，也不代表用户实际采购的渠道。
*/

/** 无渠道信息时的显示名。历史会话没记录渠道时用它，绝不拿当前配置去猜。 */
export const UNKNOWN_VENDOR = '未知渠道';

/**
 * 由 API 配置派生渠道名（只用于**新产生的调用**）。
 *
 * 优先级：
 *   1. providers 里 id 匹配 api.provider → displayName（如「A6API中转站」）
 *   2. providers 里 baseURL 匹配 api.baseUrl → displayName
 *   3. 退回 baseUrl 的域名（如 openrouter.ai）
 *   4. 都没有 → null（调用方按"未知渠道"处理）
 *
 * 历史会话请用它自己记录的 vendor 字段；拿当前配置倒推历史是错的。
 */
export function vendorOfConfig(cfg) {
  const c = cfg || {};
  const api = c.api || {};
  const base = String(api.baseUrl || '').trim();
  const provs = Array.isArray(c.providers) ? c.providers : [];
  const norm = (u) => String(u || '').replace(/\/+$/, '');

  const byId = api.provider ? provs.find((p) => p && p.id === api.provider) : null;
  const byUrl = base ? provs.find((p) => p && p.baseURL && norm(p.baseURL) === norm(base)) : null;
  const hit = byId || byUrl;
  if (hit && hit.displayName) return String(hit.displayName);

  if (base) {
    try { return new URL(base).host; } catch { /* 非法 URL */ }
  }
  return null;
}

/** 模型完整身份：「渠道：模型 id」。全角冒号，避免与 id 里的半角符号混淆。 */
export function modelLabel(vendor, model) {
  const v = String(vendor || '').trim() || UNKNOWN_VENDOR;
  const m = String(model || '').trim() || '(未知模型)';
  return `${v}：${m}`;
}

/** 把「渠道：模型 id」拆回两半。拆不开时 vendor 为空串。 */
export function splitModelLabel(label) {
  const s = String(label || '');
  const i = s.indexOf('：');
  return i > 0 ? { vendor: s.slice(0, i), model: s.slice(i + 1) } : { vendor: '', model: s };
}
