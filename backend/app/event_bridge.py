import asyncio
import contextlib
import json
import logging
from typing import Any, Callable

import websockets

from .config import Settings

logger = logging.getLogger(__name__)

# A rejected token will not fix itself in a few seconds -- someone has to rotate it -- so retrying
# on the normal 1..30 s backoff only fills Home Assistant's log with failed logins. Five minutes is
# short enough that a fixed token is picked up without a restart.
AUTH_RETRY_DELAY_S = 300.0
RECONNECT_MAX_DELAY_S = 30.0
# How long a command waits for the socket to come (back) up before giving up.
COMMAND_CONNECT_TIMEOUT_S = 5.0


class HomeAssistantAuthError(RuntimeError):
    """Home Assistant answered the token with `auth_invalid` -- a configuration problem, not an outage."""


class EventBridge:
    """One persistent WebSocket to Home Assistant, fanned out to every browser on the panel.

    Besides Home Assistant's own `event` frames, subscribers receive two frames of this bridge's
    own so a browser can keep its state table honest across a Home Assistant restart:

    * `{"type": "bridge", "connected": bool}` -- the upstream socket dropped or came back.
    * `{"type": "resync"}` -- sent after every successful (re)connect. State changes that happened
      while the socket was down were never streamed, so the browser should refetch `/api/states`
      rather than trust what it has. It is sent on the first connect too: a browser that loaded
      while Home Assistant was still booting has an empty or failed table, and this is what tells
      it to try again. Handling it is idempotent (a refetch), so the extra one is harmless.
    """

    def __init__(self, settings: Settings, connect: Callable[[str], Any] = websockets.connect) -> None:
        self.settings = settings
        self.subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        # Surfaced in /api/health so a wrong token reads as "rejected" rather than as a generic
        # "disconnected" that looks like a network problem.
        self.auth_failed = False
        self._connect = connect
        self._stop = asyncio.Event()
        self._connected = asyncio.Event()
        self._socket: Any = None
        self._next_id = 2
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._send_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    async def wait_until_connected(self) -> None:
        await self._connected.wait()

    async def call_service(self, domain: str, service: str, data: dict[str, Any]) -> list[dict[str, Any]]:
        """Call a service over the WebSocket. Always returns `[]`.

        The REST path (`HomeAssistantClient.call_service`) returns the list of states the call
        changed. Home Assistant's WebSocket `call_service` result is a dict carrying only the
        `context` of the call (plus `response` for services that return one) -- it never lists
        changed states, and those arrive over the event stream anyway. Rather than hand a caller
        a dict on one path and a list on the other, this path returns an empty list so
        `/api/services/...` has one response shape regardless of transport; the browser learns the
        outcome from the `state_changed` events that follow.
        """
        await self.send_command("call_service", domain=domain, service=service, service_data=data)
        return []

    async def send_command(self, command_type: str, **kwargs: Any) -> Any:
        """Generic request/response over the same persistent WebSocket `call_service` already
        uses: send `{id, type, **kwargs}`, await the matching `result` message. Anything Home
        Assistant's WebSocket API supports (registry listings, template renders, etc.) goes
        through this one path rather than each caller reimplementing the id/future bookkeeping.
        """
        await asyncio.wait_for(self._connected.wait(), timeout=COMMAND_CONNECT_TIMEOUT_S)
        async with self._send_lock:
            # Captured under the lock: the stream task can null `_socket` between the connected
            # check above and the send below, and the error for that should say so rather than
            # surface as an AttributeError on None.
            socket = self._socket
            if socket is None:
                raise ConnectionError("Home Assistant socket is not connected")
            message_id = self._next_id
            self._next_id += 1
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending[message_id] = future
            try:
                await socket.send(json.dumps({"id": message_id, "type": command_type, **kwargs}))
            except Exception:
                self._pending.pop(message_id, None)
                raise
        try:
            result = await asyncio.wait_for(future, timeout=15)
        finally:
            self._pending.pop(message_id, None)
        if not result.get("success"):
            raise RuntimeError(result.get("error", {}).get("message", f"Home Assistant command '{command_type}' failed"))
        return result.get("result")

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self.subscribers.discard(queue)

    async def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        if not self.settings.configured:
            return
        delay = 1.0
        while not self._stop.is_set():
            try:
                await self._stream()
                # The socket closed cleanly (Home Assistant restarting, say): reconnect straight
                # away and reset the backoff, since nothing went wrong on this side.
                delay = 1.0
                continue
            except asyncio.CancelledError:
                raise
            except HomeAssistantAuthError as error:
                self.auth_failed = True
                logger.error("Home Assistant rejected the backend's token: %s -- retrying in %.0f s", error, AUTH_RETRY_DELAY_S)
                pause = AUTH_RETRY_DELAY_S
            except Exception as error:
                logger.warning("Home Assistant event stream disconnected: %s", error)
                pause = delay
                delay = min(delay * 2, RECONNECT_MAX_DELAY_S)
            if self._stop.is_set():
                break
            await self._pause(pause)

    async def _pause(self, delay: float) -> None:
        """Wait between connection attempts, cut short by `stop()`. Its own method so tests can
        observe which delay the loop chose instead of sleeping through it."""
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def _stream(self) -> None:
        async with self._connect(self.settings.websocket_url) as socket:
            hello = json.loads(await socket.recv())
            if hello.get("type") != "auth_required":
                raise RuntimeError("Unexpected Home Assistant WebSocket greeting")
            await socket.send(json.dumps({"type": "auth", "access_token": self.settings.ha_token}))
            auth = json.loads(await socket.recv())
            if auth.get("type") == "auth_invalid":
                raise HomeAssistantAuthError(auth.get("message") or "auth_invalid")
            if auth.get("type") != "auth_ok":
                raise RuntimeError("Home Assistant WebSocket authentication failed")
            self.auth_failed = False
            await socket.send(json.dumps({"id": 1, "type": "subscribe_events", "event_type": "state_changed"}))
            subscription = json.loads(await socket.recv())
            if not subscription.get("success"):
                raise RuntimeError("Home Assistant event subscription failed")
            # Published only once the socket is authenticated and subscribed: `send_command` gates on
            # `_connected`, so nothing can pick up a half-set-up socket.
            self._socket = socket
            self._connected.set()
            await self.broadcast({"type": "bridge", "connected": True})
            await self.broadcast({"type": "resync"})
            try:
                async for raw_message in socket:
                    message = json.loads(raw_message)
                    if message.get("type") == "event":
                        await self.broadcast(message)
                    elif message.get("type") == "result":
                        future = self._pending.get(message.get("id"))
                        if future and not future.done():
                            future.set_result(message)
            finally:
                self._connected.clear()
                self._socket = None
                for future in self._pending.values():
                    if not future.done():
                        future.set_exception(ConnectionError("Home Assistant event stream disconnected"))
                self._pending.clear()
                await self.broadcast({"type": "bridge", "connected": False})

    async def broadcast(self, message: dict[str, Any]) -> None:
        for queue in tuple(self.subscribers):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            queue.put_nowait(message)
