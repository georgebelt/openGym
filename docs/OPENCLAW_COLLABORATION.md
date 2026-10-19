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
| iPhone 真机操作 | 用户操作，Linux 核验服务端，Mac 修客户端问题 | 配对、同步、提案应用、取消/撤回的两端证据对应 |

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
4. Mac 维护面向 `main` 的集成 PR。下文 L1 已由 Linux 完成；2026-10-19 核对发现，
   L2 缺少客户端操作入口，须先完成 M1，不能继续要求用户在现有 IPA 中寻找按钮。
   手机取消/撤回属于真实服务验收，未测时明确保留待办，不写成已通过。
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

### L2：收尾手机端取消 / 撤回

**当前阻塞在 Mac 客户端，依赖下方 M1。** 当前 `CoachChat` 的等待提示和菜单均没有
取消操作，`coach-api.js` 也没有取消请求接口。`CoachSetup` 的“在此手机关闭教练”
只切换手机模式并清理手机本地 Coach，服务器模式下不会撤回服务器端授权；
现有问卷仅提供同意，没有撤回入口。

因此以下是真机验收目标，不是当前 IPA 已经能够执行的点击步骤。Linux 的
AbortController/断连测试证明传输能取消，不证明 app 已有取消按钮。

用户在 iPhone 各执行一次取消进行中的 Coach 请求、撤回 Coach 授权。Linux 核对：

- job 状态及后续取回结果符合取消/撤回语义，不留下可应用的迟到提案；
- bridge 上游请求终止，相关 OpenClaw session 不再继续生成；
- 撤回后新请求在重新同意前被拒绝，已有训练同步不受影响。

记录时间、脱敏 request/job ID 和结果。若故障在 app/API，交 Mac 修；若在
bridge/OpenClaw，Linux 修。真实第二账号 UI 与跨北京时间午夜的检查可继续作为
补充验收；已有错误 profile 403、只读 MCP 和时区单测不能冒称这些真机步骤已完成。

### L3：更新部署记录

L1/L2 完成后，Linux 更新自己的验收文档：当前配置为 API 480 秒、bridge 470 秒；
保留历史失败作为历史记录，明确引用 Mac 最新测试结果。升级时补记部署 SHA。

## 新确认的 Mac 待办

### M1：补齐取消 / 撤回入口，再交付新版 IPA

这是 2026-10-19 对用户操作问题的源码审查结论，尚未实现：

- 取消只针对当前请求，必须能终止服务器任务并丢弃迟到结果，保留授权、训练数据和
  已有 Coach 历史。不能直接把清理全部 Coach 记录的 `/api/coach/forget` 当取消接口。
- 撤回授权须同步更新服务器的授权状态，并终止相关任务、清理待确认提案；保留训练
  数据及重新同意的入口。现有 `/api/coach/forget` 只清理 job 记录，不独立修改已同步
  profile 的 `consent`，单调这个端点不足以实现“新请求被拒”。
- UI 在未授权时应引导重新同意；不能要求用户绕过界面提交新请求来观察 403。
  Linux 用受控 API 验收拒绝未授权请求，用户验证手机不会在未重新同意时启动 Coach。
- Mac 完成实现、测试和 IPA 打包后提供实际点击步骤；Linux 再配合用户做 L2。

## 已评估的后续改进

- **Mac：Coach 用途提示。** app 内 Coach 用于创建/复盘/调整计划；自由健身问答
  在 OpenClaw 的 `gym-coach` 对话入口，通过只读 MCP 查询已同步数据。已补充用户文档，
  app 内提示文案列为后续 UX 改进，不将通用聊天悄悄接入提案通道。
- **Mac：JSON 错误诊断。** `extractJSON` 已支持 Markdown 围栏，已有测试；
  无需再实现一次。更具体的修复提示属于后续改进，须保持校验严格且不记录私人模型原文。
  当前模型引号问题由 Linux 的 persona v1.1 提示修复，实际 review 通过情况见 Linux 记录。

这两项是改进建议，不是现有 Coach/MCP 接通的缺失功能，也不是本轮合并条件。
