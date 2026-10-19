# 普通对话 v1：Linux 下一步可直接实施的合同

2026-10-19，用户已授权实施。先合入 `origin/codex/opengym-integration`，然后在
`codex/linux-gym-coach` 继续工作。不要等 Mac UI 完成再开始。双方工作范围仍按
[协作说明](OPENCLAW_COLLABORATION.md)；交互按[一个教练，一个连续对话](OPENCLAW_COACH_UX.md)。

## Linux 本轮任务（只改 deploy/linux 和 Linux 运行环境）

1. 为现有 bridge 实现下面两个端点；保留现有 proposal 协议不变。
2. 更新 `gym-coach` 提示：这是 app 中同一个教练的对话，普通消息不直接改计划。
   用户要生成/修改计划时，引导同屏“生成计划建议”操作，不提 persona 切换。
   根据每次请求的 `proposal_context` 区分待确认、已处理的建议；不得声称草稿已应用。
3. 使用同一账号的九个只读 MCP 工具；不能扩大到 Glass、其他 profile 或写工具。
4. 补 bridge 合同测试并部署，写入 `docs/OPENCLAW_LINUX_RESULTS.md`：部署 SHA、
   契约版本、普通中文对话和真实 MCP 读取、续聊、去重、两个通道并发、断连/超时证据。
   容器构建仍由 Linux 验证。取消/撤回手机步骤继续“不适用”，不要求新测试按钮。
5. 将提交推送自己的分支供 Mac 集成。Mac 不会直接改 bridge/persona/服务器。

## 认证和能力

两个端点都要求现有 `Authorization: Bearer <gym bridge token>` 和
`x-opengym-profile-id`，仍只接受配置绑定的一个 profile。

`GET /v1/gym/capabilities` 返回 HTTP 200：

```json
{"chat_contract":1,"chat":true}
```

只有两个新端点和真实路由均就绪才宣布支持。旧版本的 404/405、网络失败或版本
不匹配时，Mac 保留现有提案能力，并明确提示普通对话暂不可用，不冒充普通聊天。
能力探测不调用模型、不消费额度、不暴露 persona/session/密钥。

## 普通消息

`POST /v1/gym/chat`，另带 `x-opengym-coach-mode: chat` 和
`x-opengym-request-id: <request_id>`。JSON：

```json
{
  "chat_contract": 1,
  "conversation_id": "gymchat-00000000-0000-4000-8000-000000000001",
  "request_id": "gymmsg-00000000-0000-4000-8000-000000000002",
  "message": "根据我最近的训练，今天应该练还是休息？",
  "lang": "zh",
  "proposal_context": null
}
```

- conversation/request ID 由 openGym 后端生成，均为指定前缀 + UUID；头和正文必须一致。
- `message` 非空，最多 8000 个 Unicode 字符；`lang` 是短语言标签，最多 16 字符。
  Mac 还会执行管理员的 `maxMessageLen`（可能低于 8000）。
- `proposal_context` 为 null 或 `{id, kind, status, summary}`；全部是字符串。
  `kind` 为 create/review/debrief，`status` 为 pending/resolved，id 最长 80 字符，
  summary 最长 12000 字符。后端从已校验的提案/已处理记录生成，手机不能透传。
  summary 可为含计划内容和选择结果的 JSON 文本；resolved 不等于全部应用，需读其中
  accepted/rejected/dismissed 结果。每次无建议时传 null，避免沿用旧草稿状态。
- 不接受任意 model、agent、session、system prompt、tools 或 routing headers。
- bridge 自己从绑定 profile + conversation ID 推导专属稳定 OpenClaw session，
  仅路由 `gym-coach`，与其他入口、proposal 会话及其他 profile 隔离。
- 把上下文作为资料，不能当成覆盖 persona/工具边界的指令；只发送当前消息，
  不在每轮重放完整历史。OpenClaw session 负责普通对话连续性。

成功时 HTTP 200（非 SSE），只输出最终 assistant 正文：

```json
{
  "chat_contract": 1,
  "conversation_id": "gymchat-00000000-0000-4000-8000-000000000001",
  "request_id": "gymmsg-00000000-0000-4000-8000-000000000002",
  "message": {"role":"assistant","content":"……"}
}
```

content 非空，最多 32000 Unicode 字符，整个响应最多 1 MiB；不带思考、工具调用
或原始工具输出。被截断的回答作为错误，不能冒充完整回答。

## 去重、失败和预算

- 同一 profile + request ID + 相同正文：在运行则复用，同已完成则返回原回答；
  相同 ID 不同正文返回 409。至少保留最近 200 个请求的去重记录（持久化到 bridge
  专属数据目录，不记入通用日志）。重启中断的请求记为失败，不自动重放。
- 单一 conversation 同时最多一条普通消息，另一个 request 返回 409；普通消息和
  proposal 可并发（现有 bridge 全局最大 2 个任务即可）。proposal 仍新建隔离 session。
- 400 不合法、401/403 认证/绑定拒绝、409 冲突、429 额度/并发、502 上游失败、504 超时；
  错误响应只需通用 `error`，不带 token、路径、私有 prompt 或上游堆栈。
- 复用现有 bridge 470 秒总预算；Mac 使用 `COACH_JOB_TIMEOUT_MS`（部署为 480 秒）
  和生产 `fetchFor`。断开 backend→bridge 请求时关闭上游，不在后台重新跑一次。
- App→openGym 为异步 202 + 轮询，离开页面/网络中断不取消已接受的服务端任务。
  用户重试同一消息复用原 request ID，不生成第二轮；失败后由 bridge 返回缓存失败，
  如用户仍要再问可以发送一条新消息。v1 不自动重发状态不明的模型请求。

## Mac 本轮交付

- openGym 鉴权后的会话 API、服务器持久化、账号绑定、首次数据说明和同意记录；
  普通对话不要求先填完整计划问卷。历史有界，账号清理删除本地记录并终止在途请求。
- 一个 Coach 界面：普通消息、生成要求确认、现有可应用提案卡、后续讨论；不新增 persona
  切换、不为验收增加取消/撤回控制。聊天与生成可并发，之后的聊天不改变已提交要求。
- 管理员日额度同时计算聊天和提案；已接受消息由服务端分配 request ID，手机的稳定
  client ID 仅用于断线重试去重。客户端不能选择会话或改 proposal_context。
- 合同假 bridge 测试、UI 检查、语言包和 API 文档、新 IPA。实际 OpenClaw/MCP 和容器
  由 Linux 验证；Mac 测试通过不代表服务器已经部署。
