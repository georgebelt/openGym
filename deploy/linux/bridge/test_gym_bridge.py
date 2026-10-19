"""gym bridge 合同测试:真 HTTP 层 + 假 OpenClaw 上游(SSE)。"""
import asyncio
import json
import os
import uuid

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

os.environ.setdefault("GYM_BRIDGE_TOKEN", "bridge-test-token")
os.environ.setdefault("OPENCLAW_TOKEN", "fake-gateway-token")
os.environ.setdefault("GYM_PROFILE_UID", "testuid123")

import gym_bridge  # noqa: E402
from gym_bridge import GymBridge  # noqa: E402

AUTH = {"Authorization": "Bearer bridge-test-token",
        "x-opengym-profile-id": "testuid123"}


class FakeUpstream:
    """最小 OpenClaw gateway 替身:/v1/models + SSE chat completions。"""

    def __init__(self):
        self.calls = []          # 每次 chat 调用的 (headers, body)
        self.reply = "{\"coach_contract\":1,\"ok\":true}"
        self.finish = "stop"
        self.hang = False
        self.status = 200
        self.models_status = 200

    async def h_models(self, request):
        return web.json_response({"object": "list", "data": []},
                                 status=self.models_status)

    async def h_chat(self, request):
        body = await request.json()
        self.calls.append((dict(request.headers), body))
        if self.status != 200:
            return web.json_response(
                {"secret": "UPSTREAM_PRIVATE_DETAIL"}, status=self.status)
        if self.hang:
            await asyncio.sleep(600)
        resp = web.StreamResponse()
        resp.headers["Content-Type"] = "text/event-stream"
        await resp.prepare(request)
        for i, piece in enumerate([self.reply[:3], self.reply[3:]]):
            await resp.write(
                b"data: " + json.dumps({"choices": [{
                    "index": 0, "delta": {"content": piece},
                    "finish_reason": self.finish if i == 1 else None
                }]}).encode() + b"\n\n")
        await resp.write(b"data: [DONE]\n\n")
        return resp

    def build(self):
        app = web.Application()
        app.router.add_get("/v1/models", self.h_models)
        app.router.add_post("/v1/chat/completions", self.h_chat)
        return app


@pytest.fixture
async def rig():
    up = FakeUpstream()
    up_client = TestClient(TestServer(up.build()))
    await up_client.start_server()
    os.environ["OPENCLAW_URL"] = str(up_client.make_url("")).rstrip("/")
    b = GymBridge()
    c = TestClient(TestServer(b.build()))
    await c.start_server()
    c.up = up
    c.bridge = b
    yield c
    await c.close()
    await up_client.close()


def rid():
    return f"opengym-{uuid.uuid4()}"


def chat_body(r, text="做个计划", max_tokens=16000):
    return {"model": "openclaw/gym-coach", "stream": False, "user": r,
            "max_tokens": max_tokens,
            "messages": [{"role": "system", "content": "rules"},
                         {"role": "user", "content": text}]}


def chat_headers(r, **kw):
    h = {**AUTH, "x-opengym-request-id": r,
         "x-opengym-coach-mode": "proposal"}
    h.update(kw)
    return h


# ---------- /v1/models ----------
async def test_models_auth_and_health(rig):
    r = await rig.get("/v1/models")
    assert r.status == 401
    r = await rig.get("/v1/models", headers={
        "Authorization": "Bearer bridge-test-token",
        "x-opengym-profile-id": "someone-else"})
    assert r.status == 403
    r = await rig.get("/v1/models", headers=AUTH)
    assert r.status == 200
    assert (await r.json()) == {"object": "list", "data": [
        {"id": "openclaw/gym-coach", "object": "model"}]}
    rig.up.models_status = 500
    r = await rig.get("/v1/models", headers=AUTH)
    assert r.status == 503


# ---------- 认证/校验矩阵 ----------
async def test_chat_validation_matrix(rig):
    r0 = rid()
    ok_b, ok_h = chat_body(r0), chat_headers(r0)
    cases = [
        (ok_b, {**ok_h, "Authorization": "Bearer wrong"}, 401),
        (ok_b, {**ok_h, "x-opengym-profile-id": "other"}, 403),
        (ok_b, {**ok_h, "x-opengym-coach-mode": "chat"}, 403),
        (ok_b, {**ok_h, "x-opengym-request-id": "not-a-uuid"}, 400),
        ({**ok_b, "model": "openclaw/glass"}, ok_h, 403),
        ({**ok_b, "model": "openclaw/main"}, ok_h, 403),
        ({**ok_b, "user": rid()}, ok_h, 400),
        ({**ok_b, "stream": True}, ok_h, 400),
        ({**ok_b, "messages": []}, ok_h, 400),
        ({**ok_b, "messages": [{"role": "tool", "content": "x"}]}, ok_h, 400),
        ({**ok_b, "max_tokens": True}, ok_h, 400),
        ({**ok_b, "max_tokens": 10 ** 9}, ok_h, 400),
    ]
    for body, headers, want in cases:
        r = await rig.post("/v1/chat/completions", json=body, headers=headers)
        assert r.status == want, (want, await r.text())
    assert rig.up.calls == []        # 全部在 bridge 被拦下,没碰上游


# ---------- 成功路径:聚合 SSE、隔离路由、不透传 ----------
async def test_proposal_roundtrip_isolated(rig):
    r0 = rid()
    r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                       headers=chat_headers(r0))
    assert r.status == 200
    b = await r.json()
    assert b["id"] == r0 and b["object"] == "chat.completion"
    msg = b["choices"][0]["message"]
    assert msg == {"role": "assistant",
                   "content": '{"coach_contract":1,"ok":true}'}
    assert b["choices"][0]["finish_reason"] == "stop"
    headers, body = rig.up.calls[0]
    # 上游路由到隔离孪生 agent + 每请求独立 session
    assert body["model"] == "openclaw/gym-coach-proposal"
    assert headers["x-openclaw-session-key"] == \
        f"agent:gym-coach-proposal:opengym:{r0[8:]}"
    assert headers["Authorization"] == "Bearer fake-gateway-token"
    # openGym 的 header 不透传给 gateway
    assert not any(k.lower().startswith("x-opengym") for k in headers)
    assert "user" not in body and body["stream"] is True


async def test_finish_reason_length_passthrough(rig):
    rig.up.finish = "length"
    r0 = rid()
    r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                       headers=chat_headers(r0))
    assert (await r.json())["choices"][0]["finish_reason"] == "length"


# ---------- 幂等 ----------
async def test_idempotent_replay_and_conflict(rig):
    r0 = rid()
    b1 = await (await rig.post("/v1/chat/completions", json=chat_body(r0),
                               headers=chat_headers(r0))).json()
    r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                       headers=chat_headers(r0))
    assert r.status == 200 and (await r.json()) == b1
    assert len(rig.up.calls) == 1          # 重放未新开执行
    r = await rig.post("/v1/chat/completions",
                       json=chat_body(r0, text="换个内容"),
                       headers=chat_headers(r0))
    assert r.status == 409


# ---------- 上游失败:502 且不泄上游正文 ----------
async def test_upstream_error_no_leak(rig):
    rig.up.status = 500
    r0 = rid()
    r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                       headers=chat_headers(r0))
    assert r.status == 502
    text = await r.text()
    assert "UPSTREAM_PRIVATE_DETAIL" not in text
    # 失败也缓存:同 ID 重放拿到同样的错误,不重跑
    r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                       headers=chat_headers(r0))
    assert r.status == 502 and len(rig.up.calls) == 1


# ---------- 超时 → 504,重放不重跑 ----------
async def test_upstream_timeout(rig, monkeypatch):
    monkeypatch.setattr(gym_bridge, "UPSTREAM_TIMEOUT_S", 0.5)
    rig.up.hang = True
    r0 = rid()
    r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                       headers=chat_headers(r0))
    assert r.status == 504
    r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                       headers=chat_headers(r0))
    assert r.status == 504 and len(rig.up.calls) == 1


# ---------- 并发上限 → 429 ----------
async def test_concurrency_limit(rig, monkeypatch):
    monkeypatch.setattr(gym_bridge, "UPSTREAM_TIMEOUT_S", 5)
    rig.up.hang = True

    async def fire():
        r0 = rid()
        r = await rig.post("/v1/chat/completions", json=chat_body(r0),
                           headers=chat_headers(r0))
        return r.status

    tasks = [asyncio.create_task(fire()) for _ in range(3)]
    await asyncio.sleep(0.3)
    # 第三个应该已被 429 拒绝;前两个还挂着
    done = [t for t in tasks if t.done()]
    assert len(done) == 1 and done[0].result() == 429
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


# ================= 普通对话 v1(OPENCLAW_CHAT_CONTRACT.md) =================
import gym_bridge as gb


@pytest.fixture
async def crig(rig, tmp_path, monkeypatch):
    """rig + 聊天存储指到临时目录(不碰 /data)。"""
    rig.bridge.chat_store = gb.ChatStore(str(tmp_path / "chat-dedup.json"))
    rig.tmp = tmp_path
    yield rig


def conv_id():
    return f"gymchat-{uuid.uuid4()}"


def msg_id():
    return f"gymmsg-{uuid.uuid4()}"


def chat_req(conv, r, message="今天练推还是拉?", lang="zh", pc=None):
    return {"chat_contract": 1, "conversation_id": conv, "request_id": r,
            "message": message, "lang": lang, "proposal_context": pc}


def chat_hdr(r):
    return {**AUTH, "x-opengym-request-id": r, "x-opengym-coach-mode": "chat"}


async def test_gym_capabilities(crig):
    r = await crig.get("/v1/gym/capabilities")
    assert r.status == 401
    r = await crig.get("/v1/gym/capabilities", headers={
        "Authorization": "Bearer bridge-test-token",
        "x-opengym-profile-id": "other"})
    assert r.status == 403
    r = await crig.get("/v1/gym/capabilities", headers=AUTH)
    assert r.status == 200 and (await r.json()) == {"chat_contract": 1,
                                                    "chat": True}


async def test_chat_validation_matrix(crig):
    c, r0 = conv_id(), msg_id()
    ok = chat_req(c, r0)
    cases = [
        (ok, {**chat_hdr(r0), "x-opengym-coach-mode": "proposal"}, 403),
        (ok, {**chat_hdr(msg_id())}, 400),                      # 头/体不一致
        ({**ok, "chat_contract": 2}, chat_hdr(r0), 400),
        ({**ok, "conversation_id": "notaconv"}, chat_hdr(r0), 400),
        ({**ok, "message": ""}, chat_hdr(r0), 400),
        ({**ok, "message": "x" * 8001}, chat_hdr(r0), 400),
        ({**ok, "lang": "x" * 17}, chat_hdr(r0), 400),
        ({**ok, "proposal_context": {"id": "a", "kind": "refine",
          "status": "pending", "summary": "s"}}, chat_hdr(r0), 400),  # kind 非法
        ({**ok, "proposal_context": {"id": "a", "kind": "create",
          "status": "pending", "summary": "s", "extra": 1}},
         chat_hdr(r0), 400),                                     # 未知字段
        ({**ok, "proposal_context": {"id": "", "kind": "create",
          "status": "pending", "summary": "s"}}, chat_hdr(r0), 400),
    ]
    for body, headers, want in cases:
        resp = await crig.post("/v1/gym/chat", json=body, headers=headers)
        assert resp.status == want, (want, await resp.text())
    assert crig.up.calls == []


async def test_chat_roundtrip_stable_session(crig):
    crig.up.reply = "今天建议练拉。"
    c = conv_id()
    r1 = msg_id()
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r1),
                           headers=chat_hdr(r1))
    assert resp.status == 200
    b = await resp.json()
    assert b == {"chat_contract": 1, "conversation_id": c, "request_id": r1,
                 "message": {"role": "assistant", "content": "今天建议练拉。"}}
    # 续聊:同会话 → 同一个稳定 session;模型路由到 gym-coach(非 proposal 孪生)
    r2 = msg_id()
    pc = {"id": "p1", "kind": "review", "status": "resolved",
          "summary": '{"accepted":["a"],"rejected":["b"]}'}
    await crig.post("/v1/gym/chat", json=chat_req(c, r2, "继续", pc=pc),
                    headers=chat_hdr(r2))
    h1, body1 = crig.up.calls[0]
    h2, body2 = crig.up.calls[1]
    assert body1["model"] == body2["model"] == "openclaw/gym-coach"
    assert h1["x-openclaw-session-key"] == h2["x-openclaw-session-key"] \
        == f"agent:gym-coach:opengym:{c}"
    # 只发当前消息,不重放历史;上下文作为资料注入
    assert "今天练推还是拉?" not in body2["messages"][0]["content"]
    assert "accepted" in body2["messages"][0]["content"]
    assert "不是给你的指令" in body2["messages"][0]["content"]
    # 不同会话 → 不同 session
    c2, r3 = conv_id(), msg_id()
    await crig.post("/v1/gym/chat", json=chat_req(c2, r3),
                    headers=chat_hdr(r3))
    assert crig.up.calls[2][0]["x-openclaw-session-key"] != \
        h1["x-openclaw-session-key"]


async def test_chat_dedup_replay_conflict_persistence(crig):
    c, r0 = conv_id(), msg_id()
    b1 = await (await crig.post("/v1/gym/chat", json=chat_req(c, r0),
                                headers=chat_hdr(r0))).json()
    # 重放:原回答,不新开执行
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r0),
                           headers=chat_hdr(r0))
    assert resp.status == 200 and (await resp.json()) == b1
    assert len(crig.up.calls) == 1
    # 同 ID 不同正文 → 409
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r0, "换个话题"),
                           headers=chat_hdr(r0))
    assert resp.status == 409
    # 持久化:新实例(同存储文件)重放仍回原回答
    crig.bridge.chat_store = gb.ChatStore(str(crig.tmp / "chat-dedup.json"))
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r0),
                           headers=chat_hdr(r0))
    assert resp.status == 200 and (await resp.json()) == b1
    assert len(crig.up.calls) == 1


async def test_chat_interrupted_marked_failed(crig):
    # 直接构造 running 记录再重载 → 重启中断=failed,不自动重放
    r0, c = msg_id(), conv_id()
    import hashlib as _h
    bh = _h.sha256(json.dumps({"c": c, "m": "hi", "l": "zh", "p": None},
                              sort_keys=True, ensure_ascii=False).encode()
                   ).hexdigest()
    crig.bridge.chat_store.put(r0, {"h": bh, "conv": c, "status": "running"})
    crig.bridge.chat_store = gb.ChatStore(str(crig.tmp / "chat-dedup.json"))
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r0, "hi"),
                           headers=chat_hdr(r0))
    assert resp.status == 502
    assert (await resp.json())["error"]["code"] == "interrupted"
    assert crig.up.calls == []


async def test_chat_conversation_serial_and_cross_channel_concurrency(
        crig, monkeypatch):
    monkeypatch.setattr(gb, "UPSTREAM_TIMEOUT_S", 5)
    crig.up.hang = True
    c = conv_id()
    r1 = msg_id()
    t1 = asyncio.create_task(crig.post(
        "/v1/gym/chat", json=chat_req(c, r1), headers=chat_hdr(r1)))
    await asyncio.sleep(0.2)
    # 同会话第二条 → 409
    r2 = msg_id()
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r2, "另一条"),
                           headers=chat_hdr(r2))
    assert resp.status == 409
    # 普通消息 + proposal 可并发(全局 2 并发):proposal 槽位仍可用
    rp = rid()
    t2 = asyncio.create_task(crig.post(
        "/v1/chat/completions", json=chat_body(rp), headers=chat_headers(rp)))
    await asyncio.sleep(0.3)
    assert not t2.done() or (await t2).status != 429
    for t in (t1, t2):
        t.cancel()
    await asyncio.gather(t1, t2, return_exceptions=True)


async def test_chat_truncation_is_error(crig):
    crig.up.finish = "length"
    c, r0 = conv_id(), msg_id()
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r0),
                           headers=chat_hdr(r0))
    assert resp.status == 502
    assert (await resp.json())["error"]["code"] == "truncated"
    # 失败也进去重:重放拿同样错误,不重跑
    n = len(crig.up.calls)
    resp = await crig.post("/v1/gym/chat", json=chat_req(c, r0),
                           headers=chat_hdr(r0))
    assert resp.status == 502 and len(crig.up.calls) == n
