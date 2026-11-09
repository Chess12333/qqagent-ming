# QQ-Agent · **溟版**

> 这份代码是从一台真机上天天跑着的 QQ 群 AI 机器人里导出来的，由 **溟** 整理、脱敏、剪成一个能公开的版本，所以叫**溟版**（community edition）。
> 结构与资源完整保留；**主人身份、群号、人格设定已经全部剔掉**，换成了占位与环境变量。
> 它不是那台机器的原样副本——原机上那套带着它自己的主人和群，那些东西不该出现在这里。

## 它是什么

一个 Electron 桌面版的 QQ 群机器人：**事件驱动的无状态 Agent**，接 OpenAI 兼容 API，带会话式控制台。

`refactor/` 是模块化的那一套（225 个 js），旧版的 `src/` `ui/` `electron/` 没有进来。

```
refactor/
  apps/         desktop（Electron 主进程 + 桌宠）/ server / ui
  core/         配置、存储这些地基
  modules/      一个个能力：act（动作）、memory（记忆）、emotion（情绪）、
                media（看图）、internet（上网）、jev（裁判）……
  contracts/    冻结的接口
plugins/       ming-bridge（与 DSH 那边通信的桥）、proactive-plus
skills/        技能包
themes/        主题
```

## 溟版做了什么

从原机导出的脚本（`export-qq-agent.mjs`）做了三件事，做完还跑了一遍自检，命中任何一条就不许提交：

| 原样 | 现在 |
|---|---|
| 主人的 QQ 号、机器人自己的号、其余几个白名单号 | 占位数字（`100000001` / `100000002` …） |
| 三个群号 | 占位数字（`200000001` …） |
| 本机用户名（`C:/Users/<用户名>/…`） | `USER` |
| 「QQ xxxxx 是主人，一律写「她」」这段抽取提示词 | 改成读 `QQAGENT_OWNER_QQ`，把人称规则留成通用写法 |
| `data/`（真实聊天）、`backup/`、`models/`、`runtime/`、`snowluma/`、`node_modules/` | 一律没进仓 |

所以：**你要自己填主人在哪、群号是多少。** 见下面的环境变量。

## 跑起来

```bash
npm install          # node >= 20
npm start            # = electron refactor
```

还需要：

- 一个 **OneBot v11 实现**（原机器用的是 snowluma，不在这个仓里）
- 一个 **OpenAI 兼容的 API**（key 自己填，别提交）
- `data/config.json` 自己生成（仓里只有示例字段）

### 环境变量

| 变量 | 干什么 |
|---|---|
| `QQAGENT_OWNER_QQ` | 主人的 QQ 号（决定谁的话算「本人指令」、记忆抽取里谁一律写「她」） |
| `QQAGENT_SELF_QQ` | 机器人自己的号（不给自己写印象） |

## 相关项目

- [**Hers_Life**](https://github.com/Chess12333/Hers_Life) —— 同一台机器上的 DSH 插件集（记忆、星图、桌宠、声音、B 站）。
  其中 `dsh-ming-mousepet` 的**输入与 AI 光标**那一半，来自
  [**dsh-independent-input**](https://github.com/dongcaodeliyu/dsh-independent-input)（作者 **dongcaodeliyu**）：
  默认走 UIA / 窗口消息、不动主人真实光标，主人一碰键鼠就暂停。原仓照旧可用。

## 状态

在一台机器上天天用，不是发布版。改动的理由、踩过的坑、哪条规矩是因为哪次事故加上的，都写在代码注释里——那些注释是这套东西最值钱的部分。

## 贡献者

名单和「怎么把自己加进来」见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。右侧那个 Contributors 栏是 GitHub 按提交作者自动算的，没有开关。

## 许可

MIT。
