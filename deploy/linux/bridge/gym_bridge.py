"""openGym ⇄ OpenClaw 受限 gym bridge(合同 docs/OPENCLAW_GYM_COACH_REQUIREMENTS.md §C)。

单文件 aiohttp 服务,宿主 systemd user 单元直跑(同 glass-backend 模式)。
职责(也是全部职责):把 openGym 的提案调用翻译成对隔离 agent 的一次
chat-completions 调用。

安全边界:
- openGym 只知道 bridge token;OpenClaw gateway token 只活在本进程 env。
- 固定单 persona(对外 ALLOWED_MODEL)+ 单账号(PROFILE_UID):不符直接 403。
- 对外 persona 是 openclaw/gym-coach;上游实际路由到 UPSTREAM_AGENT
  (gym-coach-proposal:零工具、无记忆注入、空 workspace)——这是 2026.9.33
  版本下"提案调用禁工具/禁记忆"的调用级隔离实现(该版本无请求级开关,
  已在 OPENCLAW_LINUX_RESULTS.md 说明)。
- 不透传调用方任意 header/工具声明;每请求独立上游 session
  (agent:<upstream>:opengym:<uuid>),绝不 fallback 到默认会话。
- 幂等:同 request ID + 同内容 → 重放缓存结果,不重跑;同 ID 不同内容 → 409。
- 客户端断开/超时 → 关闭上游 SSE(= OpenClaw 真正中止生成,glass 实测语义)。
- 日志只有 request ID、状态、耗时;不记请求/响应正文。

环境(EnvironmentFile ~/.config/opengym-bridge/env,0600,不进 Git):
  GYM_BRIDGE_TOKEN   openGym 侧 Bearer(独立生成,与 gateway token 无关)
  OPENCLAW_TOKEN     gateway token(仅上游用)
  OPENCLAW_URL       默认 http://127.0.0.1:18789
  GYM_PROFILE_UID    绑定的 openGym 账号 ID
  GYM_ALLOWED_MODEL  默认 openclaw/gym-coach
  GYM_UPSTREAM_AGENT 默认 gym-coach-proposal
  GYM_BRIDGE_PORT    默认 18890(只绑 127.0.0.1)
"""
import asyncio
import hashlib
import json
import os
import re
import time
import uuid

import aiohttp
from aiohttp import web

MAX_BODY = 2 * 1024 * 1024          # ≥ 1 MiB,覆盖 MAX_PAYLOAD_CHARS(300k)+ system prompt
MAX_MESSAGES = 8                     # openGym 实际发 2 条(system+user),留修复余量
MAX_TOKENS_CAP = 32000
UPSTREAM_TIMEOUT_S = 290             # openGym 调用预算 5min,留 10s 给传输
MODELS_PROBE_TIMEOUT_S = 5
MAX_CONCURRENCY = 2
IDEMPOTENCY_KEEP = 200
REQ_ID_RE = re.compile(
    r"^opengym-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _err(status, code, message=""):
    return web.json_response(
        {"error": {"code": code, "message": message}}, status=status)


class GymBridge:
    def __init__(self):
        self.token = os.environ["GYM_BRIDGE_TOKEN"]
        self.oc_token = os.environ["OPENCLAW_TOKEN"]
        self.oc_url = os.environ.get(
            "OPENCLAW_URL", "http://127.0.0.1:18789").rstrip("/")
        self.profile_uid = os.environ["GYM_PROFILE_UID"]
        self.allowed_model = os.environ.get(
            "GYM_ALLOWED_MODEL", "openclaw/gym-coach")
        self.upstream_agent = os.environ.get(
            "GYM_UPSTREAM_AGENT", "gym-coach-proposal")
        self.sem = asyncio.Semaphore(MAX_CONCURRENCY)
        self.results = {}            # request_id -> (body_hash, response_dict|None)
        self.inflight = {}           # request_id -> asyncio.Event
        self.order = []              # request_id 插入序(修剪用)
        self.session = None

    # ---------- 认证 ----------
    def _gate(self, request, *, need_profile=True):
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {self.token}":
            return _err(401, "unauthorized")
        if need_profile and \
                request.headers.get("x-opengym-profile-id") != self.profile_uid:
            return _err(403, "forbidden", "profile not bound")
        return None

    # ---------- /v1/models ----------
    async def h_models(self, request):
        deny = self._gate(request)
        if deny:
            return deny
        # 连通性探测:gateway /v1/models 可达即健康;不触发生成、不读训练数据
        try:
            async with self.session.get(
                    f"{self.oc_url}/v1/models",
                    headers={"Authorization": f"Bearer {self.oc_token}"},
                    timeout=aiohttp.ClientTimeout(total=MODELS_PROBE_TIMEOUT_S)
                    ) as r:
                if r.status != 200:
                    return _err(503, "upstream_unavailable")
        except Exception:
            return _err(503, "upstream_unavailable")
        return web.json_response({"object": "list", "data": [
            {"id": self.allowed_model, "object": "model"}]})

    # ---------- /v1/chat/completions ----------
    async def h_chat(self, request):
        t0 = time.monotonic()
        deny = self._gate(request)
        if deny:
            return deny
        if request.content_length and request.content_length > MAX_BODY:
            return _err(413, "payload_too_large")
        try:
            body = await request.json()
        except Exception:
            return _err(400, "invalid_request", "body 必须是 JSON")
        if not isinstance(body, dict):
            return _err(400, "invalid_request")

        rid = request.headers.get("x-opengym-request-id") or ""
        mode = request.headers.get("x-opengym-coach-mode") or ""
        if mode != "proposal":
            return _err(403, "forbidden", "only proposal mode")
        if not REQ_ID_RE.match(rid):
            return _err(400, "invalid_request", "x-opengym-request-id 非法")
        if body.get("user") != rid:
            return _err(400, "invalid_request", "user 必须等于 request id")
        if body.get("model") != self.allowed_model:
            return _err(403, "forbidden", "model not allowed")
        if body.get("stream") not in (False, None):
            return _err(400, "invalid_request", "不支持流式")
        msgs = body.get("messages")
        if not isinstance(msgs, list) or not (1 <= len(msgs) <= MAX_MESSAGES):
            return _err(400, "invalid_request", "messages 非法")
        for m in msgs:
            if not isinstance(m, dict) or m.get("role") not in (
                    "system", "user", "assistant") or \
                    not isinstance(m.get("content"), str):
                return _err(400, "invalid_request", "message 项非法")
        max_tokens = body.get("max_tokens", 16000)
        if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) \
                or not (1 <= max_tokens <= MAX_TOKENS_CAP):
            return _err(400, "invalid_request", "max_tokens 非法")

        # 幂等:同 ID 同内容重放缓存;不同内容 409;并发同 ID 等待首个结果
        bh = hashlib.sha256(json.dumps(
            {"messages": msgs, "max_tokens": max_tokens},
            sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        known = self.results.get(rid)
        if known is not None:
            if known[0] != bh:
                return _err(409, "conflict", "同 request id 内容不同")
            if known[1] is None:          # 原执行还在跑:等它,绝不新开一次
                ev = self.inflight.get(rid)
                if ev:
                    try:
                        await asyncio.wait_for(
                            ev.wait(), timeout=UPSTREAM_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        return _err(504, "upstream_timeout")
                known = self.results.get(rid, (bh, None))
            self._log(rid, "replay", t0)
            return self._stored_response(known[1])

        if self.sem.locked():
            # 并发已满:快速 429,不排队(openGym 侧不自动重试,由用户决定)
            return _err(429, "rate_limited")

        self.results[rid] = (bh, None)
        self.inflight[rid] = asyncio.Event()
        self.order.append(rid)
        if len(self.order) > IDEMPOTENCY_KEEP:
            old = self.order.pop(0)
            self.results.pop(old, None)
            self.inflight.pop(old, None)

        try:
            async with self.sem:
                content, finish = await asyncio.wait_for(
                    self._invoke(rid, msgs, max_tokens),
                    timeout=UPSTREAM_TIMEOUT_S)
        except asyncio.TimeoutError:
            self._finish(rid, {"__status": 504, "__code": "upstream_timeout"})
            self._log(rid, "timeout", t0)
            return _err(504, "upstream_timeout")
        except asyncio.CancelledError:
            # 客户端断开:上游响应随请求取消一起关闭(生成即停)
            self._finish(rid, {"__status": 502, "__code": "client_aborted"})
            self._log(rid, "client_abort", t0)
            raise
        except UpstreamHTTPError as e:
            self._finish(rid, {"__status": 502, "__code": "upstream_error"})
            self._log(rid, f"upstream_{e.status}", t0)
            return _err(502, "upstream_error")
        except Exception as e:
            self._finish(rid, {"__status": 502, "__code": "upstream_error"})
            self._log(rid, f"internal_{type(e).__name__}", t0)
            return _err(502, "upstream_error")

        resp = {"id": rid, "object": "chat.completion",
                "choices": [{"index": 0,
                             "message": {"role": "assistant",
                                         "content": content},
                             "finish_reason": finish}]}
        self._finish(rid, resp)
        self._log(rid, f"ok_{finish}", t0)
        return web.json_response(resp)

    def _finish(self, rid, resp):
        # 成功和失败都缓存:同 ID 重放永远不触发第二次执行
        # (用户手动重试在 openGym 侧会生成新 ID)
        bh = self.results.get(rid, ("", None))[0]
        self.results[rid] = (bh, resp)
        ev = self.inflight.pop(rid, None)
        if ev:
            ev.set()

    @staticmethod
    def _stored_response(stored):
        if stored is None:
            return _err(502, "upstream_error", "原执行未完成")
        if "__status" in stored:
            return _err(stored["__status"], stored["__code"])
        return web.json_response(stored)

    @staticmethod
    def _log(rid, status, t0):
        print(f"[bridge] {rid} {status} {int((time.monotonic()-t0)*1000)}ms",
              flush=True)

    async def _invoke(self, rid, msgs, max_tokens):
        """一次隔离提案调用:独立 session,内部 SSE 聚合,返回 (text, finish)。"""
        session_key = f"agent:{self.upstream_agent}:opengym:{rid[8:]}"
        body = {"model": f"openclaw/{self.upstream_agent}", "stream": True,
                "max_tokens": max_tokens, "messages": msgs}
        headers = {"Authorization": f"Bearer {self.oc_token}",
                   "x-openclaw-session-key": session_key}
        full, finish = [], "stop"
        async with self.session.post(
                f"{self.oc_url}/v1/chat/completions", json=body,
                headers=headers) as resp:
            if resp.status != 200:
                raise UpstreamHTTPError(resp.status)
            async for raw in resp.content:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except ValueError:
                    continue
                ch = (chunk.get("choices") or [{}])[0]
                delta = (ch.get("delta") or {}).get("content")
                if delta:
                    full.append(delta)
                if ch.get("finish_reason"):
                    finish = ch["finish_reason"]
        return "".join(full), finish

    async def h_health(self, request):
        return web.json_response({"bridge": "ok"})

    async def on_startup(self, app):
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=UPSTREAM_TIMEOUT_S + 10))

    async def on_cleanup(self, app):
        if self.session:
            await self.session.close()

    def build(self):
        app = web.Application(client_max_size=MAX_BODY + 64 * 1024)
        app.router.add_get("/v1/models", self.h_models)
        app.router.add_post("/v1/chat/completions", self.h_chat)
        app.router.add_get("/health", self.h_health)
        app.on_startup.append(self.on_startup)
        app.on_cleanup.append(self.on_cleanup)
        return app


class UpstreamHTTPError(Exception):
    def __init__(self, status):
        super().__init__(f"upstream {status}")
        self.status = status


def main():
    port = int(os.environ.get("GYM_BRIDGE_PORT", "18890"))
    # 默认绑宿主回环;openGym API 跑在容器里,容器内 127.0.0.1 是容器自己,
    # 所以通过 GYM_BRIDGE_BIND 追加 opengym docker 网络的网关 IP
    # (只对该私有网段可见,不上 LAN/tailnet,不碰 OpenClaw gateway 的暴露面)
    hosts = [h.strip() for h in os.environ.get(
        "GYM_BRIDGE_BIND", "127.0.0.1").split(",") if h.strip()]
    b = GymBridge()
    print(f"[bridge] 启动 {hosts}:{port} persona={b.allowed_model} "
          f"upstream={b.upstream_agent}", flush=True)
    # handler_cancellation:aiohttp 3.9+ 默认客户端断开不取消 handler;
    # 必须打开,断开才会沿 CancelledError 关掉上游 SSE(= 真正中止生成)
    web.run_app(b.build(), host=hosts, port=port, print=None,
                access_log=None, handler_cancellation=True)


if __name__ == "__main__":
    main()
