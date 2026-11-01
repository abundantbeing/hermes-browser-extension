"""Companion roster: real HTTP requests, auth and served-profile boundaries."""
import asyncio
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
except ImportError as exc:
    raise unittest.SkipTest('aiohttp is required for companion HTTP tests') from exc

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('test_roster_plugin', ROOT / 'companion-plugin' / '__init__.py', submodule_search_locations=[str(ROOT / 'companion-plugin')])
assert SPEC is not None and SPEC.loader is not None
PLUGIN = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PLUGIN
SPEC.loader.exec_module(PLUGIN)
profile_routes = PLUGIN.profile_routes

class Adapter:
    gateway_runner = SimpleNamespace(config=SimpleNamespace(multiplex_profiles=True))
    def _expected_api_key(self) -> str:
        return 'owner-key'
    def _check_auth(self, request):
        if request.headers.get('Authorization') == 'Bearer owner-key':
            return None
        return web.json_response({'error': 'unauthorized'}, status=401)

class ProfileRoutesTests(unittest.TestCase):
    def test_roster_and_avatar_require_owner_auth_and_never_return_paths(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                home = root / 'worker'
                (home / 'assets').mkdir(parents=True)
                (home / 'assets' / 'avatar.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
                served = {'worker': home}
                rows = [{'name': 'worker', 'has_avatar': True}]
                app = web.Application()
                profile_routes.make_wire_extra()(app.router, Adapter())
                with patch.object(profile_routes, '_served_profiles', return_value=served), patch.object(profile_routes, '_build_roster', return_value=rows):
                    async with TestClient(TestServer(app)) as client:
                        base = '/api/plugins/hermes-browser-extension/profiles'
                        self.assertEqual((await client.get(base)).status, 401)
                        self.assertEqual((await client.get(base, headers={'Authorization': 'Bearer wrong'})).status, 401)
                        ok = await client.get(base, headers={'Authorization': 'Bearer owner-key'})
                        self.assertEqual(ok.status, 200)
                        self.assertEqual(ok.headers['Cache-Control'], 'no-store')
                        body = await ok.json()
                        self.assertEqual(body['profiles'], rows)
                        self.assertNotIn(str(root), json.dumps(body))
                        self.assertEqual((await client.get(base + '/worker/avatar')).status, 401)
                        image = await client.get(base + '/worker/avatar', headers={'Authorization': 'Bearer owner-key'})
                        self.assertEqual(image.status, 200)
                        self.assertEqual(image.content_type, 'image/png')
                        with patch.object(profile_routes, 'MAX_AVATAR', 8):
                            too_large = await client.get(base + '/worker/avatar', headers={'Authorization': 'Bearer owner-key'})
                            self.assertEqual(too_large.status, 404)
                        with patch.object(profile_routes, '_build_roster', side_effect=RuntimeError('fixture')):
                            with self.assertLogs(profile_routes.logger, level='ERROR'):
                                unavailable = await client.get(base, headers={'Authorization': 'Bearer owner-key'})
                            self.assertEqual(unavailable.status, 503)
                        missing = await client.get(base + '/other/avatar', headers={'Authorization': 'Bearer owner-key'})
                        self.assertEqual(missing.status, 404)
                        self.assertEqual((await client.post(base, headers={'Authorization': 'Bearer owner-key'})).status, 405)
        asyncio.run(exercise())

    def test_missing_auth_implementation_fails_closed(self):
        async def exercise():
            app = web.Application()
            profile_routes.make_wire_extra()(app.router, object())
            async with TestClient(TestServer(app)) as client:
                result = await client.get('/api/plugins/hermes-browser-extension/profiles')
                self.assertEqual(result.status, 401)
        asyncio.run(exercise())

    def test_extension_fetches_roster_end_to_end_from_companion(self):
        async def exercise():
            app = web.Application()
            profile_routes.make_wire_extra()(app.router, Adapter())
            with patch.object(profile_routes, '_build_roster', return_value=[{'name': 'worker'}]):
                async with TestClient(TestServer(app)) as client:
                    script = '''import { fetchRosterFromGatewayApi } from "./extension/lib/desktop-roster.mjs";
const result = await fetchRosterFromGatewayApi({gatewayUrl: process.argv[1], apiKey: "owner-key"});
console.log(JSON.stringify(result.profiles.map(row => row.name)));'''
                    process = await asyncio.create_subprocess_exec(
                        'node', '--input-type=module', '-e', script,
                        str(client.make_url('/')).rstrip('/'), cwd=str(ROOT),
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    stdout, stderr = await process.communicate()
                    self.assertEqual(process.returncode, 0, stderr.decode())
                    self.assertEqual(json.loads(stdout), ['worker'])
        asyncio.run(exercise())

    def test_future_profile_prefixed_mirror_is_refused(self):
        async def exercise():
            app = web.Application()
            class MirrorRouter:
                def add_get(self, path, handler):
                    app.router.add_get(path, handler)
                    app.router.add_get('/p/{profile}' + path, handler)
            profile_routes.make_wire_extra()(MirrorRouter(), Adapter())
            async with TestClient(TestServer(app)) as client:
                headers = {'Authorization': 'Bearer owner-key'}
                base = '/p/worker/api/plugins/hermes-browser-extension/profiles'
                self.assertEqual((await client.get(base, headers=headers)).status, 404)
                self.assertEqual((await client.get(base + '/worker/avatar', headers=headers)).status, 404)
        asyncio.run(exercise())

    def test_unconfigured_key_fails_closed_even_if_runtime_auth_allows(self):
        async def exercise():
            class NoKey(Adapter):
                def _expected_api_key(self):
                    return ''
                def _check_auth(self, request):
                    return None
            app = web.Application()
            profile_routes.make_wire_extra()(app.router, NoKey())
            async with TestClient(TestServer(app)) as client:
                response = await client.get('/api/plugins/hermes-browser-extension/profiles')
                self.assertEqual(response.status, 401)
        asyncio.run(exercise())

    def test_bot_metadata_allowlist_excludes_other_private_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / 'profile.yaml').write_text('fixture')
            data = {'ui_meta': {'hermes-bots': {'title': 'Worker', 'color': 'blue', 'secret': 'private-value'},
                                'other-plugin': {'token': 'private-value'}},
                    '_ui_meta_revisions': {'hermes-bots': 4, 'other-plugin': 5}}
            with patch.dict(sys.modules, {'hermes_yaml': SimpleNamespace(safe_load=lambda _: data)}):
                meta, revisions = profile_routes._bot_metadata(home)
            self.assertEqual(meta, {'hermes-bots': {'title': 'Worker', 'color': 'blue'}})
            self.assertEqual(revisions, {'hermes-bots': 4})
            self.assertNotIn('private-value', json.dumps(meta))

    def test_unserved_profiles_do_not_appear_in_roster(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = Path(tmp) / 'worker'
            worker.mkdir()
            rows = [SimpleNamespace(name='worker', is_default=False, model='m', provider='p', description='', display_name='Worker', skill_count=0),
                    SimpleNamespace(name='unserved', is_default=False, model='', provider='', description='', display_name='', skill_count=0)]
            with patch.object(profile_routes, '_served_profiles', return_value={'worker': worker}), patch.object(profile_routes, '_list_profiles', return_value=rows):
                result = profile_routes._build_roster(Adapter())
            self.assertEqual([row['name'] for row in result], ['worker'])
            self.assertNotIn(str(worker), json.dumps(result))

if __name__ == '__main__':
    unittest.main()
