#!/usr/bin/env python3
"""Offline protocol tests. Real locked multipart builder; synthetic Cloudflare only."""
import base64
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('direct933', ROOT/'tools/hub-933-direct-candidate.py')
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d); p = d.p
BASE = '44fd04c8-3a37-42c5-9718-62f669c3e5df'
NEW = '12345678-1234-1234-1234-123456789abc'


def token(single=False, expired=False):
    claims = {'exp': time.time() + (-100 if expired else 3600), 'wrangler_single_asset_uploads': single}
    return 'synthetic.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.synthetic'


class Fake:
    def __init__(self, snapshot, modules, offline):
        self.snapshot, self.modules, self.offline = deepcopy(snapshot), modules, offline
        self.posts = []; self.reads = 0; self.fail = None; self.single = False; self.zero = False
        self.unknown = False; self.duplicate = False; self.race = False; self.post_race = False
        self.no_completion = False; self.bad_etag = False; self.extra_bindings = False
        self.upload_token = token(); self.complete_token = token()

    def reader(self, client):
        self.reads += 1
        value = deepcopy(self.snapshot)
        if self.race and self.reads == 2: value['latest'] = 'concurrent'
        return value, self.modules

    def post(self, path, body, mime, upload_token=None):
        self.posts.append((path, body, mime, upload_token))
        if self.fail == path: raise p.GuardError('Synthetic uncertain outcome; no retry')
        if path == d.SESSION:
            manifest = json.loads(body)['manifest']; self.manifest = manifest
            h = manifest['/apps/board.js']['hash']
            hashes = ['unknown'] if self.unknown else [h]
            if self.duplicate: hashes += hashes
            return 200, {'buckets': [] if self.zero else [hashes], 'jwt': token(self.single)}
        if path == d.UPLOAD or path.startswith(d.SINGLE_PREFIX):
            return (202, {}) if self.no_completion else (201, {'jwt': self.complete_token})
        if path == d.VERSION:
            return 200, {'id': NEW}
        raise AssertionError('Unexpected POST')

    def request(self, path, raw=False):
        script = '/workers/scripts/' + p.WORKER
        if path == script + '/deployments':
            return {'deployments': [{'versions': [{'version_id': 'other' if self.post_race else BASE, 'percentage': 100}]}]}
        if path == script + '/versions': return {'items': [{'id': NEW}]}
        if path == script + '/versions/' + NEW:
            bindings = deepcopy(self.snapshot['settings']['bindings'])
            if self.extra_bindings: bindings.append({'name': 'unknown', 'type': 'secret_text'})
            return {'resources': {'script': {'etag': 'different' if self.bad_etag else self.snapshot['script_etag']},
                    'bindings': bindings, 'script_runtime': self.snapshot['runtime']}}
        if path == '/workers/domains?hostname=' + p.HOSTNAME: return self.snapshot['domains']
        if path == script + '/settings': return self.snapshot['settings']
        if path == script + '/content/v2':
            return d.encode_multipart([('worker.js', 'application/javascript+module', self.offline['worker.js']),
                                       ('worker.js.map', 'application/source-map', self.offline['worker.js.map'])])
        raise AssertionError('Unexpected GET')


class Protocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='hub-933-direct-offline-')
        cls.directory = Path(cls.temp.name)/'prepared'
        with redirect_stdout(io.StringIO()): p.offline_candidate(ROOT, ROOT, d.APPROVED_MERGE, cls.directory)
        cls.assets = {n: (cls.directory/'assets'/n.lstrip('/')).read_bytes()
                      for n in json.loads((cls.directory/'candidate-ledger.json').read_text())}
        cls.parts = p.parse_multipart((cls.directory/'actual.multipart').read_bytes())
        cls.original = {n: (cls.directory/'code'/n).read_bytes() for n in ['worker.js', 'worker.js.map']}
        cls.snapshot = {'active': BASE, 'latest': BASE, 'percentage': 100, 'main_sha': p.EXECUTABLE_SHA,
            'script_etag': 'a'*64, 'source_hashes': p.ORIGINAL_HASHES, 'settings': p.synthetic_settings(),
            'domains': [{'hostname': p.HOSTNAME, 'service': p.WORKER, 'enabled': True}],
            'runtime': {'assets': p.KNOWN_ASSETS, 'compatibility_date': '2026-10-17',
                        'compatibility_flags': ['nodejs_compat'], 'usage_model': 'standard'}}
        cls.manifest = d.manifest_for(cls.assets)

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def fake(self): return Fake(self.snapshot, self.original, self.parts)

    def run_candidate(self, fake, assets=None):
        # Cached locked BLAKE3 output only; all validation/protocol branches remain real.
        with patch.object(d, 'manifest_for', return_value=self.manifest) if assets is None else patch.object(d, 'manifest_for', wraps=d.manifest_for):
            return d.create_inactive_candidate(fake, self.assets if assets is None else assets, self.parts,
                                                self.snapshot, snapshot_reader=fake.reader)

    def test_bulk_exact_requested_hash_base64_mime_and_metadata(self):
        fake = self.fake(); result = self.run_candidate(fake)
        self.assertFalse(result['activated']); self.assertTrue(result['active_unchanged'])
        self.assertEqual([x[0] for x in fake.posts], [d.SESSION, d.UPLOAD, d.VERSION])
        upload = p.parse_multipart(fake.posts[1][1], fake.posts[1][2])
        h = self.manifest['/apps/board.js']['hash']; self.assertEqual(set(upload), {h})
        self.assertEqual(base64.b64decode(upload[h]), self.assets['/apps/board.js'])
        self.assertIn(b'Content-Type: text/javascript; charset=utf-8', fake.posts[1][1])
        version = p.parse_multipart(fake.posts[2][1], fake.posts[2][2]); md = json.loads(version['metadata'])
        original_md = json.loads(self.parts['metadata'])
        self.assertEqual(set(md)-set(original_md), {'assets'})
        self.assertTrue(all(md[k] == v for k, v in original_md.items()))
        self.assertEqual(md['assets']['config'], {'html_handling': 'none', 'run_worker_first': True, 'base_path': '/'})
        self.assertEqual(version['worker.js'], self.parts['worker.js'])
        self.assertEqual(version['worker.js.map'], self.parts['worker.js.map'])

    def test_vendor_single_hash_route_sends_raw_bytes(self):
        fake = self.fake(); fake.single = True; self.run_candidate(fake)
        h = self.manifest['/apps/board.js']['hash']
        self.assertEqual(fake.posts[1][0], d.SINGLE_PREFIX+h)
        self.assertEqual(fake.posts[1][1], self.assets['/apps/board.js'])
        self.assertEqual(fake.posts[1][2], 'text/javascript; charset=utf-8')

    def test_zero_missing_assets_reuses_completion_without_upload(self):
        fake = self.fake(); fake.zero = True; self.run_candidate(fake)
        self.assertEqual([x[0] for x in fake.posts], [d.SESSION, d.VERSION])

    def test_bad_requested_hash_or_duplicates_never_upload_or_create_version(self):
        for flag in ['unknown', 'duplicate']:
            fake = self.fake(); setattr(fake, flag, True)
            with self.assertRaises(p.GuardError): self.run_candidate(fake)
            self.assertEqual(len(fake.posts), 1)

    def test_no_completion_no_version(self):
        fake = self.fake(); fake.no_completion = True
        with self.assertRaises(p.GuardError): self.run_candidate(fake)
        self.assertEqual([x[0] for x in fake.posts], [d.SESSION, d.UPLOAD])

    def test_each_uncertain_operation_gets_one_attempt(self):
        for path in [d.SESSION, d.UPLOAD, d.VERSION]:
            fake = self.fake(); fake.fail = path
            with self.assertRaises(p.GuardError): self.run_candidate(fake)
            self.assertEqual(sum(x[0] == path for x in fake.posts), 1)

    def test_race_before_version_upload_stops_candidate_creation(self):
        fake = self.fake(); fake.race = True
        with self.assertRaises(p.GuardError): self.run_candidate(fake)
        self.assertNotIn(d.VERSION, [x[0] for x in fake.posts])

    def test_post_candidate_conflicts_cause_no_followup_writes(self):
        for flag in ['post_race', 'bad_etag', 'extra_bindings']:
            fake = self.fake(); setattr(fake, flag, True)
            with self.assertRaises(p.GuardError): self.run_candidate(fake)
            self.assertEqual([x[0] for x in fake.posts], [d.SESSION, d.UPLOAD, d.VERSION])

    def test_late_active_or_latest_change_after_content_is_rejected(self):
        for mode in ['active', 'latest']:
            fake = self.fake(); original_request = fake.request
            def request(path, raw=False):
                value = original_request(path, raw=raw)
                if path.endswith('/content/v2'):
                    if mode == 'active': fake.post_race = True
                    else: fake.late_latest = True
                if path.endswith('/versions') and getattr(fake, 'late_latest', False):
                    return {'items': [{'id': 'concurrent'}]}
                return value
            fake.request = request
            with self.assertRaises(p.GuardError): self.run_candidate(fake)
            self.assertEqual(len(fake.posts), 3)

    def test_full_settings_unknown_field_and_changed_value_rejected(self):
        for mode in ['unknown', 'plain', 'annotation']:
            fake = self.fake(); original_request = fake.request
            def request(path, raw=False):
                value = original_request(path, raw=raw)
                if path.endswith('/settings'):
                    value = deepcopy(value)
                    if mode == 'unknown': value['unexpected_global'] = {'enabled': True}
                    elif mode == 'plain': value['bindings'][0]['text'] = 'changed-private-value'
                    else: value['annotations'] = {'workers/triggered_by': 'changed'}
                return value
            fake.request = request
            with self.assertRaises(p.GuardError): self.run_candidate(fake)
            self.assertEqual(len(fake.posts), 3)

    def test_summary_has_equal_full_fingerprints_without_private_values(self):
        result = self.run_candidate(self.fake())
        self.assertEqual(result['before_fingerprints'], result['after_fingerprints'])
        self.assertEqual(result['before_fingerprints'], p.fingerprints(self.snapshot['settings'], self.snapshot['runtime'], self.snapshot['domains']))
        self.assertNotIn('synthetic-private-value', json.dumps(result))
        self.assertNotIn('approved_merge', result)  # The runner verifies GitHub, this library does not.

    def test_asset_mutation_rejected_before_any_post(self):
        fake = self.fake(); changed = dict(self.assets); changed['/apps/board.js'] += b'x'
        with self.assertRaises(p.GuardError): self.run_candidate(fake, changed)
        self.assertEqual(fake.posts, [])

    def test_tokens_expired_malformed_or_missing_fail_without_printing_values(self):
        for value in ['', 'malformed', token(expired=True)]:
            with self.assertRaises(p.GuardError): d.validate_token(value)

    def test_transport_allowlist_excludes_activation_settings_secrets_routes(self):
        transport = d.CandidateTransport('synthetic', 'synthetic')
        for path in ['/workers/domains', '/workers/scripts/'+p.WORKER+'/deployments',
                     '/workers/scripts/'+p.WORKER+'/secrets', '/workers/scripts/'+p.WORKER+'/settings',
                     d.SINGLE_PREFIX+'../unexpected']:
            with self.assertRaises(p.GuardError): transport.post(path, b'{}', 'application/json')

    def test_transport_uncertain_post_cannot_be_resent(self):
        transport = d.CandidateTransport('synthetic', 'synthetic')
        with patch.object(d.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = TimeoutError()
            for _ in range(2):
                with self.assertRaises(p.GuardError): transport.post(d.VERSION, b'{}', 'application/json')
            self.assertEqual(build.return_value.open.call_count, 1)

    def test_transport_rejects_credential_domain_mixups_before_network(self):
        transport = d.CandidateTransport('synthetic', 'synthetic')
        with patch.object(d.urllib.request, 'build_opener') as build:
            for path, upload_token in [(d.VERSION, token()), (d.SESSION, token()), (d.UPLOAD, None)]:
                with self.assertRaises(p.GuardError): transport.post(path, b'{}', 'application/json', upload_token)
            self.assertEqual(build.call_count, 0)


if __name__ == '__main__': unittest.main()
