"""Companion control: session-store resolution across API-server adapter shapes.

Hermes exposes the API server's session store in two different shapes depending on
build:

* older builds: ``adapter._ensure_session_db_async()`` returns an object with
  ``get_session(session_id)``;
* current builds: ``adapter._ensure_store_async()`` exists, and the session handle
  comes from ``gateway.platforms.api_server_store.adapter_persistence(adapter)``,
  whose ``.aio.sessions.get`` is the lookup — this is the route core itself uses in
  ``_get_existing_session_or_404``.

``_session_known`` is fail-closed: any shape it cannot resolve must raise
``LookupError`` so registration is refused (503), never allowed. These tests pin
both shapes and every fail-closed branch; resolving only the old name makes the
first branch raise on every current build, which surfaces to the person as
"Hermes Control — RECONNECTING — Session database unavailable" even though the
database itself is healthy.
"""
import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'test_control_store_plugin',
    ROOT / 'companion-plugin' / '__init__.py',
    submodule_search_locations=[str(ROOT / 'companion-plugin')],
)
assert SPEC is not None and SPEC.loader is not None
PLUGIN = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PLUGIN
SPEC.loader.exec_module(PLUGIN)
control_routes = PLUGIN.control_routes


class LegacyAdapter:
    """Pre-rename shape: one opener returning a handle with ``get_session``."""

    def __init__(self, known):
        self.known = set(known)
        self.opened = 0

    async def _ensure_session_db_async(self):
        self.opened += 1
        known = self.known
        return SimpleNamespace(
            get_session=lambda session_id: {'id': session_id} if session_id in known else None)


class CurrentAdapter:
    """Current shape: ``_ensure_store_async`` plus ``adapter_persistence``."""

    def __init__(self, known):
        self.known = set(known)
        self.opened = 0

    async def _ensure_store_async(self):
        self.opened += 1
        return object()


class BareAdapter:
    """A runtime that offers no session store at all."""


def _handle(known):
    """A store handle with the surface ``_get_existing_session_or_404`` uses."""

    async def get(session_id):
        return {'id': session_id} if session_id in known else None

    return SimpleNamespace(aio=SimpleNamespace(sessions=SimpleNamespace(get=get)))


def _store_module(handle):
    module = ModuleType('gateway.platforms.api_server_store')
    setattr(module, 'adapter_persistence', lambda _adapter: handle)
    return module


def _modules(handle=None, *, absent=False):
    entry = None if absent else _store_module(handle)
    return {
        'gateway': ModuleType('gateway'),
        'gateway.platforms': ModuleType('gateway.platforms'),
        'gateway.platforms.api_server_store': entry,
    }


class SessionKnownTests(unittest.TestCase):
    def test_legacy_opener_reports_known_session(self):
        adapter = LegacyAdapter({'sess-1'})
        self.assertTrue(asyncio.run(control_routes._session_known(adapter, 'sess-1')))
        self.assertEqual(adapter.opened, 1)

    def test_legacy_opener_reports_unknown_session(self):
        adapter = LegacyAdapter({'sess-1'})
        self.assertFalse(asyncio.run(control_routes._session_known(adapter, 'other')))

    def test_current_adapter_reports_known_session(self):
        adapter = CurrentAdapter({'sess-1'})
        with patch.dict(sys.modules, _modules(_handle(adapter.known))):
            self.assertTrue(asyncio.run(control_routes._session_known(adapter, 'sess-1')))

    def test_current_adapter_reports_unknown_session(self):
        adapter = CurrentAdapter({'sess-1'})
        with patch.dict(sys.modules, _modules(_handle(adapter.known))):
            self.assertFalse(asyncio.run(control_routes._session_known(adapter, 'other')))

    def test_current_adapter_opens_store_before_lookup(self):
        adapter = CurrentAdapter({'sess-1'})
        with patch.dict(sys.modules, _modules(_handle(adapter.known))):
            asyncio.run(control_routes._session_known(adapter, 'sess-1'))
        self.assertEqual(adapter.opened, 1)

    def test_no_store_offered_fails_closed(self):
        with self.assertRaises(LookupError):
            asyncio.run(control_routes._session_known(BareAdapter(), 'sess-1'))

    def test_missing_store_module_fails_closed(self):
        adapter = CurrentAdapter({'sess-1'})
        with patch.dict(sys.modules, _modules(None, absent=True)), \
                self.assertRaises(LookupError):
            asyncio.run(control_routes._session_known(adapter, 'sess-1'))

    def test_store_offered_but_no_handle_fails_closed(self):
        adapter = CurrentAdapter({'sess-1'})
        with patch.dict(sys.modules, _modules(None)), self.assertRaises(LookupError):
            asyncio.run(control_routes._session_known(adapter, 'sess-1'))

    def test_lookup_error_is_raised_for_unreadable_store(self):
        class ExplodingAdapter(CurrentAdapter):
            async def _ensure_store_async(self):
                raise RuntimeError('disk on fire')

        with self.assertRaises(LookupError):
            asyncio.run(control_routes._session_known(ExplodingAdapter(set()), 'sess-1'))


if __name__ == '__main__':
    unittest.main()
