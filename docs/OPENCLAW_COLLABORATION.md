# openGym：Mac / Linux 分工与交接

更新：2026-10-19。Linux `a062b655` 已集成；app/API、普通对话 bridge 和 persona 提示
已实现。当前代码通过集成分支审查后合入 `main`。真实运行结果见
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

## 合并后的 Linux 部署步骤

1. 合入最新 `origin/main`，保留自己的分支历史；备份 openGym 数据与 bridge 去重文件。
2. 按 `deploy/linux/docker-compose.yml` 重建 API/web，并重启 bridge；此前 Linux 只部署了
   新 bridge，未构建包含 Mac 普通对话 API/UI 的新镜像。
3. 同步 v1.1 persona 提示，保持现有 profile/MCP 绑定、Tailscale 和超时配置。
4. 核验 `/api/health`、普通对话能力和账号绑定；用新版 IPA 完成聊天、生成、应用、续聊。
   把实际部署 SHA 与结果追加到 Linux 验收记录。

本次集成修复了账号维度的缓存/会话隔离、不完整 SSE 回复处理、持久化与测试覆盖。
新版会话键包含 profile；旧版无 profile 的请求缓存保留，但重放返回 `interrupted`，不会
取出无法确认归属的旧回答或再次调用模型。旧版 OpenClaw 会话不会自动导入新命名空间；
磁盘去重文件损坏时服务拒绝启动，应从备份恢复，不自动清空。

## Git 工作流

Linux 后续提交到自己的分支，Mac 拉取审查并集成。双方使用普通 merge 保留共同历史，
不强推、重置或重复 cherry-pick 对方的提交。Git 合并与服务器部署分别记录。

接口与交互的稳定说明：[普通对话合同](OPENCLAW_CHAT_CONTRACT.md)、
[统一教练 UX](OPENCLAW_COACH_UX.md)、[AI Coach 使用说明](AI_COACH.md)。
