#!/usr/bin/env python3
"""Offline guards for operational deployment transport; never reaches a network."""
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deploy931', ROOT / 'tools/hub-931-content-deploy.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
NAMES = list(d.BASE_HASHES)


def modules(label):
    contents = [f'// {name}\nexport const marker = "{label}";\n' for name in NAMES]
    source_map = {'version': 3, 'file': 'worker.js', 'sources': NAMES, 'sourcesContent': contents}
    return [('worker.js', 'application/javascript+module', ('export default "' + label + '";').encode()),
            ('worker.js.map', 'application/source-map', json.dumps(source_map).encode())]


class FakeCloudflare:
    script = '/workers/scripts/' + d.WORKER

    def __init__(self, old, new):
        self.version = d.BASE_VERSION
        self.modules = old
        self.new = new
        self.uploads = []
        self.baseline_config = {'bindings': [{'name': 'ASSETS', 'type': 'assets'},
                                            {'name': 'TOKEN', 'type': 'secret_text'}]}
        self.fail_runtime = False
        self.concurrent = False
        self.bad_etag = False

    def active(self):
        return self.version

    def domain(self):
        return [{'hostname': d.HOSTNAME, 'service': d.WORKER, 'enabled': True}]

    def settings(self):
        return deepcopy(self.baseline_config)

    def runtime(self, version):
        if version == 'our-version' and self.fail_runtime:
            if self.concurrent:
                self.version = 'another-deployment'
            return {'assets': {'changed': True}}
        return {'assets': {'serve_directly': False}, 'compatibility_date': '2026-10-17'}

    def content(self):
        return self.modules

    def upload(self, value):
        self.uploads.append(value)
        self.modules = value
        self.version = 'our-version' if len(self.uploads) == 1 else 'rollback-version'
        return {'etag': 'wrong' if self.bad_etag else 'ours'}

    def request(self, path):
        return {'resources': {'script': {'etag': 'ours'}}}


class Guards(unittest.TestCase):
    def setUp(self):
        self.old, self.new = modules('old'), modules('new')
        self.base_patch = patch.object(d, 'BASE_HASHES', d.source_hashes(self.old))
        self.base_patch.start()
        self.addCleanup(self.base_patch.stop)
        self.wanted = d.source_hashes(self.new)

    def deploy(self, api):
        with patch('sys.stdout', new=io.StringIO()):
            d.deploy(api, self.new, self.wanted)

    def test_multipart_exact_metadata_mime_and_bytes(self):
        body, ct = d.multipart(self.new)
        message = d.BytesParser(policy=d.policy.default).parsebytes(
            ('Content-Type: ' + ct + '\r\n\r\n').encode() + body)
        parts = list(message.iter_parts())
        self.assertEqual(len(parts), 3)
        self.assertEqual(json.loads(parts[0].get_payload(decode=True)), {'main_module': 'worker.js'})
        self.assertEqual(parts[1].get_content_type(), 'application/javascript+module')
        self.assertEqual(parts[2].get_content_type(), 'application/source-map')
        self.assertEqual(parts[1].get_payload(decode=True), self.new[0][2])
        # GET /content contains only modules; construct that exact response shape.
        boundary = ct.split('boundary=', 1)[1]
        raw = body.split(b'\r\n--' + boundary.encode(), 1)[1]
        raw = b'--' + boundary.encode() + raw
        parsed = d.parse_modules(raw, ct)
        self.assertEqual(d.module_hashes(parsed), d.module_hashes(self.new))

    def test_malformed_and_incomplete_snapshots_rejected(self):
        with self.assertRaises(d.DeployError):
            d.parse_modules(b'incomplete', 'text/plain')
        with self.assertRaises(d.DeployError):
            d.parse_modules(b'--abc\r\n', 'multipart/form-data; boundary=abc')

    def test_extra_application_source_rejected(self):
        m = deepcopy(self.new)
        source = json.loads(m[1][2])
        source['sources'].append('src/unreviewed.js')
        source['sourcesContent'].append('unreviewed')
        m[1] = (m[1][0], m[1][1], json.dumps(source).encode())
        with self.assertRaises(d.DeployError):
            d.source_hashes(m)

    def test_external_outdir_paths_normalized_without_dependency_collision(self):
        m = deepcopy(self.new)
        source = json.loads(m[1][2])
        source['sources'] = ['../runtime/' + name for name in source['sources']]
        source['sources'].append('../runtime/node_modules/dependency/src/worker.js')
        source['sourcesContent'].append('dependency, not application')
        m[1] = (m[1][0], m[1][1], json.dumps(source).encode())
        self.assertEqual(d.source_hashes(m), self.wanted)

    def test_baseline_version_failure_writes_zero(self):
        api = FakeCloudflare(self.old, self.new)
        api.version = 'unexpected'
        with self.assertRaises(d.DeployError):
            self.deploy(api)
        self.assertEqual(api.uploads, [])

    def test_source_provenance_failure_writes_zero(self):
        api = FakeCloudflare(self.new, self.new)
        with self.assertRaises(d.DeployError):
            self.deploy(api)
        self.assertEqual(api.uploads, [])

    def test_domain_failure_writes_zero(self):
        api = FakeCloudflare(self.old, self.new)
        with patch.object(api, 'domain', side_effect=d.DeployError('domain changed')):
            with self.assertRaises(d.DeployError):
                self.deploy(api)
        self.assertEqual(api.uploads, [])

    def test_success_one_code_upload_preserves_config_and_sources(self):
        api = FakeCloudflare(self.old, self.new)
        self.deploy(api)
        self.assertEqual(len(api.uploads), 1)
        self.assertEqual(d.source_hashes(api.content()), self.wanted)
        self.assertEqual(api.active(), 'our-version')

    def test_failed_postcondition_never_adds_rollback_write(self):
        api = FakeCloudflare(self.old, self.new)
        api.fail_runtime = True
        with self.assertRaises(d.DeployError):
            self.deploy(api)
        self.assertEqual(len(api.uploads), 1)
        self.assertEqual(api.content(), self.new)

    def test_concurrent_deployment_never_rolled_back(self):
        api = FakeCloudflare(self.old, self.new)
        api.fail_runtime = api.concurrent = True
        with self.assertRaises(d.DeployError):
            self.deploy(api)
        self.assertEqual(len(api.uploads), 1)
        self.assertEqual(api.active(), 'another-deployment')

    def test_concurrent_change_during_post_content_read_never_overwritten(self):
        api = FakeCloudflare(self.old, self.new)
        original_content = api.content
        def racing_content():
            value = original_content()
            if api.uploads:
                api.version = 'another-deployment'
            return value
        with patch.object(api, 'content', side_effect=racing_content):
            with self.assertRaises(d.DeployError):
                self.deploy(api)
        self.assertEqual(len(api.uploads), 1)
        self.assertEqual(api.active(), 'another-deployment')

    def test_post_readback_transport_failure_never_retries_put(self):
        api = FakeCloudflare(self.old, self.new)
        original_content = api.content
        def failing_content():
            if api.uploads:
                raise d.DeployError('synthetic readback error')
            return original_content()
        with patch.object(api, 'content', side_effect=failing_content):
            with self.assertRaises(d.DeployError):
                self.deploy(api)
        self.assertEqual(len(api.uploads), 1)

    def test_uncertain_upload_ownership_never_rolled_back(self):
        api = FakeCloudflare(self.old, self.new)
        api.bad_etag = True
        with self.assertRaises(d.DeployError):
            self.deploy(api)
        self.assertEqual(len(api.uploads), 1)

    def test_cloudflare_forbids_every_other_write_path(self):
        api = d.Cloudflare.__new__(d.Cloudflare)
        api.script, api.base, api.token = FakeCloudflare.script, 'https://unused', 'synthetic'
        for path, method in [(api.script, 'PUT'), (api.script + '/content', 'POST'),
                             ('/d1/migrations', 'PUT'), ('/workers/domains', 'PUT')]:
            with self.assertRaises(d.DeployError):
                api.request(path, method=method)

    def test_merge_rejects_unmerged_pr_before_cloudflare(self):
        response = io.BytesIO(json.dumps({'merged': False}).encode())
        with patch.dict('os.environ', {'GITHUB_TOKEN': 'synthetic'}), \
                patch.object(d.subprocess, 'check_output', return_value='a' * 40), \
                patch.object(d, 'authenticated_open', return_value=response):
            with self.assertRaises(d.DeployError):
                d.verify_merge('a' * 40, ROOT)

    def test_redirect_handler_never_forwards_credentials(self):
        request = d.urllib.request.Request('https://api.cloudflare.com/test',
                                            headers={'Authorization': 'Bearer synthetic'})
        for status in [301, 302, 303, 307, 308]:
            with self.assertRaisesRegex(d.DeployError, 'redirect rejected'):
                d.NoRedirect().redirect_request(request, None, status, 'redirect', {}, 'https://other.invalid/')

    def test_both_bearer_transports_use_nonredirecting_opener(self):
        class Opener:
            def open(self, request, timeout):
                self.request = request
                raise d.DeployError('synthetic redirect rejected')
        opener = Opener()
        with patch.object(d.urllib.request, 'build_opener', return_value=opener) as build:
            with self.assertRaises(d.DeployError):
                d.authenticated_open(d.urllib.request.Request('https://api.github.com/test'), 1)
            self.assertIsInstance(build.call_args.args[0], d.NoRedirect)


if __name__ == '__main__':
    unittest.main()
