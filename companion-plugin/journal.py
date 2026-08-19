"""Metadata-only rotation journal for the Hermes Browser companion plugin.

Phase 8 Task 31: a bounded, owner-scoped journal of *what was delivered*
to the agent — never the payload itself.  Every row is validated metadata
derived from a stored Browser Context Protocol v2 record plus its
``browser_control`` envelope subset:

.. code-block:: python

    {
        "ts": float,               # observation time (clock seconds)
        "context_id": str,         # opaque capability id (never the payload)
        "payload_hash": str,       # provenance context hash (bounded)
        "scope": str,              # contextScope.mode
        "controller_id": str,      # redacted/owner-scoped controller id
        "browser_profile_id": str, # redacted/owner-scoped profile id
        "tab_id": int,             # opaque tab id
        "lease_owned": bool,       # lease_owned from the control envelope
        "delivery": str,           # e.g. "full"
    }

Contracts (exercised by tests/companion-plugin.test.mjs):

- **Metadata only.** The journal has no field for page text, DOM, selected
  text, typed values, URLs, arguments, or results; ``record`` refuses any
  row whose keys are outside the exact allowlist and whose values are not
  JSON-safe scalars/bools.

- **Owner-scoped.** Every row is bound to a fingerprint of the trusted
  Hermes owner tuple; ``rows_for_owner`` returns only that owner's rows.
  There is no unscoped "latest" accessor.

- **Deterministic rotation.** At most :data:`MAX_JOURNAL_ROWS` rows are
  retained; the oldest rows are dropped first, newest last, with no
  ordering ambiguity (insertion order is the tie-breaker).

- **Mode 0600.** When a durable ``data_dir`` is configured the journal
  file is created/rewritten with ``0600`` permissions where the platform
  supports it; a memory-only journal (tests, no data dir) needs no file.

- **Journaling never authorizes ``browser_get_context``.** This module is
  purely a diagnostic record; it has no path into the context store and
  live context retrieval still requires a live in-memory record plus the
  pre-tool ContextVar lease (see ``context_store`` / ``tools``).
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from time import time
from typing import Any, Callable, Optional

#: Hard cap on retained journal rows (deterministic rotation target).
MAX_JOURNAL_ROWS = 500
#: File mode applied to the durable journal file where supported.
JOURNAL_FILE_MODE = 0o600
#: Filename used inside the configured durable data dir.
JOURNAL_FILENAME = "journal.jsonl"
#: Exact allowed row keys. Anything else is refused — the journal can
#: structurally never grow page or payload fields.
JOURNAL_ROW_KEYS = frozenset(
    {
        "ts",
        "context_id",
        "payload_hash",
        "scope",
        "controller_id",
        "browser_profile_id",
        "tab_id",
        "lease_owned",
        "delivery",
    }
)
#: Bounds applied to string fields so a hostile envelope cannot bloat rows.
_STRING_LIMIT = 160
_JSON_SAFE_NUMBERS = (int, float)


class JournalError(Exception):
    """Base class for journal contract failures."""


def _owner_fingerprint(owner: Any) -> str:
    """Bind journal rows to the exact trusted execution owner tuple."""
    principal = str(getattr(owner, "principal_id", "") or "")
    session = str(getattr(owner, "session_id", "") or "")
    turn = str(getattr(owner, "turn_id", "") or "")
    task = str(getattr(owner, "task_id", "") or "")
    if not principal and not session:
        raise JournalError("journal owner must carry a trusted identity")
    import hashlib

    material = "\0".join((principal, session, turn, task)).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _bounded_string(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:_STRING_LIMIT]


def validate_journal_row(row: Any) -> dict[str, Any]:
    """Return a cleaned, JSON-safe row or raise :class:`JournalError`.

    Unknown keys, missing keys, non-scalar values, and out-of-type values
    all fail closed: a malformed row is refused rather than partially
    stored.
    """
    if not isinstance(row, dict):
        raise JournalError("journal row must be an object")
    if set(row) != JOURNAL_ROW_KEYS:
        extra = sorted(set(row) - JOURNAL_ROW_KEYS)
        missing = sorted(JOURNAL_ROW_KEYS - set(row))
        raise JournalError(f"journal row keys mismatch (extra={extra}, missing={missing})")

    ts = row["ts"]
    if isinstance(ts, bool) or not isinstance(ts, _JSON_SAFE_NUMBERS):
        raise JournalError("journal ts must be a number")
    context_id = _bounded_string(row["context_id"])
    if not context_id:
        raise JournalError("journal context_id is required")
    payload_hash = _bounded_string(row["payload_hash"])
    scope = _bounded_string(row["scope"]) or "unknown"
    controller_id = _bounded_string(row["controller_id"])
    browser_profile_id = _bounded_string(row["browser_profile_id"])
    tab_id = row["tab_id"]
    if isinstance(tab_id, bool) or not isinstance(tab_id, int) or tab_id < 0:
        raise JournalError("journal tab_id must be a non-negative integer")
    if not isinstance(row["lease_owned"], bool):
        raise JournalError("journal lease_owned must be a boolean")
    delivery = _bounded_string(row["delivery"]) or "unknown"

    return {
        "ts": float(ts),
        "context_id": context_id,
        "payload_hash": payload_hash,
        "scope": scope,
        "controller_id": controller_id,
        "browser_profile_id": browser_profile_id,
        "tab_id": tab_id,
        "lease_owned": row["lease_owned"],
        "delivery": delivery,
    }


@dataclass
class _JournalRow:
    owner: str
    row: dict[str, Any]


@dataclass
class BrowserContextJournal:
    """Thread-safe, owner-scoped, metadata-only rotation journal.

    Parameters
    ----------
    max_rows:
        Retained row cap; rotation drops the oldest rows deterministically.
    data_dir:
        Optional durable directory.  When set, the journal is persisted as
        ``journal.jsonl`` with mode ``0600`` where supported.  ``None``
        keeps the journal memory-only (still bounded and owner-scoped).
    clock:
        Injectable time source for deterministic tests.
    """

    max_rows: int = MAX_JOURNAL_ROWS
    data_dir: Optional[Path] = None
    clock: Callable[[], float] = time
    _rows: list[_JournalRow] = field(default_factory=list, init=False, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False, repr=False)

    def __post_init__(self) -> None:
        self.max_rows = max(1, int(self.max_rows))
        if self.data_dir is not None:
            self.data_dir = Path(self.data_dir)
            self._load_durable()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def row_count(self) -> int:
        """Number of retained rows (diagnostics/tests)."""
        with self._lock:
            return len(self._rows)

    def record(self, owner: Any, row: dict[str, Any]) -> dict[str, Any]:
        """Append one validated metadata row, rotating past the cap.

        Returns the stored (cleaned) row.  Raises :class:`JournalError` for
        a malformed row; an owner that cannot be fingerprinted also fails
        closed.
        """
        cleaned = validate_journal_row(row)
        owner_key = _owner_fingerprint(owner)
        with self._lock:
            self._rows.append(_JournalRow(owner=owner_key, row=cleaned))
            self._rotate_locked()
            if self.data_dir is not None:
                self._write_durable_locked()
        return dict(cleaned)

    def rows_for_owner(self, owner: Any, limit: int = 50) -> list[dict[str, Any]]:
        """Return the newest up-to-``limit`` metadata rows for one owner.

        ``limit`` is clamped to ``[1, max_rows]``.  The returned rows are
        deep-copied so callers cannot mutate journal state.
        """
        bounded = max(1, min(int(limit), self.max_rows))
        try:
            owner_key = _owner_fingerprint(owner)
        except JournalError:
            return []
        with self._lock:
            rows = [entry.row for entry in self._rows if entry.owner == owner_key]
        return [dict(row) for row in rows[-bounded:]]

    def clear(self) -> int:
        """Drop every row; return the number removed (tests/diagnostics)."""
        with self._lock:
            removed = len(self._rows)
            self._rows.clear()
            if self.data_dir is not None:
                self._write_durable_locked()
        return removed

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _rotate_locked(self) -> None:
        if len(self._rows) > self.max_rows:
            del self._rows[: len(self._rows) - self.max_rows]

    def _journal_path(self) -> Path:
        assert self.data_dir is not None
        return self.data_dir / JOURNAL_FILENAME

    def _load_durable(self) -> None:
        assert self.data_dir is not None
        path = self._journal_path()
        if not path.exists():
            return
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            return
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                blob = json.loads(line)
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if not isinstance(blob, dict) or set(blob) != {"owner", "row"}:
                continue
            owner = blob.get("owner")
            row = blob.get("row")
            if not isinstance(owner, str) or not isinstance(row, dict):
                continue
            try:
                cleaned = validate_journal_row(row)
            except JournalError:
                continue
            self._rows.append(_JournalRow(owner=owner, row=cleaned))
        self._rotate_locked()

    def _write_durable_locked(self) -> None:
        assert self.data_dir is not None
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            return
        lines = [
            json.dumps({"owner": entry.owner, "row": entry.row}, ensure_ascii=False)
            for entry in self._rows
        ]
        path = self._journal_path()
        payload = ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")
        temp = path.with_name(f"{path.name}.tmp")
        try:
            with open(temp, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.chmod(temp, JOURNAL_FILE_MODE)
            except OSError:
                pass
            os.replace(temp, path)
            try:
                os.chmod(path, JOURNAL_FILE_MODE)
            except OSError:
                pass
        except OSError:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass
