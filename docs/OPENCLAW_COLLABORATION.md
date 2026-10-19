# openGym：Mac / Linux 分工与交接

更新：2026-10-19。app/API、普通对话 bridge 和 persona 提示已实现，并通过 PR #1
合入 `main`（`c6a4cd3d`）。Linux 最新记录 `10c18609` 确认该版本已部署。真实运行结果见
[Linux 验收记录](OPENCLAW_LINUX_RESULTS.md)，本机检查见
[Mac 验证记录](OPENCLAW_MAC_VALIDATION.md)。

## 分工

| 范围 | 负责人 |
| --- | --- |
| `frontend/`、中文界面、iPhone 配对/同步、Coach 交互 | Mac |
| `api/`、账号绑定、会话 API、提案解析/校验 | Mac |
| `mcp/` 源码、共享训练逻辑、自动测试/CI | Mac |
| iOS 工程、IPA、代码审查、集成与 `main` 合并 | Mac |
| `deploy/linux/`、bridge、persona 模板、部署验收 | Linux |
| Linux 容器/服务、密钥、OpenClaw/MCP、Tailscale、备份与回滚 | Linux |
| iPhone 真机操作 | 用户操作；Linux 核验服务端，Mac 修客户端 |

Mac 在集成审查中修正影响两端合同的代码问题，并在 Git 中记录 Linux 需要部署的改动；
不 SSH 修改运行环境。Linux 后续工作仍推 `codex/linux-gym-coach`，不直接改 `main`。
Glass 仅作只读参考，不属于本任务的修改范围。

## 已完成

- 一个教练、一个连续对话界面；普通消息与明确确认的计划生成分开执行，用户无需切换 persona。
- 会话持久化、账号绑定、重试去重、共享额度、提案引用和用户确认应用。
- 普通对话 v1 bridge、九个只读 MCP 工具、中文真实对话、续聊及双通道运行验证。
- 生产传输预算：API 480 秒、bridge 470 秒；310 秒等待、超时和断连检查通过。
- 取消/撤回手机步骤：产品无入口，不适用；不新增测试按钮或为此扩展端点。
- 中文 IPA 已构建：`openGym-1.4.1-26-486e4b88-unsigned.ipa`；本轮集成未改客户端，无需重打。

## 生产部署与下一步验证

Linux 已备份数据、以 `c6a4cd3d` 重建 API/web（含新版 CoachChat），并重启加固后的
bridge。Linux 复测 bridge 23/23 通过；`/api/health`、18445 入口、capabilities 正常，
真实中文聊天经 MCP 读到当前周计划，见 [Linux 验收记录 §14](OPENCLAW_LINUX_RESULTS.md#14-main-合并后的生产部署2026-10-19)。

接下来由用户安装新版 IPA，验证同一教练界面中的聊天、生成建议、确认应用、续聊。
可使用上面的已验证 IPA，或从 `main` 执行 `bash scripts/build-ios-ipa.sh` 重新构建。
Linux 核验服务端结果；如有客户端问题，由 Mac 修复。本次部署记录合并仅涉及文档，
无需因此再次重建 Linux 容器。

本次集成修复了账号维度的缓存/会话隔离、不完整 SSE 回复处理、持久化与测试覆盖。
新版会话键包含 profile；旧版无 profile 的请求缓存保留，但重放返回 `interrupted`，不会
取出无法确认归属的旧回答或再次调用模型。旧版 OpenClaw 会话不会自动导入新命名空间；
磁盘去重文件损坏时服务拒绝启动，应从备份恢复，不自动清空。

## Git 工作流

Linux 后续提交到自己的分支，Mac 拉取审查并集成。双方使用普通 merge 保留共同历史，
不强推、重置或重复 cherry-pick 对方的提交。Git 合并与服务器部署分别记录。

接口与交互的稳定说明：[普通对话合同](OPENCLAW_CHAT_CONTRACT.md)、
[统一教练 UX](OPENCLAW_COACH_UX.md)、[AI Coach 使用说明](AI_COACH.md)。
