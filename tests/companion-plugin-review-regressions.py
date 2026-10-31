import importlib.util
import json
import pathlib
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

root = pathlib.Path(__file__).resolve().parents[1] / 'companion-plugin'
spec = importlib.util.spec_from_file_location('review_plugin', root / '__init__.py', submodule_search_locations=[str(root)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
storemod = sys.modules['review_plugin.context_store']
brokermod = sys.modules['review_plugin.control_broker']
tools = sys.modules['review_plugin.tools']
control_tools = sys.modules['review_plugin.control_tools']


def turn(hash_, page='', reference=False):
    delivery = 'reference' if reference else 'full'
    payload = {'protocol': 'hermes.browser.context.v1', 'contextScope': {'mode': 'follow-active'}, 'settings': {}, 'activeTab': {}, 'pageContext': {'text': page}, 'tabs': [], 'selectedTabs': []}
    bc = {'delivery': delivery, 'context_hash': hash_} if reference else {'delivery': delivery, 'payload': payload}
    return json.dumps({'protocol': 'hermes.browser.turn.v2', 'human_input': {'source': 'composer', 'text': 'test'}, 'browser_context': bc, 'attachment_context': {'items': []}, 'source_receipt': {'protocol': 'hermes.browser.turn.v2', 'version': 2, 'context_hash': hash_, 'delivery': delivery}})


class Regressions(unittest.TestCase):
    def test_interleaved_uploads_and_owner_fencing(self):
        for order in [('hashA', 'hashB'), ('hashB', 'hashA')]:
            store = storemod.BrowserContextStore()
            for h in ('hashA', 'hashB'):
                self.assertTrue(store.put_session_upload('session', turn(h, h))['available'])
            for h in order:
                owner = storemod.ContextOwner('principal', 'session', h, 'task')
                result = store.adopt_upload_for_owner(turn(h, reference=True), owner)
                self.assertTrue(result['available'], h)
                self.assertIsNone(store.consume_for_owner(result['context_id'], storemod.ContextOwner('other', 'session', h, 'task')))
                self.assertEqual(store.consume_for_owner(result['context_id'], owner)['payload']['pageContext']['text'], h)
                self.assertIsNone(store.consume_for_owner(result['context_id'], owner))

    def test_identical_hash_uploads_are_each_one_shot(self):
        store = storemod.BrowserContextStore()
        for _ in range(2):
            self.assertTrue(store.put_session_upload('session', turn('samehash', 'same'))['available'])
        for n in range(2):
            owner = storemod.ContextOwner('principal', 'session', str(n), 'task')
            result = store.adopt_upload_for_owner(turn('samehash', reference=True), owner)
            self.assertTrue(result['available'])
            self.assertIsNotNone(store.consume_for_owner(result['context_id'], owner))
        self.assertFalse(store.adopt_upload_for_owner(turn('samehash', reference=True), owner)['available'])

    def test_upload_bound_and_expiry(self):
        clock = [100.0]
        store = storemod.BrowserContextStore(clock=lambda: clock[0], max_upload_sessions=2, upload_ttl_seconds=10)
        store.put_session_upload('session', turn('one', 'one'))
        clock[0] += 1
        store.put_session_upload('session', turn('two', 'two'))
        store.put_session_upload('other', turn('three', 'three'))
        owner = storemod.ContextOwner('principal', 'session', 'turn', 'task')
        self.assertFalse(store.adopt_upload_for_owner(turn('one', reference=True), owner)['available'])
        self.assertFalse(store.adopt_upload_for_owner(turn('three', reference=True), owner)['available'])
        clock[0] += 11
        self.assertFalse(store.adopt_upload_for_owner(turn('two', reference=True), owner)['available'])

    def test_replacement_cancels_old_controller_and_reports_uncertainty(self):
        broker = brokermod.ControlBroker(command_timeout=2)
        caps = frozenset({'browser_click'})
        a = brokermod.ControllerScope('p', 'profile', 'session', 'A', 'browserA', 'local', caps)
        b = brokermod.ControllerScope('p', 'profile', 'session', 'B', 'browserB', 'local', caps)
        frames = []
        awaiting_approval = set()
        executed = []
        sent = threading.Event()
        def send(frame):
            frames.append(frame)
            if frame['method'] == brokermod.FRAME_COMMAND:
                awaiting_approval.add(frame['params']['command_id'])
                sent.set()
            elif frame['method'] == brokermod.FRAME_CANCEL:
                awaiting_approval.discard(frame['params']['command_id'])
        broker.attach(a, send, owner=object())
        outcome = []
        def dispatch():
            try:
                broker.dispatch(a, action='browser_click', tool_call_id='call')
            except Exception as exc:
                outcome.append(type(exc).__name__)
        worker = threading.Thread(target=dispatch)
        worker.start()
        self.assertTrue(sent.wait(1))
        broker.attach(b, lambda frame: None, owner=object())
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual([f['method'] for f in frames], [brokermod.FRAME_COMMAND, brokermod.FRAME_CANCEL])
        self.assertEqual(frames[0]['params']['command_id'], frames[1]['params']['command_id'])
        self.assertEqual(outcome, ['ControllerTimeout'])
        command_id = frames[0]['params']['command_id']
        if command_id in awaiting_approval:
            executed.append(command_id)  # a simulated late human approval
        self.assertFalse(executed)
        self.assertFalse(broker.complete(command_id, scope=a, ok=True, result='late'))

    def test_replacement_send_failure_is_uncertain(self):
        broker = brokermod.ControlBroker(command_timeout=2)
        caps = frozenset({'browser_click'})
        a = brokermod.ControllerScope('p', 'profile', 'session', 'A', 'browserA', 'local', caps)
        b = brokermod.ControllerScope('p', 'profile', 'session', 'B', 'browserB', 'local', caps)
        sent = threading.Event()
        def send(frame):
            if frame['method'] == brokermod.FRAME_CANCEL:
                raise ConnectionError('synthetic failed cancel')
            sent.set()
        broker.attach(a, send, owner=object())
        outcome = []
        def dispatch():
            try:
                broker.dispatch(a, action='browser_click', tool_call_id='call')
            except Exception as exc:
                outcome.append(type(exc).__name__)
        worker = threading.Thread(target=dispatch)
        worker.start()
        self.assertTrue(sent.wait(1))
        disabled = brokermod.logger.disabled
        brokermod.logger.disabled = True
        try:
            broker.attach(b, lambda frame: None, owner=object())
        finally:
            brokermod.logger.disabled = disabled
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(outcome, ['ControllerTimeout'])

    def test_expired_idle_payloads_are_removed(self):
        store = storemod.BrowserContextStore(ttl_seconds=0.05, upload_ttl_seconds=0.05)
        owner = storemod.ContextOwner('principal', 'session', 'turn', 'task')
        store.put_bcp_v2(turn('hashA', 'record'), owner)
        store.put_session_upload('session', turn('hashB', 'upload'))
        time.sleep(0.3)
        self.assertFalse(store._records, 'idle expired records retained')
        self.assertFalse(store._uploads, 'idle expired uploads retained')

    def test_base_also_retains_idle_records(self):
        source = subprocess.check_output(['git', 'show', 'origin/main:companion-plugin/context_store.py'], cwd=root.parent, text=True, encoding='utf8')
        import types
        base = types.ModuleType('review_plugin.base_context_store')
        base.__package__ = 'review_plugin'
        sys.modules[base.__name__] = base
        exec(compile(source, 'origin/main:companion-plugin/context_store.py', 'exec'), base.__dict__)
        store = base.BrowserContextStore(ttl_seconds=0.05)
        owner = base.ContextOwner('principal', 'session', 'turn', 'task')
        store.put_bcp_v2(turn('hashA', 'record'), owner)
        time.sleep(0.3)
        self.assertTrue(store._records, 'base retained no expired record')

    def test_expired_idle_upload_is_removed(self):
        store = storemod.BrowserContextStore(upload_ttl_seconds=0.05)
        store.put_session_upload('session', turn('hashB', 'upload'))
        time.sleep(0.3)
        self.assertFalse(store._uploads, 'idle expired uploads retained')

    def test_expired_idle_runtime_lease_is_removed(self):
        old_ttl = tools._LEASE_TTL_SECONDS
        tools._LEASE_TTL_SECONDS = 0.05
        try:
            tools.grant_lease('get', {'payload': 'sentinel'}, 'ctx', identity=('session', 'task'))
            time.sleep(0.3)
            self.assertFalse(tools._RUNTIME_LEASES, 'idle expired runtime leases retained')
        finally:
            tools._LEASE_TTL_SECONDS = old_ttl
            tools._RUNTIME_LEASES.clear()
            tools._LEASES.set({})

    def test_contextvar_only_lease_is_wiped_while_idle(self):
        old_ttl = tools._LEASE_TTL_SECONDS
        tools._LEASE_TTL_SECONDS = 0.05
        try:
            tools.grant_lease('get', {'payload': 'context-only'}, 'only')
            lease = tools._LEASES.get()['get:only']
            time.sleep(0.3)
            self.assertIsNone(lease.result, 'contextvar still owns the raw result')
        finally:
            tools._LEASE_TTL_SECONDS = old_ttl
            tools.clear_leases()

    def test_lease_shared_context_is_wiped_after_cross_context_consume(self):
        import contextvars
        tools.grant_lease('get', {'payload': 'cross-context'}, 'cross', identity=('s', 't'))
        lease = tools._LEASES.get()['get:cross']
        result = contextvars.Context().run(tools._take_lease, 'get', 'cross', identity=('s', 't'))
        self.assertEqual(result['payload'], 'cross-context')
        self.assertIsNone(lease.result, 'original context still owns consumed payload')
        self.assertIsNone(tools._take_lease('get', 'cross', identity=('s', 't')))
        tools.clear_leases()

    def test_store_close_wipes_and_stops_expiry_worker(self):
        store = storemod.BrowserContextStore(ttl_seconds=60, upload_ttl_seconds=60)
        owner = storemod.ContextOwner('principal', 'session', 'turn', 'task')
        store.put_bcp_v2(turn('hashA', 'record'), owner)
        store.put_session_upload('session', turn('hashB', 'upload'))
        record = next(iter(store._records.values()))
        upload = next(iter(store._uploads.values()))
        store.close()
        self.assertIsNone(record.payload)
        self.assertIsNone(upload.normalized['payload'])
        self.assertFalse(store._records)
        self.assertFalse(store._uploads)
        self.assertFalse(store._expiry.is_alive())

    def test_lease_clear_wipes_context_copy_and_stops_worker(self):
        tools.grant_lease('get', {'payload': 'clear'}, 'clear', identity=('s', 't'))
        lease = tools._LEASES.get()['get:clear']
        tools.clear_leases()
        self.assertIsNone(lease.result)
        self.assertFalse(tools._RUNTIME_LEASES)
        self.assertFalse(tools._expiry.is_alive())

    def test_old_screenshot_removed_on_restart_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            shot = pathlib.Path(directory) / 'shot-old.png'
            shot.write_bytes(b'synthetic')
            old = time.time() - 7200
            os.utime(shot, (old, old))
            control_tools.configure(screenshot_dir=directory)
            self.assertFalse(shot.exists(), 'stale screenshot survives restart configuration')

    def test_screenshot_is_removed_during_idle(self):
        def restart_reaper():
            # The reaper sleeps a whole interval between looks: stop it, so the next one starts on the new clock.
            control_tools._screenshot_stop.set()
            if control_tools._screenshot_worker is not None:
                control_tools._screenshot_worker.join(2)
            control_tools._ensure_screenshot_worker()

        with tempfile.TemporaryDirectory() as directory:
            control_tools.configure(screenshot_dir=directory)
            old_ttl = control_tools._SCREENSHOT_MAX_AGE_SECONDS
            old_interval = control_tools._SCREENSHOT_PRUNE_INTERVAL_SECONDS
            control_tools._SCREENSHOT_MAX_AGE_SECONDS = 0.05
            control_tools._SCREENSHOT_PRUNE_INTERVAL_SECONDS = 0.05
            restart_reaper()
            try:
                shot = pathlib.Path(control_tools._save_screenshot('data:image/png;base64,c3ludGhldGlj'))
                time.sleep(0.3)
                self.assertFalse(shot.exists(), 'idle screenshot retained after expiry')
            finally:
                control_tools._SCREENSHOT_MAX_AGE_SECONDS = old_ttl
                control_tools._SCREENSHOT_PRUNE_INTERVAL_SECONDS = old_interval
                restart_reaper()

if __name__ == '__main__':
    unittest.main()
