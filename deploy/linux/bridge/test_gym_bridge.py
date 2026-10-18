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
