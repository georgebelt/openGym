# OpenClaw 接入：Mac 验证记录

日期：2026-10-18。改动前基线：`0299cf5c41268b1715ac0374533f779377911119`。
环境：macOS、Node 22.23.1；主机时区 Asia/Shanghai。

## 集成复验（2026-10-18）

基于 Linux `eae02053`，在 Mac 分支 `codex/opengym-integration` 完成。
工作范围与 Linux 剩余验收见 [协作交接](OPENCLAW_COLLABORATION.md)。

| 检查 | 结果 |
| --- | --- |
| `npm test`（api） | **607/607**；引入上游 `0526d657` 后，旧日期导致的 10 项失败已消除 |
| `TZ=UTC npm test -- --maxWorkers=4`（frontend） | **5061/5061**，402 个文件 |
| `TZ=Asia/Shanghai npm test -- --maxWorkers=4`（frontend） | **5061/5061**，402 个文件 |
| `TZ=UTC npm test`（mcp） | **95/95** |
| `TZ=Asia/Shanghai npm test`（mcp） | **95/95**；旧的 UTC 中午 fixture 导致的 5 项失败已消除 |
| `node scripts/build-api-docs.mjs --check` | 通过；已重生成 `website/api.html` |
| `node scripts/build-coach-assets.mjs --check` | 通过 |
| `node api/scripts/check-core-loadable.mjs`、MCP `npm run check:node-loadable` | 通过 |
| 前端 `npm run build`、`check-locales.mjs`、`check-source-strings.mjs` | 通过；18 个语言包，1770 个源码翻译键 |
| 前端 `npm run test:fatigue-probe` | 108000 次恢复比较、1800 次历史删除比较通过 |
| `git diff --check` | 通过 |

GitHub [集成 PR #1](https://github.com/georgebelt/openGym/pull/1) 已建立为草稿。
远程 Actions 在启动前被账号账单状态拦截；Tests 和 CLA 的 annotation 均为
`The job was not started because your account is locked due to a billing issue.`。
这不是测试执行失败，也不能计为远程 CI 通过；上表是本机执行结果。账号问题处理后
再运行 GitHub 检查。

全量前端复验另外暴露并修正了三个既有时区测试假设：demoSeed 的 UTC 中午、
FIT fixture 的 UTC 开始时间与本地日期不一致、纽约日期窗口测试未指定时区。
只调整测试数据/时区，未更改生产训练逻辑；前端及 MCP 的 CI 增加两时区矩阵。
测试仍有 MaxListeners 提示，构建仍有既有 chunk/import 提示，退出状态均为 0。

Linux 的 bridge 8 项合同测试在此前 Mac 审查中通过，本轮未改 bridge，未重复运行。
Docker 构建和真实服务验收继续由 Linux 负责，情况见
[Linux 验收记录](OPENCLAW_LINUX_RESULTS.md)。本记录不把代码单测视为手机撤回/取消
或超过 300 秒真实传输已通过。此次无客户端运行时代码变化，不重打 IPA。

以下保留初次接入时的历史记录；其中日期测试失败和 Linux 尚未实施的状态不代表当前状态。

## 初次接入已通过

- `node --test api/test/openclaw.test.js`：11 个测试。
  验证请求合同、每次调用独立 ID、账号绑定、凭证轮换保留绑定、另一账号在入队前被拒绝、
  真实 HTTP 超时/取消、拒绝重定向、错误不泄漏原文、无自动重试、1 MiB 响应上限、
  JSON 合同校验及一次修复、真实 job runner 到模拟 bridge。
- HTTP adapter、credential、config migration 与 OpenClaw 的联合回归：56 个测试通过。
- 前端 `AdminCoach.test.jsx`、`CoachSetup.flow.test.jsx`、`coach-local.test.js`、
  `coach.test.js`：172 个测试通过。
- `node scripts/check-locales.mjs`（frontend 工作目录）：
  18 个语言包键/占位符检查通过；本次新增配置提示位于现有英文管理员页面。
- `npm run build`（frontend）：通过。保留已有的大 chunk 和动态 import 构建提示。
- `TZ=UTC npm test`（mcp）：95 个测试通过；`npm run check:node-loadable` 通过。
- 在 Chrome 中加载实际 AdminCoach 组件的本地 mock 页面，填写 endpoint/profile，
  确认提交的配置字段；1100px / 390px 布局无横向溢出，无页面 JS 错误。
  这是表单验收，不是真实 OpenClaw 或 iPhone 联调。
- Glass 工作区保持干净，只读取了文档与适配器源码。

## 初次接入的基线失败（已在上述集成复验修正）

全量 API：606 个测试，596 通过、10 失败（当时 OpenClaw 文件含 10 个测试）。
从上述改动前 commit 导出隔离副本后，以下五个测试文件复现完全相同的 10 个失败，
没有本次新增失败：

| 文件 | 失败数 | 现象 |
| --- | ---: | --- |
| `api/test/coach-limits.test.js` | 2 | 固定旧训练日期让 review 返回 nochange，断言期望 ready |
| `api/test/jobs.test.js` | 4 | 同样的旧日期导致待确认提案为空/nochange |
| `api/test/payload-bounds.test.js` | 2 | 固定历史超出 review 窗口，断言读取空 workouts |
| `api/test/payload.test.js` | 1 | review 窗口中没有固定旧训练 |
| `api/test/routes.test.js` | 1 | cohort/活跃训练数据断言依赖固定旧日期 |

MCP 默认使用本机 Asia/Shanghai 时，4 个既有断言失败：fixture 把时间固定为
`2026-07-27T12:00:00Z`，本地时间为 20:00，demoSeed 会生成当天已经完成的训练；
测试却预期当天尚未训练。相同源码在 UTC 全部通过。本次不修改训练逻辑或这些旧 fixture。

## 初次接入时未验证及 Linux 待完成（历史记录）

- Docker 默认镜像两次构建均在拉取 `node:22-alpine` 的元数据阶段失败：
  Docker Hub `auth.docker.io` TLS handshake timeout，尚未执行项目构建步骤。
  需要 Linux agent 重新构建/启动/健康检查默认 API 和 web 镜像。
- 没有连接或修改真实 Linux、OpenClaw、Tailscale 路由；没有远程 persona/MCP 的实测结果。
- 未执行真实模型 create/review/refine/debrief、工具隔离、长期记忆隔离或上游取消验收。
- 未进行 iPhone 配对和同步。之前构建的 IPA 已支持服务器配对和服务器 AI Coach；
  新 provider 在后端实现，无需为了添加手机端 LLM 配置而重新签名。
- Linux 完成情况应另写 `OPENCLAW_LINUX_RESULTS.md`，不能把本记录中的 mock 测试
  描述为真实模型/手机通过。
