# OpenClaw 接入：Mac 验证记录

日期：2026-10-18。改动前基线：`0299cf5c41268b1715ac0374533f779377911119`。
环境：macOS、Node 22.23.1；主机时区 Asia/Shanghai。

## 已通过

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

## 基线已有失败

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

## 未验证及 Linux 待完成

- Docker 默认镜像两次构建均在拉取 `node:22-alpine` 的元数据阶段失败：
  Docker Hub `auth.docker.io` TLS handshake timeout，尚未执行项目构建步骤。
  需要 Linux agent 重新构建/启动/健康检查默认 API 和 web 镜像。
- 没有连接或修改真实 Linux、OpenClaw、Tailscale 路由；没有远程 persona/MCP 的实测结果。
- 未执行真实模型 create/review/refine/debrief、工具隔离、长期记忆隔离或上游取消验收。
- 未进行 iPhone 配对和同步。之前构建的 IPA 已支持服务器配对和服务器 AI Coach；
  新 provider 在后端实现，无需为了添加手机端 LLM 配置而重新签名。
- Linux 完成情况应另写 `OPENCLAW_LINUX_RESULTS.md`，不能把本记录中的 mock 测试
  描述为真实模型/手机通过。
