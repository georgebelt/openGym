# Linux 实施与验收记录:openGym + OpenClaw gym-coach

> 下文是 Linux 各次部署的原始证据。当前集成状态及 main 升级步骤以
> [协作说明](OPENCLAW_COLLABORATION.md) 为准；§13 的 bridge 已部署，包含新 app/API
> 的 API/web 镜像和集成修复仍需随 main 升级。

日期:2026-10-18。实施方:Linux coding agent。基线交接分支 `codex/openclaw-gym-coach`
(`9d74d250`),工作分支 `codex/linux-gym-coach`。真实主机名/地址经私密渠道告知用户,
本文一律以 `<tailnet-host>` 代替;所有 token 存于 Linux 本机 0600 文件,未进 Git/日志/本文。

## 1. 环境与版本

- OpenClaw **2026.9.33**(宿主,gateway 127.0.0.1:18789);Docker 29.6.1 / Compose v5.3.0;宿主 Node 24(容器内按仓库 Dockerfile)。
- 模型:复用用户现有 Bedrock 配置,gym 双 agent 均为 `us.anthropic.claude-sonnet-5`。
- 服务清单:
  - compose 项目 `opengym`(`opengym-api-1`/`opengym-web-1`,本地 tag `opengym-api:linux`/`opengym-web:linux`)
  - systemd user 单元 `opengym-bridge`(宿主直跑,监听 127.0.0.1 与 opengym docker 网关 172.21.0.1 的 18890)
  - OpenClaw `mcp.servers.gym`(stdio,随 agent 需要被 gateway 拉起)
- 部署命令:`cd deploy/linux && docker compose up -d --build`;bridge 见 `deploy/linux/bridge/opengym-bridge.service` 头部注释。
- 回滚:`docker compose down`(数据保留在 /data/opengym);`tailscale serve --https=18445 off`;
  `systemctl --user disable --now opengym-bridge`;OpenClaw 侧 `openclaw agents delete gym-coach / gym-coach-proposal`、
  `openclaw mcp set gym` 移除、`openclaw config set` 还原各 agent 的 `tools.deny`(均热加载)。
- **既有服务健康确认**:配置变更与部署全程后,Glass 后端 `/api/v1/health` 返回
  `{"backend":"ok","openclaw":"ok"}`,18443/18444/18820/2283 等既有 tailscale serve 路由未改动。

## 2. 部署结构(与需求 §2 对应)

- web 只绑宿主回环 `127.0.0.1:18880`;对外入口 **tailscale serve `https://<tailnet-host>:18445`**(tailnet-only,未开 Funnel);API 不发布端口,仅经 web nginx 代理。
- `RP_ID=<tailnet-host>`,`ORIGIN=https://<tailnet-host>:18445`(实际值在本机 `deploy/linux/.env`,gitignored)。
- 数据:宿主 `/data/opengym/data`(独立、可整目录 tar 备份,与 Glass/OpenClaw 目录零交集);`coach-auth` 单独挂载不进备份。API 容器以 `user: 1000:1000` 运行,数据文件归宿主用户所有(宿主侧 MCP 只读可达)。
- 管理员账号已由用户建立(username georgebelt,**Account ID `R0e1jddEojjLXL6u`**),随后 `FIRST_USER_ADMIN=0` 已生效。CORS 预检经 18445 实测:204 + 单一 `Access-Control-Allow-Origin` 回显。

## 3. 阻塞报告与隔离方案(需求 §2"调用级权限控制")

**结论:OpenClaw 2026.9.33 不支持调用级(请求级)工具/记忆开关。** 源码核实:
chatCompletions 端点与普通聊天共用同一 agent run 路径(`docs/gateway/openai-http-api.md`:
"Requests run as a normal Gateway agent run");请求体 `tools`/`tool_choice:"none"` 只作用于
HTTP 客户端叠加的 function tools,不影响 agent 内部工具;工具策略(allow/deny)与记忆注入
均为 **agent 级** 配置;无任何 `x-openclaw-*` header 承载工具开关。

**采用的可执行隔离方案(本文即与 Mac 协调的提案,已实施)——双 agent,对外仍单 persona**:

- `gym-coach`(对话模式):workspace `~/.openclaw/workspace-gym`,`tools.allow: ["gym__*"]`
  → 工具面只剩本项目九个只读 MCP 工具。
- `gym-coach-proposal`(提案模式):workspace 仅含一个极简 SOUL,`tools.deny: ["*"]`(零工具)、
  `memory.search.enabled: false`、无 MEMORY.md/USER.md 可注入。
- **bridge 对 openGym 暴露的 persona 不变(`openclaw/gym-coach`)**,内部将 proposal 请求路由到
  `gym-coach-proposal`,并为每个 request ID 建独立 session `agent:gym-coach-proposal:opengym:<uuid>`,无默认会话 fallback。
- 其余全部 agent(main/butler/tutor/buddy/confidant/confidant-dad/glass)`tools.deny` 追加
  `"gym__*"`:训练数据工具只对 gym-coach 可见。此为 OpenClaw 全局配置中各 agent 条目的
  **纯增量 deny**(deny 只收窄,不改变这些 agent 的任何既有行为);未触碰 Glass 仓库、
  workspace、数据或 glass-backend 服务。

**隔离证据(可观察记录,非模型自述)**:

- `gym-coach-proposal` 全部真实提案运行的 transcript:**零 toolCall 事件**。
- `gym-coach` transcript:真实 `mcp:gym:gym__list_workouts` 调用及 MCP 原始返回
  ("no synced state yet…"),模型如实转述、未编造。
- `glass` 主动探针:`tool_search("gym")` 返回 `[]`,强行 `tool_call(gym__list_workouts)` 返回
  `Unknown tool id` —— 拒绝发生在工具机制层。
- 每请求新 session + 空 workspace ⇒ 无跨请求/跨 agent 记忆可注入;提案 payload 之外无数据来源。

## 4. gym bridge(需求 §C 合同)

实现:`deploy/linux/bridge/gym_bridge.py`(aiohttp 单文件,宿主 systemd)。要点:

- gateway token 只在 bridge 进程 env(0600);openGym 仅持独立生成的 bridge token。
- 固定单 persona + 单账号:错 token 401、错 profile 403、非 `openclaw/gym-coach` 的 model 403、非 proposal 模式 403;不透传任何调用方 header/工具声明。
- `x-opengym-request-id`(=body `user`)格式强校验;**幂等:成功与失败都缓存,同 ID 重放永不新开执行(实测 0ms 返回),同 ID 不同内容 409**;并发超限 429(上限 2)。
- 内部走 OpenClaw SSE 并聚合;对 openGym 恒为完整 JSON(`message.content` 字符串,`finish_reason` 透传含 `length`);非 2xx 为简短 JSON error,**上游错误正文不回显**;日志只记 request ID/状态/耗时。
- 超时 290s(与 openGym 300s 预算协调,留传输余量)→ 504;**客户端断开即取消**:
  修了一个实施中发现的真 bug——aiohttp 3.9+ 默认不随客户端断开取消 handler,显式
  `handler_cancellation=True` 后实测:断开 4.0s 时上游生成即停(`client_abort 4005ms`),重放同 ID 得缓存错误、不重跑。
- 单元/合同测试 **8/8**(`deploy/linux/bridge/test_gym_bridge.py`,假上游):认证矩阵、隔离路由断言(session key、不透传 `x-opengym-*`)、幂等/409、上游正文不泄漏、504、429。
- **容器内实测**(API 进程所在网络 → 172.21.0.1:18890):models 正确 auth 200 / 错 token 401 / 错 profile 403 / 其他 persona 路由 403。

## 5. 只读 MCP(需求 §D)

- 登记:`openclaw mcp add gym --command node --arg <repo>/mcp/src/index.js --env OPENGYM_DATA=/data/opengym/data --env OPENGYM_UID=R0e1jddEojjLXL6u --env TZ=Asia/Shanghai --include <九工具>`;probe 确认恰好 9 个工具,规范名 `gym__list_routines` 等(与各 agent 的 allow/deny glob 完全一致)。
- `OPENGYM_UID` 显式绑定(与 bridge/openGym profileUid 三处同值);数据目录为 API 持久化位置本身(原子写入对后续工具调用可见),宿主侧只读访问。
- 时区:MCP 的"今天/本周"按进程 TZ 计算,已显式 `TZ=Asia/Shanghai`。mcp 测试套 `TZ=UTC` **95/95**;`TZ=Asia/Shanghai` 5 个失败,均为测试 fixture 固定 UTC 时刻导致的既有伪差(与 Mac 验证记录同类),非部署问题。跨午夜行为依赖该 TZ 设置,已记录;真实跨午夜复核建议在手机数据同步后、北京时间 0 点前后各查一次 `get_week_plan`。
- 无同步数据时行为实测:工具明确返回"no synced state yet",agent 提示先同步,不伪造。

## 6. 真实模型验证(需求 §5-3/4)

走仓库生产代码路径(`payload.build` → `runPipeline`(含验证器与修复轮)→
`api/coach/adapters/openclaw.js` → 真实 bridge → 真实模型),合成中文用户状态,
脚本与脱敏结果入库:`deploy/linux/acceptance/`。

| 任务 | 结果 | 耗时 | 规模 | 修复轮 | 中文输出 | id 保真 |
|---|---|---|---|---|---|---|
| create | ✅ 验证器一次通过 | 149s | 2 天计划 | 未触发 | ✅ | 14 处全来自 library |
| review | ✅ | 117s | 3 天历史窗口 | 未触发 | ✅ | 6 处全对 |
| refine | ✅(首次 504 超时,重试 130s 过)| 426s 总 | 2 天 | 未触发 | ✅ | 13 处全对 |
| debrief | ✅ | 39s | 单次训练 | 未触发 | ✅ | — |

refine 语义正确("把周三改成拉力日"→ 周三换划船/弯举类,周一不动,summary 如实陈述)。
Admin Test 形状经全链路**精确**返回 `{"coach_contract":1,"ok":true}`(2.6s;用户 UI 的
List models/Test 亦经容器网络实测通过)。

**重要发现与解决(复验后更正)**:整周 create 最初多次失败,根因有二,均已定位:
① **输出 token 上限**——3 天计划 JSON 超过 16000 output tokens,`finish_reason=length`
被截断(一次 184s 跑完但被切);② 预算紧。处置:openGym 侧 `COACH_JOB_TIMEOUT_MS=480000`
(自带 env,下限 60s)+ bridge `GYM_UPSTREAM_TIMEOUT_S=470`(新增 env,默认仍 290),
**管理员需在 Admin → AI Coach 设 `maxOutputTokens=24000`**(bridge 硬上限 32000)。
复验:**3 天 create 在 24k tokens 下 211s 完整通过**(验证器一次过、中文、18 处 id 全对)。
剩余事实:提案耗时与输出规模近似成正比(39s→117s→211s),同请求方差大
(refine 首跑撞旧上限、重试 130s)。若想更快,可换更快模型(用户 Bedrock 账号内即可,
质量需另验)——由用户决定,Linux 未擅动。

修复轮真实样本:四任务均一次通过,修复轮未被真实触发(管线与单测已覆盖该路径,如实注明)。

## 7. 测试套件汇总(需求 §5-8)

- bridge 合同测试 **8/8**;api 套件 **597/607**(10 个失败与 Mac 验证记录的既有基线逐项一致,fixture 旧日期问题,非本分支引入);mcp **UTC 95/95**(Asia/Shanghai 5 个已知 fixture 伪差);容器 `docker compose ps` 健康、`/api/health` ok(经 18445 HTTPS 同样 ok)。

## 8. 验收项状态

| # | 项 | 状态 |
|---|---|---|
| 1 | 版本/服务/部署/回滚记录 + Glass/Tailscale 健康 | ✅ 本文 |
| 2 | 容器内 models + 真实 Admin Test + 三类拒绝 | ✅ |
| 3 | 真实模型四任务 + 中文(合同校验器) | ✅(含时延发现) |
| 4 | 并发/修复/隔离/取消 | ✅ 并发 429 与真实并发混跑、取消/超时实测终止上游、无记忆串入(§3 证据);修复轮未被真实触发(如实) |
| 5 | 用户建号 + 手机配对 | ✅(audit: pair.create/pair.ok) |
| 6 | 手机记录→同步→网页/MCP 可读 | ✅ 同步前 MCP 报无数据、同步后 gym-coach 真实读到该训练与已应用的周计划(读到新值) |
| 7 | iPhone 真实 Coach 请求/撤回/取消/第二账号拒绝 | 真实 create 已由用户**应用**、review 修复后连续 4 次成功;取消/撤回:产品无此入口,**不适用**(等价工程能力证据见 §13);第二账号拒绝的服务端等价已测(错误 profile 403) |
| 8 | 测试与部署验证 | ✅ |

## 9. openGym 管理配置(已由用户完成)

Admin → AI Coach:provider `openclaw`、Base URL `http://172.21.0.1:18890`、
profileUid `R0e1jddEojjLXL6u`、model `openclaw/gym-coach`;token 经管理员表单保存
(后端加密存储),未手写 coach.json。headers 字段在该 provider 下禁用(由 bridge 管理)。

## 10. 手机侧验收进展与真实事故记录(2026-10-18 追加)

- 手机配对 ✅(audit:pair.create/pair.ok)、数据同步 ✅(state-<uid>.json 落盘)、
  **真实 create 提案 ✅ 且已被用户应用**(coach history:ready → applied)。
- **真实事故:review 失败 `unusable`**。根因:模型在 `reading` 字符串里写了未转义的
  英文双引号(引用用户那条"自由训练"记录的名字),两轮(首轮还带 markdown 围栏)
  均为非法 JSON,修复轮未能纠正。合成测试未踩中(数据里没有诱发引号的名字)。
- 处置(Linux 职权内,未改 api/):`gym-proposal-soul v1.1` 加 JSON 合法性硬规则
  (字符串值内禁英文双引号,引用名称用「」,输出前自检可被 JSON.parse)。
  回归:用"自由训练"诱发场景经真实模型复测 **3/3 合法 JSON**(全部改用「」)。
- 给 Mac 的上游观察(非 Linux 修改):① 首轮 markdown 围栏 + 内嵌引号时,
  `extractJSON` 的错误串只有 "the answer was not JSON",修复轮喂回后模型重复同错;
  若 repair 提示能指出"字符串内未转义引号"类具体位置,修复成功率应更高。
  ② 可考虑 extractJSON 容忍 ```json 围栏剥离。均为建议,由 Mac 侧决定。

## 11. 使用说明备注(给 Mac 的产品观察)

用户实测反馈"Coach 有点傻":实为把 review 的备注当聊天用(问动作教学/示范视频)。
提案引擎按设计零工具零记忆、输出受合同约束,只能答"基于数据的计划调整";
自由问答的入口是 OpenClaw 对话模式的 gym-coach(带只读 MCP)。建议 Mac 评估在
app 文案/空数据 review 的提示里引导这两种用途的分工;Linux 侧不改 api/web。

## 12. L1 收口:验收脚本对齐生产 fetch(2026-10-18 追加)

- `coach_real_model.mjs` 已注入生产同款 `fetchFor(TIMEOUT_MS)`(api/coach/node-fetch.js),
  `TIMEOUT_MS` 默认改 480000(=本机 COACH_JOB_TIMEOUT_MS);旧 290/300s 注释已更正为
  "bridge 默认 290s / 本机部署 470s"。确认此前"重试在 300.0s 被断"正是 Node 全局 fetch
  (undici)的 ~300s 响应头硬超时,属于脚本与生产不一致,生产 jobs.js 本就用 fetchFor。
- 传输验收 `deploy/linux/acceptance/fetch_budget_check.mjs`(独立端口 18899 假上游,
  不占生产 bridge 18890、不消耗真实模型),`node fetch_budget_check.mjs` 全量结果 **PASS**:
  - A 响应头延迟 310s(>300s、<480s 预算)→ 正常完成,310.0s 收到合法 JSON;
  - B 延迟 75s、预算 60s(fetchFor 下限)→ 60.0s adapter 超时,假上游观察到连接在
    应答前被关闭(终止,非悬挂);
  - C 主动 AbortController 取消@3s → 3.0s 终止,上游连接同样确认关闭。
  (FAST=1 冒烟模式亦 PASS,供快速回归。)
- 当前部署配置:**openGym API `COACH_JOB_TIMEOUT_MS=480000`,bridge
  `GYM_UPSTREAM_TIMEOUT_S=470`(默认 290)**。Mac 本轮测试结果见
  OPENCLAW_MAC_VALIDATION.md(fixture 日历化后 api 全绿、CI 双时区)。
- 升级部署 SHA 将在 main 合并后的部署窗口补记(Git 合并与服务器部署分离)。

## 13. 普通对话 v1 已实现并部署(2026-10-19,合同 OPENCLAW_CHAT_CONTRACT.md)

- **端点**:`GET /v1/gym/capabilities` → `{"chat_contract":1,"chat":true}`;
  `POST /v1/gym/chat`(鉴权/profile 绑定同 proposal,另要求 `x-opengym-coach-mode: chat`
  与 `x-opengym-request-id`=body `request_id`)。proposal 协议未动。
- **会话**:bridge 由绑定 profile + `conversation_id` 派生稳定 session
  `agent:gym-coach:opengym:gymchat-<uuid>`,只路由 `gym-coach`(九个只读 MCP 工具,
  与 proposal 的隔离孪生、Glass、其他 profile 零交集);只发当前消息,连续性由
  OpenClaw session 承担;`proposal_context` 以"资料非指令"包装注入,
  resolved 以 summary 的 accepted/rejected/dismissed 为准。
- **去重**:profile+request_id+正文哈希;完成/失败都持久化(`/data/opengym-bridge/`
  0700,保留 400≥200 条,不进通用日志);重启时 running→failed(interrupted),
  不自动重放;同 ID 不同正文 409;单会话同时一条普通消息(第二条 409),
  与 proposal 共享全局并发 2。超限 429;400/401/403/409/429/502/504 全为通用 error。
  截断(finish=length)与超长(>32000 字符)一律按错误返回,不冒充完整回答。
- **persona**:`gym-coach-soul v1.1`——app 内同一教练语义、普通消息不改计划、
  引导同屏"生成计划建议"(不提 persona 切换)、proposal_context 的 pending/resolved
  区分、绝不声称草稿已应用。已部署到 workspace。
- **测试**:bridge 套件 **14/14**(新增 7 条:能力探测、校验矩阵、稳定 session 与
  跨会话隔离+资料注入断言、去重/409/跨实例持久化、中断=failed 不重放、
  单会话串行+双通道并发、截断=错误)。
- **真实验收**(经真实 OpenClaw + Bedrock + 已同步数据):
  - 中文对话真 MCP 读取:准确答出 2026-10-18"自由训练"、0 动作、时长 37 秒(38.4s);
  - **续聊**:同会话第二问"刚才那次持续多久"直接答 36979 毫秒(2.9s,未重查)——
    稳定 session 生效;
  - 去重重放 0ms 返回原回答;3.0s 断连 → `chat_client_abort`(上游生成即停);
    chat 断连同时一条 proposal 并发完成(200,3.6s)。
- **容器**:本轮未改 api/web 镜像,构建与健康检查沿用 §1/§7 的通过记录。
- **取消/撤回定论**:产品无此入口,不适用;等价能力证据=传输终止(§12+本节断连)、
  job 清理与 consent 门(api/test/jobs.test.js)、绑定拒绝(403)。
- 部署 SHA 见本提交(bridge 以此提交重启运行);token/会话/训练内容未入库。
- **端点面审计(用户要求)**:bridge 仅 5 条路由——`/v1/models`(Admin List models)、
  `/v1/chat/completions`(提案)、`/v1/gym/capabilities`+`/v1/gym/chat`(对话 v1)、
  `/health`(运维探针,回环+docker 私网)。无任何为"取消/撤回"等不适用场景预留的端点;
  终止语义由连接断开承担。
- **请 Mac 顺手清理**:`OPENCLAW_COLLABORATION.md` 中 L1/L2 的过程分析(问题复现、
  CoachChat 无取消按钮的论证等)已完成历史使命,建议下轮集成时收敛为一行结论,
  与本文档的清理保持一致(用户要求减少过程性内容)。

## 14. main 合并后的生产部署(2026-10-19)

- PR #1 已由 Mac 合入 main(`c6a4cd3d`)。Mac 集成前对 bridge 做的加固
  (profile 限定去重账本+损坏拒启、未知字段拒绝、流中 1MiB/32k 强制、
  坏块/工具调用/不完整流一律错误、会话键加 profile)已审查采纳,
  本地测试 **23/23**(含 Mac 新增 9 条)。
- 部署窗口执行:数据已 tar 备份(~/Backups/opengym/);容器以 main 内容
  重建(含新 CoachChat 前端),`/api/health` ok、18445 入口 200;
  bridge 以合并提交重启,capabilities ok,真实中文聊天经 MCP 读到当前周计划。
- **实际部署 SHA:分支合并提交 `c6a4cd3d`(= main `c6a4cd3d` + Linux 验收历史)。**

## 15. 真机复现:聊天门控不一致 + 兜底占位符误导(交 Mac,frontend)

用户在新 IPA(含 3bbc4dfd 文案)上把聊天输入当聊天用,实际全部变成 review。
服务端证据(2026-10-20):40h 内手机 UA 对 `GET /api/coach/chat` 零请求;用户在
"给教练留言…"框发送"测试" → `POST /api/coach/review 202`(12:39:32)→ 70s
nochange(history `trigger:"manual"`);期间 `/api/coach/status` 以 3-4s 快轮询。

代码定位(均 frontend/,Mac 辖区):
1. **门控不一致**:`coach-api.js:35` `LOCAL = MOBILE && mode==='byok'`(提案:非 byok
   即走服务器);`CoachChat.jsx:63` `chatEligible` 却要求 `coachMode === 'server'`
   严格相等 → 手机 Coach 模式未显式设为 server 时,落入"提案可用、聊天关闭"缝隙。
2. **兜底占位符误导**:`CoachChat.jsx:231` 占位符链的最后分支(非 chatEligible、
   无 pending create、无 job)为 `'Message the Coach…'`(中文"给教练留言…"),
   但该状态下的提交路径是 review——界面承诺聊天、行为是提案。
建议:两处用同一谓词;非聊天态占位符用 'What should change?' 或禁用聊天语义文案。
服务端(bridge/API 路由/部署)经核无问题;聊天链路真实验收见 §13。
