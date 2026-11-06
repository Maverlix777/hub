#!/usr/bin/env python3
"""Offline runner provenance/fingerprint tests; no network or production writes."""
from contextlib import redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runner933', ROOT/'tools/hub-933-stage-runner.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
test_spec = importlib.util.spec_from_file_location('protocol933tests', ROOT/'tests/hub-933-direct-candidate-test.py')
t = importlib.util.module_from_spec(test_spec); test_spec.loader.exec_module(t)


def pr():
    return {'number': 74, 'merged': True, 'state': 'closed', 'merge_commit_sha': r.d.APPROVED_MERGE,
            'head': {'sha': r.d.APPROVED_HEAD, 'repo': {'full_name': r.REPOSITORY}},
            'base': {'ref': 'main', 'repo': {'full_name': r.REPOSITORY}}}


def env():
    return {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': r.REPOSITORY,
            'GITHUB_REF': r.BRANCH, 'GITHUB_SHA': 'a'*40, 'HUB_933_CONFIRM': r.CONFIRM,
            'HUB_933_REVIEWED_SHA': r.d.APPROVED_MERGE, 'GITHUB_TOKEN': 'synthetic-github-secret',
            'CLOUDFLARE_ACCOUNT_ID': 'synthetic-account', 'CLOUDFLARE_API_TOKEN': 'synthetic-cloudflare-secret'}


class Runner(unittest.TestCase):
    @classmethod
    def setUpClass(cls): t.Protocol.setUpClass()

    @classmethod
    def tearDownClass(cls): t.Protocol.tearDownClass()

    def test_exact_merged_pr_and_reviewed_head(self):
        r.provenance_guard(pr())
        for key, value in [('merged', False), ('merge_commit_sha', 'b'*40), ('number', 75), ('state', 'open')]:
            changed = pr(); changed[key] = value
            with self.assertRaises(r.p.GuardError): r.provenance_guard(changed)
        for where, field, value in [('head', 'sha', 'c'*40), ('base', 'ref', 'other')]:
            changed = pr(); changed[where][field] = value
            with self.assertRaises(r.p.GuardError): r.provenance_guard(changed)
        for where in ['head', 'base']:
            changed = pr(); changed[where]['repo']['full_name'] = 'other/repo'
            with self.assertRaises(r.p.GuardError): r.provenance_guard(changed)

    def test_context_exact_branch_event_repo_confirmation_sha_and_clean_checkout(self):
        good = env()
        with patch.object(r, 'git_sha', side_effect=['a'*40, r.d.APPROVED_MERGE]), \
             patch.object(r.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            r.context_guard(good, ROOT, ROOT)
        for key in ['GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY', 'GITHUB_REF', 'HUB_933_CONFIRM', 'HUB_933_REVIEWED_SHA']:
            changed = dict(good); changed[key] = 'wrong'
            with self.assertRaises(r.p.GuardError): r.context_guard(changed, ROOT, ROOT)
        for identities in [['b'*40], ['a'*40, 'b'*40]]:
            with patch.object(r, 'git_sha', side_effect=identities), self.assertRaises(r.p.GuardError):
                r.context_guard(good, ROOT, ROOT)
        with patch.object(r, 'git_sha', side_effect=['a'*40, r.d.APPROVED_MERGE]), \
             patch.object(r.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)), \
             self.assertRaises(r.p.GuardError): r.context_guard(good, ROOT, ROOT)

    def test_all_root_fingerprints_and_etag_are_required(self):
        snapshot = deepcopy(t.Protocol.snapshot)
        accepted = r.p.fingerprints(snapshot['settings'], snapshot['runtime'], snapshot['domains'])
        with patch.object(r, 'BASE_ETAG', snapshot['script_etag']), patch.object(r, 'BASE_FINGERPRINTS', accepted):
            r.baseline_guard(snapshot)
            for field in accepted:
                changed = dict(accepted); changed[field] = '0'*64
                with patch.object(r, 'BASE_FINGERPRINTS', changed), self.assertRaises(r.p.GuardError):
                    r.baseline_guard(snapshot)
        with self.assertRaises(r.p.GuardError): r.baseline_guard(snapshot)

    def test_github_failure_precedes_cloudflare_construction(self):
        with patch.object(r, 'context_guard'), patch.object(r, 'provenance_guard', side_effect=r.p.GuardError('Mismatch')):
            factory = unittest.mock.Mock()
            with self.assertRaises(r.p.GuardError): r.stage(ROOT, ROOT, env(), read_pr=lambda token: pr(), client_factory=factory)
            factory.assert_not_called()

    def test_end_to_end_real_locked_offline_builder_synthetic_staging_only(self):
        fixture = t.Protocol
        fake = t.Fake(fixture.snapshot, fixture.original, fixture.parts)
        accepted = r.p.fingerprints(fixture.snapshot['settings'], fixture.snapshot['runtime'], fixture.snapshot['domains'])
        actual_create = r.d.create_inactive_candidate
        def create(client, assets, parts, snapshot):
            return actual_create(client, assets, parts, snapshot, snapshot_reader=fake.reader)
        output = io.StringIO()
        with patch.object(r, 'context_guard'), patch.object(r.p, 'gather_snapshot', side_effect=fake.reader), \
             patch.object(r, 'BASE_ETAG', fixture.snapshot['script_etag']), patch.object(r, 'BASE_FINGERPRINTS', accepted), \
             patch.object(r.d, 'create_inactive_candidate', side_effect=create), redirect_stdout(output):
            result = r.stage(ROOT, ROOT, env(), read_pr=lambda token: pr(), client_factory=lambda account, token: fake)
        self.assertEqual(result['status'], 'inactive_candidate_verified')
        self.assertTrue(result['github_provenance_verified']); self.assertFalse(result['activated'])
        self.assertEqual(result['approved_merge'], r.d.APPROVED_MERGE)
        self.assertEqual(result['approved_head'], r.d.APPROVED_HEAD)
        self.assertEqual(result['before_fingerprints'], result['after_fingerprints'])
        self.assertEqual([post[0] for post in fake.posts], [r.d.SESSION, r.d.UPLOAD, r.d.VERSION])
        encoded = json.dumps(result) + output.getvalue()
        for secret in ['synthetic-private-value', 'synthetic-database', 'synthetic-github-secret',
                       'synthetic-cloudflare-secret', fake.complete_token]: self.assertNotIn(secret, encoded)

    def test_authenticated_redirects_are_rejected_for_both_transports(self):
        with self.assertRaises(r.p.GuardError): r.p.NoRedirect().redirect_request(None, None, None, None, None, None)
        for operation in [lambda: r.github_pr('synthetic'),
                          lambda: r.d.CandidateTransport('synthetic', 'synthetic').post(r.d.SESSION, b'{}', 'application/json')]:
            with patch.object(r.urllib.request, 'build_opener') as opener:
                opener.return_value.open.side_effect = r.p.GuardError('Authenticated redirect rejected')
                with self.assertRaises(r.p.GuardError): operation()
                self.assertEqual(opener.return_value.open.call_count, 1)

    def test_failure_summary_suppresses_unexpected_secret_bodies_and_tracebacks(self):
        with tempfile.TemporaryDirectory() as directory:
            summary = Path(directory)/'summary.json'; output = io.StringIO()
            with patch.object(r.sys, 'argv', ['runner', '--runtime-repo', str(ROOT), '--summary', str(summary)]), \
                 patch.object(r, 'stage', side_effect=RuntimeError('synthetic-secret-upstream-body')), \
                 patch.object(r.os, 'umask'), redirect_stdout(output):
                self.assertEqual(r.main(), 1)
            text = summary.read_text() + output.getvalue()
            self.assertNotIn('synthetic-secret-upstream-body', text)
            self.assertNotIn('Traceback', text)
            self.assertFalse(json.loads(summary.read_text())['activated'])


if __name__ == '__main__': unittest.main()
