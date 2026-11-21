"""Bounded, scalar-only local traces. Backend clocks never align with browser clocks."""
from __future__ import annotations

from collections import deque
from contextlib import contextmanager
import hashlib
import math
from pathlib import Path
import threading
import time
import uuid

_ROOT = Path(__file__).resolve().parent
_REVISION = "sha256:" + hashlib.sha256(b"".join(
    (_ROOT / name).read_bytes() for name in ("telemetry.py", "pipeline.py", "wayback.py", "detector.py")
)).hexdigest()
_NAMES = {"job", "clip", "model.load", "imagery", "inference", "export.output", "export.zip"}
_FIELDS = {"jobId", "clipId", "parentId", "modelKey", "modelFingerprint", "provider", "stage", "zoom", "width", "height", "bytes", "objects"}


class Trace:
    def __init__(self, limit=256, clock=time.perf_counter):
        if not isinstance(limit, int) or not 8 <= limit <= 1024:
            raise ValueError("Invalid diagnostic limit")
        self._clock, self._origin, self._last = clock, clock(), 0.0
        self._lock = threading.RLock()
        self._events, self._active = deque(maxlen=limit), {}
        self._sequence = self._ids = self._dropped = self._omitted = 0
        self._counters = {}
        self.context = {"id": "backend:" + str(uuid.uuid4()), "kind": "backend", "timeOrigin": None, "revision": _REVISION}

    def _stamp(self):
        value = (self._clock() - self._origin) * 1000
        if math.isfinite(value):
            self._last = max(self._last, value)
        return self._last

    def _emit(self, event):
        if len(self._events) == self._events.maxlen:
            self._dropped += 1
        self._sequence += 1
        self._events.append({"contextId": self.context["id"], "contextKind": "backend", "timeOrigin": None,
                             "sequence": self._sequence, **event})

    @contextmanager
    def span(self, name, **tags):
        if name not in _NAMES:
            raise ValueError("Unknown diagnostic operation")
        data = {key: value[:160] if isinstance(value, str) else value for key, value in tags.items()
                if key in _FIELDS and (isinstance(value, str) or isinstance(value, (int, float)) and math.isfinite(value))}
        with self._lock:
            self._ids += 1
            ident, start = self.context["id"] + ":" + str(self._ids), self._stamp()
            tracked = len(self._active) < 64
            if tracked:
                self._active[ident] = {"id": ident, "name": name, "startMs": start}
            else:
                self._omitted += 1
            self._emit({"type": "start", "id": ident, "name": name, "atMs": start, **data})
        status, error_name = "ok", None
        try:
            yield ident
        except BaseException as error:
            status = "cancelled" if type(error).__name__ == "CancelledError" else "error"
            error_name = type(error).__name__[:80]
            raise
        finally:
            with self._lock:
                end = self._stamp()
                self._active.pop(ident, None)
                if not tracked:
                    self._omitted -= 1
                self._emit({"type": "end", "id": ident, "name": name, "startMs": start, "atMs": end,
                            "durationMs": end - start, **data, "status": status, "errorName": error_name})

    def count(self, name, value):
        if name not in {"rasterBytes", "encodedBytes", "archiveBytes"} or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            return
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + value

    def snapshot(self):
        with self._lock:
            return {"version": 1, "context": dict(self.context), "limit": self._events.maxlen,
                    "droppedEvents": self._dropped, "omittedActive": self._omitted, "active": [dict(v) for v in self._active.values()],
                    "counters": dict(self._counters), "events": [dict(v) for v in self._events]}
