# OpenClaw 接入：Mac 验证记录

日期：2026-10-18。改动前基线：`0299cf5c41268b1715ac0374533f779377911119`。
环境：macOS、Node 22.23.1；主机时区 Asia/Shanghai。

## 2026-10-19：Linux 部署记录复核

已审查 Linux `10c18609`：相对 main `c6a4cd3d` 仅新增部署验收记录，运行代码、
客户端和构建脚本均未变化，无代码合并阻塞。Linux 报告已部署 `c6a4cd3d`，重建
API/web、重启 bridge，23/23 测试及真实中文聊天/MCP 读取通过，见 Linux 记录 §14。
本次同步文档中的部署状态；沿用下方已完成的代码验证，不重复全量测试。
Mac 本轮未操作 Linux 服务，也未重新构建 IPA；下一步是用户真机联调。

## 2026-10-19：Linux 集成与 main 合并检查

Linux 分支 `a062b655` 已合入集成分支。反馈已处理：协作文档改为当前分工、完成状态、
部署步骤；删除 L1/L2 的重复过程论证。手机取消/撤回范围只保留一处结论。

集成修复：恢复被同名函数覆盖的提案校验测试；拒绝额外路由字段和错误上下文类型；
聊天缓存键及 OpenClaw 会话键绑定 profile；不完整/非最终 SSE 回复按失败处理；
缓存文件使用 0600、损坏时停止而非清空、运行中记录不被淘汰。旧版无 profile 的
缓存请求不重放，升级说明已写入协作文档。新测试先复现 6 个失败，修复后通过。

| 本机检查 | 结果 |
| --- | --- |
| API `npm test` | 618/618 |
| 前端 `TZ=Asia/Shanghai npm test -- --maxWorkers=4` | 403 文件，5069/5069 |
| MCP `TZ=UTC` / `TZ=Asia/Shanghai npm test` | 两次各 95/95 |
| bridge `python -m pytest -q deploy/linux/bridge/test_gym_bridge.py` | 23/23 |
| `api/test/gym-bridge-integration.mjs` | 真实 Node handler/adapter → Python bridge → 假 SSE gateway，通过 |
| API/Coach 生成文件、18 locale/源码翻译键、API/MCP Node 可加载性、diff | 通过 |

跨运行时检查覆盖绑定、首次同意、对话/去重、稳定会话、pending/resolved 引用与选择、
独立提案通道。已纳入 GitHub Tests 工作流；未来 bridge 单独改动也会触发检查。
Mac Python 3.14 的验证环境为 aiohttp 3.14.5、pytest 9.1.1、pytest-asyncio 1.4.0。
前端全量有既有 MaxListenersExceededWarning，无失败。

GitHub Actions 本轮复核仍因账户 billing 锁定而未运行，以上均为本机结果。
Linux 真实模型/MCP 证据保留在 Linux 报告；main 的 API/web 镜像及本次 bridge 修复
需由 Linux 升级后记录运行结果。客户端源码未变，继续使用下方 486e4b88 IPA。

以下为此前实现和 IPA 的验证记录。


## 2026-10-19：统一对话 app/API

本轮按用户授权新增实际产品功能，不增加仅用于验收的取消/撤回入口。
Linux 合同在实现之前以 `faee2e8f` 推到集成分支，见 `OPENCLAW_CHAT_CONTRACT.md`。

- API 全量 **617/617** 通过。新增 10 项 conversation 测试，使用真实本地 HTTP 假 bridge：
  鉴权/profile 拒绝、首次说明同意、稳定会话/服务端 ID、相同请求去重和共享额度、
  routing/context 注入拒绝、普通消息与提案并发、pending/resolved 引用与选择、旧 bridge
  回退、非法回复/跨会话输出拒绝、重启不重放、清理后迟到回复不恢复。
- 前端 `TZ=Asia/Shanghai npm test -- --maxWorkers=4`：**403 文件，5069/5069** 通过。
  新增 8 项测试覆盖普通消息不触发计划、免问卷聊天、提案期间聊天、编辑后确认生成、
  断线重试/重进页面保留相同 ID、旧 bridge 不误路由、切换账号拒绝迟到结果、补资料保留要求。
  Vitest 全量运行有一次 MaxListenersExceededWarning；未发生测试失败。
- 实际 CoachChat 组件在 Chrome 的本地 HTTP mock 页面通过：首次说明同意 → 中文聊天 →
  编辑要求 → 生成卡 → 导入到真实客户端 store → 继续聊天；320/390px 无横向溢出、无
  JS 页面错误。修正了滚动位置，最后一条回复完整位于输入框上方。
  此项是 UI + 模拟 API 验收，不是真实模型、MCP 或 iPhone 实机验收。
- 18 locale 包、2269 keys、1781 个源码翻译字符串检查通过；pt-BR 明确提供新增译文，
  保留既有继承快照。API 文档已重生成，72 端点/31 schemas；Coach assets 无漂移。
- 新建 `data/coach-chat/` 存放后端会话，权限目录 0700 / 文件 0600；最多保留 200 条
  用于去重，app 显示最近 40 条。忘记/重置/删除账号清理后端记录并中止普通请求。
  OpenClaw/LLM 服务商端历史保留仍由 Linux 管理；未声称清理它们。

- 后续补充大提案截断边界：先保留用户的 accepted/rejected/dismissed 决定，再截断计划内容。
  `node --test api/test/chat.test.js` 最终 **11/11** 通过（上述全量 617 项之后新增 1 项）。
- Web 生产构建、mobile 生产构建、Capacitor sync、Xcode Release device archive 均通过。
  第一次重复构建遇到 CocoaPods clean 拒绝旧 `ios/App/build`；已保留旧归档到 output，
  并将脚本 archivePath 改为 `output/App.xcarchive`，第二次构建成功。
- 新 IPA：`frontend/ios/App/output/openGym-1.4.1-26-486e4b88-unsigned.ipa`，
  **209,916,344 bytes**；版本 1.4.1，build 26，源码标识 486e4b88。
  SHA-256：`3de2d420b936dfd5003822341bd89e54dea17badca47fe8b4ac2d77705d48896`。
  已核对 ZIP CRC、Info.plist、App 可执行文件、普通对话路由确实打入 JS，且未签名。
  后续提案摘要边界修复只影响 Linux 后端，不需要重打客户端。
  IPA 为本机产物，不提交 200 MB 二进制到 Git；用户按既有 LocalDevVPN 流程签名安装。

仍需 Linux 实现/部署新 bridge 合同，并验证真实模型、只读 MCP 和容器；再用新版 IPA
做真实设备联调。GitHub Actions 的账户 billing 锁定仍属既有外部限制，本轮未变更账户。


## Linux 增量审查（2026-10-19）

- 已在 Mac 集成分支 fast-forward 合入 Linux `af98b466`，新增内容仅为
  `deploy/linux/acceptance/` 两个脚本及 Linux 验收记录。
- 确认真实模型验收脚本注入 `fetchFor(TIMEOUT_MS)`，默认预算为 480000ms，
  与生产 job runner 一致。
- Mac 执行 `FAST=1 node deploy/linux/acceptance/fetch_budget_check.mjs`：**PASS**。
  假上游延迟 8 秒成功，60 秒预算耗尽后连接关闭，3 秒主动取消后连接关闭。
  310 秒长等待由 Linux 执行并记录；本次 Mac 没有重复该项。
- 对当前 app 及已打包 IPA 的源码基线核对发现：没有单次请求取消或授权撤回入口。
  设置里的“在此手机上关闭教练”不能作为服务器授权撤回；后端 `forget` 仅清理任务
  记录，也不独立修改已同步的 consent。用户随后明确不增加只为测试而存在的功能：
  取消此前 M1“补入口并重打 IPA”的必做安排，手机 L2 记为不适用，不阻塞集成；
  保留底层取消、清理和授权检查的测试，详见 [协作交接](OPENCLAW_COLLABORATION.md)。
- 范围修正后定向重跑 `api/test/jobs.test.js` 中的三项既有测试：无 consent 不入队、
  运行中清理终止调用并释放任务、排队期间 consent 消失不发送 payload，**3/3 通过**。
  未添加产品功能或新的测试专用接口。

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
