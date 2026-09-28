"""The Home Assistant WebSocket bridge, driven against a fake socket.

The bridge is the one piece of the backend that holds long-lived state across a Home Assistant
restart, and until now nothing exercised it. `FakeSocket` below speaks just enough of the
Home Assistant WebSocket protocol (auth handshake, subscribe result, request/response by id) to
drive `EventBridge.run()` end to end without a network; the `connect` factory the bridge accepts
is what lets the tests hand it one.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from app import event_bridge
from app.config import Settings
from app.event_bridge import EventBridge

SETTINGS = Settings(ha_url="http://ha.local:8123", ha_token="token", cors_origins=())

_CLOSE = object()


class FakeSocket:
    """An async-context-manager socket that answers like Home Assistant would."""

    def __init__(self, auth: str = "auth_ok", subscribe_ok: bool = True, result: Any = None) -> None:
        self.auth = auth
        self.subscribe_ok = subscribe_ok
        # What `call_service` (and any other command) gets back as its `result` payload.
        self.result = {"context": {"id": "abc"}} if result is None else result
        self.sent: list[dict[str, Any]] = []
        self.incoming: asyncio.Queue[Any] = asyncio.Queue()
        self.incoming.put_nowait(json.dumps({"type": "auth_required", "ha_version": "2025.1"}))

    def push(self, message: dict[str, Any]) -> None:
        self.incoming.put_nowait(json.dumps(message))

    def close(self) -> None:
        self.incoming.put_nowait(_CLOSE)

    async def __aenter__(self) -> "FakeSocket":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        return None

    async def recv(self) -> str:
        item = await self.incoming.get()
        if item is _CLOSE:
            raise ConnectionError("closed")
        return item

    async def send(self, raw: str) -> None:
        message = json.loads(raw)
        self.sent.append(message)
        if message["type"] == "auth":
            if self.auth == "auth_ok":
                self.push({"type": "auth_ok"})
            else:
                self.push({"type": "auth_invalid", "message": "Invalid access token or password"})
        elif message["type"] == "subscribe_events":
            self.push({"id": message["id"], "type": "result", "success": self.subscribe_ok, "result": None})
        else:
            self.push({"id": message["id"], "type": "result", "success": True, "result": self.result})

    def __aiter__(self) -> "FakeSocket":
        return self

    async def __anext__(self) -> str:
        item = await self.incoming.get()
        if item is _CLOSE:
            raise StopAsyncIteration
        return item


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=5))


async def _drain(queue: asyncio.Queue) -> dict[str, Any]:
    return await asyncio.wait_for(queue.get(), timeout=2)


class TestConnectLifecycle:
    def test_a_successful_connect_announces_itself_and_asks_browsers_to_resync(self):
        async def scenario():
            socket = FakeSocket()
            bridge = EventBridge(SETTINGS, connect=lambda url: socket)
            queue = bridge.subscribe()
            task = asyncio.create_task(bridge.run())
            await asyncio.wait_for(bridge.wait_until_connected(), 2)

            assert await _drain(queue) == {"type": "bridge", "connected": True}
            assert await _drain(queue) == {"type": "resync"}
            assert bridge.auth_failed is False
            # The handshake went out in the documented order.
            assert [m["type"] for m in socket.sent] == ["auth", "subscribe_events"]

            await bridge.stop()
            socket.close()
            await task

        run(scenario())

    def test_events_are_fanned_out_and_a_drop_is_announced(self):
        async def scenario():
            socket = FakeSocket()
            bridge = EventBridge(SETTINGS, connect=lambda url: socket)
            queue = bridge.subscribe()
            task = asyncio.create_task(bridge.run())
            await asyncio.wait_for(bridge.wait_until_connected(), 2)
            await _drain(queue)
            await _drain(queue)

            socket.push({"id": 1, "type": "event", "event": {"event_type": "state_changed", "data": {}}})
            forwarded = await _drain(queue)
            assert forwarded["type"] == "event"

            await bridge.stop()
            socket.close()
            await task
            assert await _drain(queue) == {"type": "bridge", "connected": False}
            assert bridge.connected is False

        run(scenario())

    def test_a_reconnect_sends_a_fresh_resync(self):
        async def scenario():
            sockets = [FakeSocket(), FakeSocket()]
            attempts: list[FakeSocket] = []
            bridge = EventBridge(SETTINGS, connect=lambda url: attempts.append(sockets[len(attempts)]) or attempts[-1])
            paused: list[float] = []

            async def no_pause(delay: float) -> None:
                paused.append(delay)

            bridge._pause = no_pause  # type: ignore[method-assign]
            queue = bridge.subscribe()
            task = asyncio.create_task(bridge.run())
            await asyncio.wait_for(bridge.wait_until_connected(), 2)
            await _drain(queue)
            await _drain(queue)

            sockets[0].close()  # Home Assistant restarts
            assert await _drain(queue) == {"type": "bridge", "connected": False}
            assert await _drain(queue) == {"type": "bridge", "connected": True}
            assert await _drain(queue) == {"type": "resync"}
            assert len(attempts) == 2

            await bridge.stop()
            sockets[1].close()
            await task

        run(scenario())


class TestAuthFailure:
    def test_a_rejected_token_is_recorded_and_retried_slowly(self):
        async def scenario():
            attempts = 0
            bridge = EventBridge(SETTINGS)
            paused: list[float] = []

            def connect(url: str) -> FakeSocket:
                nonlocal attempts
                attempts += 1
                return FakeSocket(auth="auth_invalid")

            async def record_pause(delay: float) -> None:
                paused.append(delay)
                if len(paused) >= 2:
                    await bridge.stop()

            bridge._connect = connect  # type: ignore[method-assign]
            bridge._pause = record_pause  # type: ignore[method-assign]
            await bridge.run()

            assert bridge.auth_failed is True
            assert bridge.connected is False
            assert paused == [event_bridge.AUTH_RETRY_DELAY_S, event_bridge.AUTH_RETRY_DELAY_S]
            assert attempts == 2

        run(scenario())

    def test_a_fixed_token_clears_the_flag(self):
        async def scenario():
            sockets = [FakeSocket(auth="auth_invalid"), FakeSocket()]
            attempts: list[FakeSocket] = []
            bridge = EventBridge(SETTINGS, connect=lambda url: attempts.append(sockets[len(attempts)]) or attempts[-1])
            seen_failed: list[bool] = []

            async def no_pause(delay: float) -> None:
                seen_failed.append(bridge.auth_failed)

            bridge._pause = no_pause  # type: ignore[method-assign]
            task = asyncio.create_task(bridge.run())
            await asyncio.wait_for(bridge.wait_until_connected(), 2)
            assert seen_failed == [True]
            assert bridge.auth_failed is False

            await bridge.stop()
            sockets[1].close()
            await task

        run(scenario())

    def test_an_ordinary_disconnect_backs_off_normally_not_for_five_minutes(self):
        async def scenario():
            bridge = EventBridge(SETTINGS)
            paused: list[float] = []

            def connect(url: str) -> FakeSocket:
                socket = FakeSocket()
                socket.close()  # dies straight after the greeting
                return socket

            async def record_pause(delay: float) -> None:
                paused.append(delay)
                if len(paused) >= 3:
                    await bridge.stop()

            bridge._connect = connect  # type: ignore[method-assign]
            bridge._pause = record_pause  # type: ignore[method-assign]
            await bridge.run()
            assert paused == [1.0, 2.0, 4.0]
            assert bridge.auth_failed is False

        run(scenario())


class TestCommands:
    def test_call_service_returns_an_empty_list_regardless_of_the_ws_result_shape(self):
        async def scenario():
            socket = FakeSocket(result={"context": {"id": "ctx"}, "response": None})
            bridge = EventBridge(SETTINGS, connect=lambda url: socket)
            task = asyncio.create_task(bridge.run())
            await asyncio.wait_for(bridge.wait_until_connected(), 2)

            result = await bridge.call_service("light", "turn_on", {"entity_id": "light.kitchen"})
            assert result == []
            sent = socket.sent[-1]
            assert sent["type"] == "call_service"
            assert sent["domain"] == "light" and sent["service"] == "turn_on"
            assert sent["service_data"] == {"entity_id": "light.kitchen"}

            await bridge.stop()
            socket.close()
            await task

        run(scenario())

    def test_a_failed_command_raises_home_assistants_message(self):
        async def scenario():
            socket = FakeSocket()
            bridge = EventBridge(SETTINGS, connect=lambda url: socket)
            task = asyncio.create_task(bridge.run())
            await asyncio.wait_for(bridge.wait_until_connected(), 2)

            async def failing_send(raw: str) -> None:
                message = json.loads(raw)
                socket.sent.append(message)
                socket.push({"id": message["id"], "type": "result", "success": False, "error": {"message": "Service not found"}})

            socket.send = failing_send  # type: ignore[method-assign]
            with pytest.raises(RuntimeError, match="Service not found"):
                await bridge.send_command("call_service", domain="nope", service="x", service_data={})

            await bridge.stop()
            socket.close()
            await task

        run(scenario())

    def test_a_missing_socket_is_a_connection_error_not_an_attribute_error(self):
        async def scenario():
            bridge = EventBridge(SETTINGS)
            bridge._connected.set()  # connected flag without a socket: the race the guard is for
            with pytest.raises(ConnectionError, match="not connected"):
                await bridge.send_command("ping")

        run(scenario())

    def test_a_command_while_disconnected_times_out_rather_than_hanging(self, monkeypatch):
        monkeypatch.setattr(event_bridge, "COMMAND_CONNECT_TIMEOUT_S", 0.05)

        async def scenario():
            bridge = EventBridge(SETTINGS)
            with pytest.raises(asyncio.TimeoutError):
                await bridge.send_command("ping")

        run(scenario())
