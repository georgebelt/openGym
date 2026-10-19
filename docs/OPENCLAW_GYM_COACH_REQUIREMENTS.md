# Linux 交接：openGym + OpenClaw gym-coach

本文保留最初给 Linux coding agent 的实施需求。当前部署及实测情况见
[Linux 验收记录](OPENCLAW_LINUX_RESULTS.md)；双方工作范围、集成流程和剩余任务以
[Mac / Linux 分工与交接](OPENCLAW_COLLABORATION.md) 为准。

## 1. 已确认的目标和边界

- 用户确认：openGym 后端放在现有 OpenClaw 所在的 Linux 服务器；iPhone 经 Tailscale
  配对、同步训练数据；AI Coach 和只读 MCP 都接通。
- 基线仓库：`https://github.com/georgebelt/openGym`，交接分支
  `codex/openclaw-gym-coach`。从该分支新建 Linux 工作分支，提交部署代码和验收记录，
  推回 GitHub 供 Mac 侧审阅。不要重置或强推共享分支。
- 可读取 Glass 项目作为参考，**不可修改 Glass 仓库、persona 工作区、数据或服务配置**。
  不复用 Glass 的 persona、token、会话、记忆目录或对外入口。
- Linux coding agent 是实施者；`gym-coach` 是产品中的 OpenClaw persona，二者不同。
- 保留已有 OpenClaw 和 Tailscale 服务。先检查本机现状，再添加独立服务/路由。
  网络、DNS、证书、端口或 ACL 有冲突时向用户确认；不要覆盖现有配置来绕过问题。
- Mac 通过 Git 交接；不 SSH 操作 Linux。真实主机名、账号 ID、密钥和私有路径
  不提交到这个公开 fork。本文的域名、端口和路径均为示例。

## 2. 部署结构

```text
iPhone openGym ── Tailscale + HTTPS ── openGym web/API ── gym bridge
                                         │                  │
                                  独立持久化 data/          本机 OpenClaw gateway
                                         │                  │
                              只读 MCP stdio ─────── gym-coach persona
```

区分两种调用：

1. **openGym AI Coach 提案**：create/review/refine/debrief。后端构建已经取得同意的
   数据白名单，调用 bridge；persona 返回 `coach_contract: 1` JSON；openGym 校验，
   最多修复一次，用户确认后由应用执行更改。
2. **在 OpenClaw 中与 gym-coach 对话**：persona 可调用该账号的只读 MCP，
   查询已同步的训练记录、计划和体重。自然语言问题正常回答，不强制每次都生成计划 JSON。

提案调用必须隔离记忆并禁用工具，不能额外读取 MCP/文件来绕过 openGym 的数据披露窗口。
MCP 接入供第二种调用使用。不能仅靠一句 persona 提示词禁用工具：bridge 要使用
当前 OpenClaw 版本真实支持的调用级权限控制；若做不到，先报告这个阻塞，提出可执行的
隔离方案并与 Mac 侧协调，不要悄悄扩大提案的数据范围。

## 3. Linux coding agent 要实现的内容

### A. 部署这个 fork 的后端和网页

- 使用 Node 22 / Docker，构建本分支的源码。`api` 用默认 target 即可，
  不需要 Claude Agent SDK、Codex CLI 或 `API_TARGET=coach`。
- `docker compose up -d --build` 可以构建源码，但现有 compose 使用上游 image 名；
  请在自己的部署文件中使用独立的本地 image tag，避免以后 `pull` 换回上游镜像。
- openGym 使用独立的可备份 data 目录，不能指向 Glass/OpenClaw 的目录。
- web 只绑定宿主机回环或受控私网；通过 Tailscale HTTPS Serve/现有反向代理提供
  新入口。不要开启 Funnel/公网暴露。不要直接发布 API 端口。
- 核实 `RP_ID` 为最终 HTTPS 主机名（不含端口），`ORIGIN` 为完整 origin（含非标准端口）。
  配置示例，需先确认主机名、端口可用：

  ```dotenv
  RP_ID=gym-host.example-tailnet.ts.net
  ORIGIN=https://gym-host.example-tailnet.ts.net:18445
  WEB_PORT=127.0.0.1:18880
  DEFAULT_LANG=zh
  FIRST_USER_ADMIN=1
  ```

- 用户建立首个管理员账号后再开启邀请限制；不要把邀请码/密码放进交接记录。
- 代理必须保留 `/api/*`、手机配对 Bearer token、正常 CORS 和长任务连接。
  以 [SELF_HOSTING.md](SELF_HOSTING.md) 和 [MOBILE.md](MOBILE.md) 为准。
- 容器中的 `127.0.0.1` 是容器自己。必须实测 **API 进程所在网络**能访问 bridge。
  可选择 bridge 与 API 的私有容器网络；若 bridge 在宿主机上，则设置明确的私有访问路径。
  不为图省事把 OpenClaw gateway 暴露到公网。

### B. 建立独立 gym-coach persona

- 检查已安装 OpenClaw 版本、persona 注册方式、模型提供商和 MCP 客户端能力。
  复用用户现有 LLM 配置；不要替用户切换付费服务或模型。
- 新建 `gym-coach` agent 和独立 workspace。正常路由为 `openclaw/gym-coach`。
  不使用 `main`、`glass` 或它们的默认 session。
- 主要用中文沟通；提案按 payload 的语言输出。保留 exercise ID、routine ID、
  单位和 JSON 字段名，不能把标识符翻译成中文。
- 训练建议以用户目标、器材、训练历史和恢复为依据；不编造日志、负重或完成情况；
  受伤/疼痛时给出适当的停止训练、就医建议，不诊断或开药。
- 区分提案模式与普通对话模式。提案模式遵守请求的系统规则与当前合同；
  普通对话只有用户请求设计/调整计划时才进入对应流程。
- 提案模式不注入其他会话的长期记忆，不读写 `MEMORY.md`，不使用 shell、
  文件工具、消息工具或自动化。不自动修改 openGym 数据。
- 普通对话只授予本项目列出的 MCP 查询工具。需要保存的个人训练记忆也必须在
  gym 专属空间，不能共享到 Glass/main，且不应被自动注入独立的提案请求。

### C. 实现受限 gym bridge

可以采用现有 Linux 技术栈，但它是**独立服务**。不需要修改 Glass backend。
Glass 的参考协议是 bearer + `/v1/chat/completions` + `model: openclaw/<agent>`
+ `x-openclaw-session-key`，内部可用 SSE。部署时须用当前 OpenClaw 实测确认。

安全/身份边界：

- bridge 持有 OpenClaw gateway token；openGym 后端仅保存独立生成的 gym bridge token。
  token 存在 Linux secret/env 文件，权限 0600；不进 Git、日志、模型上下文或 HTTP 错误。
- bridge 固定允许一个 persona 和一个 openGym 账号 ID。body `model`、profile header
  与配置不符时直接 403；缺少/错误 bearer 时 401。绝不允许转发到其他 agent。
- 不透传调用者的 `x-openclaw-*`、任意 headers、工具声明或路由参数。
- 所有响应是完整 JSON；不对 openGym 输出 SSE、工具调用、中间思考或 reasoning。
- 原始模型请求/训练数据不写常规访问日志。必要排错只记 request ID、状态、耗时。
- Linux 实现中添加单元测试和真实模型冒烟测试；将无法验证的行为列出，不伪称通过。

#### 必须实现的 HTTP 合同

基础 URL 可含 `/v1`，openGym 不会重复拼接版本。

`GET /v1/models`

```http
Authorization: Bearer <gym-bridge-token>
x-opengym-profile-id: <configured-account-id>
```

成功响应：

```json
{"object":"list","data":[{"id":"openclaw/gym-coach","object":"model"}]}
```

只列出该 bridge 实际允许的 persona。最好检测 gateway/agent 可用性；
此接口不应触发一次模型生成或访问训练数据。

`POST /v1/chat/completions`

```http
Authorization: Bearer <gym-bridge-token>
Content-Type: application/json
x-opengym-profile-id: <configured-account-id>
x-opengym-request-id: opengym-<uuid>
x-opengym-coach-mode: proposal
```

```json
{
  "model": "openclaw/gym-coach",
  "stream": false,
  "user": "opengym-<same-uuid>",
  "messages": [
    {"role":"system","content":"openGym safety rules + task-specific contract"},
    {"role":"user","content":"current allowlisted payload, or repair context"}
  ],
  "max_tokens": 16000
}
```

- request ID 格式为 `opengym-` + UUID；header 与 `user` 必须相同。
  **每次调用/修复都有新 ID**。它不是长期用户 ID。
- bridge 按经过验证的 ID 创建会话，如
  `agent:gym-coach:opengym:<uuid>`，并用当前 OpenClaw 正确的 session 路由机制设置。
  不允许 fallback 到默认会话，不使用固定的 `x-openclaw-session-key`。
- 该请求不带 `response_format`；完整结构要求已包含在 system/task prompt。
  如 OpenClaw 对 system role 或 token 参数有限制，bridge 负责可靠转换；
  不能静默丢弃任务规则或截断 payload。
- 仅处理提案模式；限制消息数、请求大小（建议不低于 1 MiB 以容纳序列化 prompt）、
  token 上限和并发。上限要覆盖本仓库 `MAX_PAYLOAD_CHARS` 及额外的 system prompt。
- 可在内部用 OpenClaw SSE 并聚合最终 assistant 文本；成功返回：

  ```json
  {
    "id":"opengym-<uuid>",
    "object":"chat.completion",
    "choices":[{"index":0,"message":{"role":"assistant","content":"{\"coach_contract\":1,...}"},"finish_reason":"stop"}]
  }
  ```

- `message.content` 必须是字符串。模型达到输出上限时 `finish_reason: "length"`；
  不把半截 JSON 当成功计划。客户端限制响应体 1 MiB。
- 非 2xx 使用简短无敏感内容的 JSON error。401/403/429/502/503/504 区分失败类别。
  openGym 不自动重试传输失败；不能由 bridge 静默重跑有状态的 agent。
- openGym 默认模型调用预算 5 分钟；Admin Test 90 秒；List models 20 秒。
  bridge、gateway、代理 timeout 与之协调。客户端断开/取消时必须关闭上游流，
  包括上游已经发 header 但长时间没有 token 的情况。
- request ID 可用于阻止重复执行。同 ID、不同内容拒绝；同 ID 的重放不能新开一次执行。
- Admin Test 同样是 proposal 模式，要求精确返回
  `{"coach_contract":1,"ok":true}`，不能调用 MCP 或写长期记忆。

### D. 配置只读 MCP

本仓库 MCP 是 **stdio**，直接读取后端 data 目录；没有现成的远程 HTTP MCP endpoint。
在同一台 Linux 运行它即可，不需要给 iPhone 开 MCP 端口。

```sh
cd /path/to/openGym/mcp
npm ci
OPENGYM_DATA=/path/to/opengym-data OPENGYM_UID=<account-id> node src/index.js
```

上面只是手动启动形状。使用当前 OpenClaw 真正支持的 MCP/client/plugin 机制登记
command、args、env；先确认版本，不臆造 `openclaw.json` 的配置字段。

- `OPENGYM_UID` 必须显式设置，并与 bridge/profileUid 相同，不依赖“只有一个账号”的猜测。
- API 与 MCP 的日期计算需使用与用户训练日一致的时区（例如 `TZ=Asia/Shanghai`）；
  记录实际设置，并验证跨午夜的“今天/本周”。测试套件的 UTC 固定时间不是部署时区要求。
- `OPENGYM_DATA` 指向 API 持久化 data 的宿主机位置，权限只读；不要复制一次快照
  后就停止更新。API 的原子写入必须对后续工具调用可见。
- 最小文件访问范围为该账号的 `state-<uid>.json`，以及启动所需的用户元信息。
  若现有 stdio 实现读 `db.json`，限制运行身份，不能给 persona 任意文件访问能力；
  可提供经过裁剪、持续更新的用户元信息视图。不要把 token/secret 挂给模型的文件工具。
- 允许的九个工具：`list_routines`、`get_routine`、`preview_session`、`get_week_plan`、
  `list_workouts`、`get_workout`、`get_bodyweight`、`estimate_1rm`、`muscle_balance`。
- 不添加训练数据写入、删改计划、代替用户确认等工具。建议仍由 openGym 提案→确认应用。
- MCP 对话属于用户主动授予的训练数据访问；工具可能读取完整历史，不能说成只访问
  AI Coach 提案中披露的近期窗口。无同步数据时明确提示先同步，不能伪造成功结果。

## 4. openGym 端已有实现与配置

本分支实现：

- server-only provider `openclaw`，无新依赖，默认 API image 即可运行。
- Admin 表单：bridge Base URL、MCP profile ID、专用 token、persona、
  List models、Test。默认 persona 为 `openclaw/gym-coach`。
- `POST /api/admin/coach/config` 的示例 patch：

  ```json
  {
    "provider": "openclaw",
    "baseUrl": "http://gym-bridge:18890",
    "profileUid": "<account-id>",
    "model": "openclaw/gym-coach"
  }
  ```

- token 通过现有管理员连接表单保存，仍由后端加密；不要手写明文 `coach.json`。
- 绑定缺失/其他账号/`authMode: profile` 均拒绝调用。v1 只支持显式单账号；
  将来多账号需独立 persona/工作区/MCP/凭证的映射，不能只删掉这个检查。
- 额外静态 headers 在此 provider 禁用，会话由 bridge 负责。
- 保留现有同意、额度、JSON 校验、一次修复、待确认提案、应用和回退流程。
- 不需要在 iPhone 配置 OpenClaw token 或安装 MCP。手机选“连接我的服务器”，
  在 AI Coach 设置中使用已配对的自托管服务器。

## 5. 联调与验收

Linux agent 完成以下项目并留下脱敏证据：

1. 记录 fork commit、OpenClaw 版本、所用模型、服务名称、部署/回滚命令；
   确认 Glass 与既有 Tailscale 路由仍健康。
2. 从 API 容器内部测试 bridge `/v1/models` 和真实 Admin Test。
   错误 token、错误 profile、其他 persona 路由必须拒绝。
3. 真实模型验证 create/review/refine/debrief 和中文输出；使用本仓库
   `api/coach/core` 的合同/验证器，不仅检查“能聊天”。
4. 验证并发请求、修复请求、旧 session 和 Glass 记忆不能串入新提案。
   用可观察的工具调用记录证明 proposal 模式没有 MCP/文件/记忆工具调用；
   用独立传输脚本验证超时及主动取消信号能终止上游生成，不重跑。
5. 用户在 Tailscale HTTPS 页面创建账号，记下 Account ID，保持原主机名；
   先导出手机本地训练数据作为备份，再从浏览器生成五分钟配对码，手机连接。
   按应用的现有迁移/合并提示操作，不直接覆盖 state 文件。
6. 手机记录一条测试训练/体重并同步；网页可见；gym-coach 通过 MCP 可读；
   更新后再次查询能读到新值。离线手机未同步的数据不应声称可见。
7. iPhone 运行一次真实 Coach 请求，看到有效提案并由用户决定是否应用；
   验证未绑定的第二个账号拒绝、错误配置提示。
   授权检查及任务清理由 fixture/API 自动化验证。2026-10-19 范围修正：
   当前 app 没有单次取消或撤回授权入口，对应手机步骤不适用；
   不为完成测试新增按钮/接口，不要求用户重置数据或安装新版 IPA。
   手机端测试需要用户操作时明确给步骤，不能把后端 mock 当成手机实测。
8. Linux 跑 `api`、MCP 相关测试、部署配置验证与容器启动/健康检查；
   在同一 fork 的工作分支提交部署实现及 `docs/OPENCLAW_LINUX_RESULTS.md`。

回传内容：可供用户使用的 openGym HTTPS 地址（通过私密渠道告知真实地址）、
管理员配置步骤、账号绑定状态、完成的验收项、未完成项及原因、commit、
相关服务健康结果和回滚步骤。**不要回传密钥或真实训练内容。**

## 6. 建议实施顺序

先部署 web/API 并验证 Tailscale、账号和手机同步；然后添加独立 persona 与只读 MCP；
再实现受限 bridge、配置本分支 provider；最后做真实模型和手机验收。
可以在账号建立前开发 bridge，并用测试 fixture 做合同测试，但启用真实数据前必须完成
三处相同的 profile ID 绑定。若 OpenClaw 权限/会话机制不满足合同，先向用户/协作者说明
具体版本和限制，提交兼容方案；不要修改 Glass 或绕过数据隔离。

Mac 侧已完成的检查及当前基线问题见 [OPENCLAW_MAC_VALIDATION.md](OPENCLAW_MAC_VALIDATION.md)。
