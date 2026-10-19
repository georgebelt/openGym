# openGym：Mac / Linux 分工与交接

更新：2026-10-19。Mac 已拉取 Linux 分支 `codex/linux-gym-coach` 的
`af98b466`；Mac 集成分支为 `codex/opengym-integration`。
集成草稿：[PR #1](https://github.com/georgebelt/openGym/pull/1)。

## 谁负责什么

| 范围 | 负责人 | 交付标准 |
| --- | --- | --- |
| `frontend/`、中文界面、iPhone 配对/同步客户端、Coach 配置与交互 | Mac | 应用代码、测试、需要时浏览器验收 |
| `api/`、OpenClaw provider、授权/账号绑定、提案解析校验及取消逻辑 | Mac | 后端源码与回归测试；HTTP 合同变化提前写入交接 |
| `mcp/` 源码与测试、共享训练计算逻辑 | Mac | 工具行为、Node 可加载性和 UTC/北京时间测试 |
| `scripts/`、生成文件、CI、iOS 工程及 IPA 构建 | Mac | 可重复构建、生成文件无漂移；客户端有变化才重打 IPA |
| `deploy/linux/`：Compose、bridge、systemd、persona 模板、真实模型验收脚本 | Linux | 部署源码、bridge 合同测试、脱敏验收结果 |
| Linux 实际运行环境 | Linux | Docker 构建/升级/回滚、数据备份、密钥、OpenClaw agent/workspace/MCP 注册、Tailscale/HTTPS |
| 代码审查、上游 commit 选择、分支集成和 `main` 合并 | Mac | 审查 Linux 提交并跑回归，确认待办状态后集成 |
| iPhone 真机操作 | 用户操作，Linux 核验服务端，Mac 修客户端问题 | 配对、同步、提案应用；验收以现有产品入口为准 |

Mac 不 SSH 修改 Linux，也不替 Linux 改运行时 persona 或部署脚本；Linux 不直接改
`api/`、`frontend/`、`mcp/` 或推送 `main`。跨边界问题用 Git 记录复现、预期和建议，
由对应负责人实施。用户后续明确调整分工时，以用户指示为准。

Glass 仅作为只读参考。它的仓库、工作区、数据和服务不属于本任务；不复用其
persona、凭证或会话。实际 token、主机名和账号资料留在服务器/私密渠道。

## 如何交接和合并

1. Linux 在 `codex/linux-gym-coach` 提交部署改动和
   [Linux 验收记录](OPENCLAW_LINUX_RESULTS.md)，推送 GitHub。
2. Mac 拉取并审查，在 `codex/opengym-integration` 合入 Linux 提交，追加应用与测试修复。
   双方不重置或强推对方分支，不重复提交对方正在负责的文件。
3. Linux 如需 Mac 的修复，可把已推送的集成分支普通 merge 到自己的分支，保留提交历史。
   后续 Linux 修复仍推自己的分支，Mac 再集成；避免把整组已有提交重新 cherry-pick。
4. Mac 维护面向 `main` 的集成 PR。下文 L1 已由 Linux 完成。用户在 2026-10-19
   明确不增加仅为测试而存在的功能：L2 的手机取消/撤回步骤对当前版本不适用，
   不要求补界面或重打 IPA，也不将这些不存在的产品入口作为合并前置条件。
   底层测试与真实手机操作分别记录，不能互相冒充。
5. `main` 更新之后，由 Linux 决定部署窗口、备份并构建新版本，记录实际部署 SHA。
   Git 合并与服务器部署是两个独立动作。

## 本轮 Mac 交付

- 引入上游 `0526d657259780a3a7299a891ca9cd0ee2be70c4`：
  API fixture 日期随当前日历按整周移动，保留训练间隔，解决 10 个过期日期断言失败。
- 按 `api/openapi.yaml` 重生成 `website/api.html`，补齐 OpenClaw persona 和
  `profileUid` 文档，恢复生成文件检查。
- 修正 MCP 和前端测试的本地时间假设：示例数据固定本地中午；FIT 导出 fixture
  的日期与本地开始时间一致；纽约窗口回归显式选择纽约时区。生产训练逻辑不变。
- 前端与 MCP 的 CI 同时运行 `UTC`、`Asia/Shanghai`，避免只在 UTC 通过。
- 完整测试结果追加到 [Mac 验证记录](OPENCLAW_MAC_VALIDATION.md)。

此次仅修改测试、CI 和文档，无客户端运行时代码变化；已有 IPA 可继续使用，
无需因这轮修复重新签名安装。

## Linux 下一轮待办

**现在可开始：** 用户已授权统一对话实现。先合入集成分支，按
[普通对话 v1 合同](OPENCLAW_CHAT_CONTRACT.md) 实现新 bridge 端点、persona 提示、
持久会话/去重和部署验证。合同已先于 Mac 实现发布；下文 L1–L3 是既有提案阶段记录。

### L1：让长任务验收使用生产环境相同的 fetch（已完成）

Linux `af98b466` 已完成以下修复，并添加独立假上游验收脚本。
Linux 记录了 310 秒等待、预算耗尽和主动取消三项通过；详情见
[Linux 验收记录 §12](OPENCLAW_LINUX_RESULTS.md#12-l1-收口验收脚本对齐生产-fetch2026-10-18-追加)。
以下保留问题描述和验收要求，供后续维护参考。

位置：`deploy/linux/acceptance/coach_real_model.mjs` 的 `runPipeline` 调用。

现状：脚本把业务超时设为 470 秒，却没有注入 `fetchFor`，实际仍走 Node 全局
`fetch` 的约 300 秒响应头超时。生产 `api/coach/jobs.js` 已使用 `fetchFor`，
所以这是验收脚本与生产路径不一致，不是生产环境缺少 8 分钟预算。

由 Linux 修改该脚本：

```js
import { fetchFor } from '../../../api/coach/node-fetch.js';

// 与本机 COACH_JOB_TIMEOUT_MS 一致；大于 bridge 的 470 秒。
const TIMEOUT_MS = +process.env.TIMEOUT_MS || 480000;

// runPipeline 的其余参数保持原样。
invokeOpts: { env, maxTokens: MAX_TOKENS, fetch: fetchFor(TIMEOUT_MS) }
```

同时更正脚本内旧的 290/300 秒注释，区分 bridge 默认值与实际部署值。
验收至少包含：在独立端口的假上游延迟超过 300 秒、低于总预算后正常完成；
达到预算和主动取消能终止请求。可用假上游验证传输，无需反复消耗真实模型调用。
不要占用生产 bridge 端口。记录使用的超时配置、耗时、结果和测试命令。

此前真实 create 的 211 秒成功只证明那次请求通过，不证明大于 300 秒仍可成功。

### L2：校正验收范围（手机取消 / 撤回不适用）

当前 `CoachChat` 的等待提示和菜单均没有
取消操作，`coach-api.js` 也没有取消请求接口。`CoachSetup` 的“在此手机关闭教练”
只切换手机模式并清理手机本地 Coach，服务器模式下不会撤回服务器端授权；
现有问卷仅提供同意，没有撤回入口。

用户确认不为测试新增功能。因此“手机中途取消、手机撤回授权再重试”记为
**当前产品无此入口，不适用**，不再要求用户执行。撤销曾列出的 M1“补入口并重打 IPA”
必做项。将来是否提供取消或撤回，应按实际使用需求另行决定。

保留以下已有能力的验证，它们有独立的工程意义，无需在产品中新增测试入口：

- adapter/bridge：超时或 AbortSignal/连接断开后终止请求；L1 和 Linux bridge 验收已有证据。
- job runner：清理运行中或排队任务后不保留迟到提案、不恢复已清理的记录；
  `api/test/jobs.test.js` 的 `forgetting a profile ...` 测试覆盖。
- 授权检查：无 consent 不入队，排队期间 consent 消失则不发送 payload；
  `api/test/jobs.test.js` 的 `no consent, no job` 和
  `consent withdrawn, or the Coach switched off, while a job waits` 覆盖。

测试中改变 fixture 的 consent 是验证授权检查，不代表实现了用户可操作的撤回功能。
`/api/coach/forget` 只清理 job 记录，不独立修改已同步 profile 的 consent；
不能把调用该端点记录为“用户授权已撤回”。也不以删除或重置用户真实数据替代测试。

### L3：更新部署记录

Linux 更新自己的验收文档：L1 已完成，L2 手机步骤按上述范围记为不适用；
当前配置为 API 480 秒、bridge 470 秒。保留历史失败作为历史记录，明确引用
Mac 最新测试结果。升级时补记部署 SHA，不再等待用户执行 L2 手机步骤。

## 已评估的后续改进

- **普通对话接入 app（用户已确认 UX 方向）。** 一个教练、一个连续对话界面；
  后台路由到两个 persona，用户不切换。范围、流程和双方工作见
  [统一教练 UX](OPENCLAW_COACH_UX.md)。这是用户授权的新产品功能，Mac app/API 已实现，Linux bridge/部署待完成，
  不是为了补 L2 测试而新增入口，也不能以现有 proposal-only bridge 声称已接通。
- **Mac：JSON 错误诊断。** `extractJSON` 已支持 Markdown 围栏，已有测试；
  无需再实现一次。更具体的修复提示属于后续改进，须保持校验严格且不记录私人模型原文。
  当前模型引号问题由 Linux 的 persona v1.1 提示修复，实际 review 通过情况见 Linux 记录。

普通对话 UX 属于新增的后续范围；JSON 诊断仍为改进建议。二者不追溯为现有
提案接入分支的验收条件。


## 统一对话：Mac 本轮完成，Linux 接续部署

Mac 已实现 `/api/coach/chat`、`/consent`、`/messages`，使用已发布的 v1 bridge 合同。
完整路径及错误码见 `api/openapi.yaml`。聊天记录由后端持久化，普通请求和提案共享额度；
app 只有一个界面，普通输入不会启动计划任务。生成要求可编辑，聊天与提案可并发，
提案沿用现有确认应用流程。缺少计划资料只影响生成，不影响普通聊天。

Linux 请合入 **最新** `origin/codex/opengym-integration`（包括 Mac 实现，不仅是合同提交），
按 `OPENCLAW_CHAT_CONTRACT.md` 完成 bridge、测试、镜像构建与部署，记录实际 SHA。
Mac 没有修改 `deploy/linux/` 或连接真实 Linux；本轮合同测试不能作为真实 MCP 已通过
的证据。旧 bridge 不宣告能力时，新 app 不会把普通消息送到提案接口。
