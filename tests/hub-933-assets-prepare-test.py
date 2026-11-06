#!/usr/bin/env python3
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare933', ROOT/'tools/hub-933-assets-prepare.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
VERSION = '44fd04c8-3a37-42c5-9718-62f669c3e5df'


def fixture():
    bindings = [{'name': n, 'type': 'plain_text', 'text': 'synthetic-private-value'} for n in sorted(p.PLAIN_NAMES)]
    bindings += [{'name': n, 'type': 'secret_text'} for n in sorted(p.SECRET_NAMES)]
    bindings += [{'name': 'HUB_DB', 'type': 'd1', 'id': 'synthetic-database'}, {'name': 'ASSETS', 'type': 'assets'}]
    return {'placement': {'mode': 'off'}, 'compatibility_date': '2026-10-17',
            'compatibility_flags': ['nodejs_compat'], 'usage_model': 'standard', 'tags': ['owner-tag'],
            'tail_consumers': [], 'logpush': False, 'annotations': {'workers/triggered_by': 'secret'}, 'bindings': bindings}


def snapshot():
    return {'active': VERSION, 'latest': VERSION, 'percentage': 100, 'main_sha': p.EXECUTABLE_SHA,
            'script_etag': 'a'*64,
            'source_hashes': p.ORIGINAL_HASHES,
            'domains': [{'hostname': p.HOSTNAME, 'service': p.WORKER, 'enabled': True}],
            'runtime': {'assets': p.KNOWN_ASSETS, 'compatibility_date': '2026-10-17',
                        'compatibility_flags': ['nodejs_compat'], 'usage_model': 'standard'}, 'settings': fixture()}


class Guards(unittest.TestCase):
    def test_exact14_binding_snapshot_and_config(self):
        settings = fixture()
        p.snapshot_guard(snapshot(), VERSION)
        config = p.config_for(settings, '/synthetic/private')
        self.assertEqual(len(config['unsafe']['bindings']), 13)
        self.assertTrue(all(b['type'] == 'inherit' for b in config['unsafe']['bindings']))
        self.assertNotIn('synthetic-private-value', json.dumps(config))
        self.assertNotIn('synthetic-database', json.dumps(config))
        self.assertNotIn('routes', config)
        self.assertNotIn('tags', config)

    def test_unknown_settings_bindings_and_fields_rejected(self):
        changes = []
        s = fixture(); s['limits'] = {'cpu_ms': 10}; changes.append(s)
        s = fixture(); s['bindings'][0]['extra'] = 'unknown'; changes.append(s)
        s = fixture(); s['bindings'].append({'name': 'NEW_SECRET', 'type': 'secret_text'}); changes.append(s)
        s = fixture(); s['bindings'][-1]['type'] = 'service'; changes.append(s)
        s = fixture(); s['tags'] = ['cf:service=would-delete']; changes.append(s)
        s = fixture(); s['tags'] = ['cf:environment=would-delete']; changes.append(s)
        s = fixture(); s['tail_consumers'] = [{'service': 'unknown'}]; changes.append(s)
        s = fixture(); s['annotations']['workers/message'] = 'preserve user annotation'; changes.append(s)
        for settings in changes:
            with self.subTest(settings_count=len(settings)):
                with self.assertRaises(p.GuardError): p.config_for(settings, '/synthetic')

    def test_source_version_domain_runtime_races_rejected(self):
        for key, value in [('active', 'other'), ('latest', 'inactive'), ('percentage', 50), ('main_sha', 'other'),
                           ('source_hashes', {}), ('domains', []), ('runtime', {})]:
            s = snapshot(); s[key] = value
            with self.subTest(key=key):
                with self.assertRaises(p.GuardError): p.snapshot_guard(s, VERSION)

    def test_preparation_detects_config_change(self):
        old = snapshot(); new = deepcopy(old); new['settings']['bindings'][0]['text'] = 'changed'
        with self.assertRaises(p.GuardError): p.unchanged_snapshot(old, new)

    def test_no_production_write_method_exists(self):
        client = p.ReadOnlyCloudflare('synthetic', 'synthetic')
        for method in ['POST', 'PUT', 'PATCH', 'DELETE']:
            with self.assertRaises(p.GuardError): client.request('/workers/scripts/x', method=method)

    def test_redirects_rejected(self):
        for code in [301, 302, 303, 307, 308]:
            with self.assertRaises(p.GuardError): p.NoRedirect().redirect_request(None, None, code, '', {}, '')

    def test_immutable_asset_ledger_digest(self):
        ledger = json.loads((ROOT/'tools/hub-933-assets-baseline.json').read_text())
        self.assertEqual(len(ledger), 32)
        self.assertEqual(p.digest(p.canonical(ledger)), p.BASE_LEDGER_SHA)
        self.assertEqual(sum(x['size'] for x in ledger.values()), 183482)

    def test_added_or_deleted_asset_path_rejected_before_read(self):
        with patch.object(p.subprocess, 'check_output', return_value='public/apps/board.js\n'):
            with self.assertRaises(p.GuardError):
                p.candidate_assets(ROOT, ROOT, 'a'*40, p.APPROVED_BOARD_SHA)

    def test_unsafe_service_tags_exactly_cover_locked_patch_condition(self):
        for tag in ['cf:service=x', 'cf:environment=production']:
            settings = fixture(); settings['tags'] = ['owner-tag', tag]
            with self.assertRaisesRegex(p.GuardError, 'PATCH'):
                p.validate_settings(settings)

    def test_real_locked_wranger_builder_metadata_and_no_bundle_bytes(self):
        with tempfile.TemporaryDirectory(prefix='hub-933-offline-') as temp:
            directory = Path(temp)
            (directory/'assets').mkdir()
            (directory/'code').mkdir()
            (directory/'assets/index.html').write_text('synthetic asset')
            (directory/'code/worker.js').write_text('export default {async fetch(){return new Response("synthetic")}};\n//# sourceMappingURL=worker.js.map\n')
            (directory/'code/worker.js.map').write_text(json.dumps({'version': 3, 'sources': ['synthetic.js'],
                'sourcesContent': ['synthetic'], 'names': [], 'mappings': ''}))
            metadata = p.offline_builder(ROOT, directory, fixture())
            self.assertEqual(metadata['main_module'], 'worker.js')
            self.assertNotIn('assets', metadata)  # dry-run has no completion JWT; not an asset-upload proof.
            parts = p.parse_multipart((directory/'actual.multipart').read_bytes())
            for key, body in [('worker.js', b'unreviewed executable'), ('worker.js.map', b'{}')]:
                bad = dict(parts); bad[key] = body
                with self.assertRaises(p.GuardError):
                    p.inspect_payload(bad, fixture(), (directory/'code/worker.js').read_bytes(),
                                      (directory/'code/worker.js.map').read_bytes())
            altered = dict(metadata); altered['routes'] = ['bad']
            bad = dict(parts); bad['metadata'] = json.dumps(altered).encode()
            with self.assertRaises(p.GuardError):
                p.inspect_payload(bad, fixture(), (directory/'code/worker.js').read_bytes(),
                                  (directory/'code/worker.js.map').read_bytes())


if __name__ == '__main__':
    unittest.main()
