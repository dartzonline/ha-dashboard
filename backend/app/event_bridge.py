import asyncio
import contextlib
import json
import logging
from typing import Any

import websockets

from .config import Settings

logger = logging.getLogger(__name__)


class EventBridge:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
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

    async def call_service(self, domain: str, service: str, data: dict[str, Any]) -> Any:
        await asyncio.wait_for(self._connected.wait(), timeout=5)
        async with self._send_lock:
            message_id = self._next_id
            self._next_id += 1
            future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
            self._pending[message_id] = future
            await self._socket.send(json.dumps({
                "id": message_id,
                "type": "call_service",
                "domain": domain,
                "service": service,
                "service_data": data,
            }))
        try:
            result = await asyncio.wait_for(future, timeout=15)
        finally:
            self._pending.pop(message_id, None)
        if not result.get("success"):
            raise RuntimeError(result.get("error", {}).get("message", "Home Assistant service call failed"))
        response = result.get("result")
        return response if isinstance(response, list) else []

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
        delay = 1
        while not self._stop.is_set():
            try:
                await self._stream()
                delay = 1
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning("Home Assistant event stream disconnected: %s", error)
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                delay = min(delay * 2, 30)

    async def _stream(self) -> None:
        async with websockets.connect(self.settings.websocket_url) as socket:
            self._socket = socket
            hello = json.loads(await socket.recv())
            if hello.get("type") != "auth_required":
                raise RuntimeError("Unexpected Home Assistant WebSocket greeting")
            await socket.send(json.dumps({"type": "auth", "access_token": self.settings.ha_token}))
            auth = json.loads(await socket.recv())
            if auth.get("type") != "auth_ok":
                raise RuntimeError("Home Assistant WebSocket authentication failed")
            await socket.send(json.dumps({"id": 1, "type": "subscribe_events", "event_type": "state_changed"}))
            subscription = json.loads(await socket.recv())
            if not subscription.get("success"):
                raise RuntimeError("Home Assistant event subscription failed")
            self._connected.set()
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

    async def broadcast(self, message: dict[str, Any]) -> None:
        for queue in tuple(self.subscribers):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            queue.put_nowait(message)
