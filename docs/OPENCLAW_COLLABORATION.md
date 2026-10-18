# openGym：Mac / Linux 分工与交接

更新：2026-10-18。本轮集成基线为 Linux 分支 `codex/linux-gym-coach` 的
`eae02053`；Mac 集成分支为 `codex/opengym-integration`。
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
4. Mac 维护面向 `main` 的集成 PR。本轮先完成下文 L1，再最终复核并合并。
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

### L1：让长任务验收使用生产环境相同的 fetch（合并前收口）

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

## 已评估的后续改进

- **Mac：Coach 用途提示。** app 内 Coach 用于创建/复盘/调整计划；自由健身问答
  在 OpenClaw 的 `gym-coach` 对话入口，通过只读 MCP 查询已同步数据。已补充用户文档，
  app 内提示文案列为后续 UX 改进，不将通用聊天悄悄接入提案通道。
- **Mac：JSON 错误诊断。** `extractJSON` 已支持 Markdown 围栏，已有测试；
  无需再实现一次。更具体的修复提示属于后续改进，须保持校验严格且不记录私人模型原文。
  当前模型引号问题由 Linux 的 persona v1.1 提示修复，实际 review 通过情况见 Linux 记录。

这两项是改进建议，不是现有 Coach/MCP 接通的缺失功能，也不是本轮合并条件。
