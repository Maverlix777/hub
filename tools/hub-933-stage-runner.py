#!/usr/bin/env python3
"""Manually authorized #933 inactive staging only. No activation entry point."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('candidate933', ROOT/'tools/hub-933-direct-candidate.py')
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d); p = d.p
BASE_VERSION = '44fd04c8-3a37-42c5-9718-62f669c3e5df'
BASE_ETAG = 'a873be5220e865ed38b7ed9a4372c49f3acf2ac38d5a3ac4b6469aad98690be4'
BASE_FINGERPRINTS = {
    'settings_sha256': '87793dddce16713e30281f35509b01aec5acf060e7ecb3130eff79da0fa87942',
    'runtime_sha256': '6886a6e6cceaa2b297b68c8e2e4d8fd92f6e37e831fe472cd26b2c9a9c4bdb4c',
    'domains_sha256': 'cb7b8abcf64aab3cd3a151045209a1436453a73e7b9ba0bd6b0b1bb8fa143bdc',
    'sorted_bindings_sha256': '2b6893cbd70f4185c1cc6b52d356f797b6fa2cb55aae611bd0f17686ad33379a',
}
REPOSITORY = 'Maverlix777/hub'
BRANCH = 'refs/heads/zhanna/933-assets-only-deploy'
CONFIRM = 'STAGE #933 INACTIVE ONLY'
PR_URL = 'https://api.github.com/repos/' + REPOSITORY + '/pulls/74'


def git_sha(repo):
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, text=True, timeout=10)
    p.require(result.returncode == 0, 'Checkout identity unavailable; details withheld')
    return result.stdout.strip()


def context_guard(env, operations_repo, runtime_repo):
    p.require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
              and env.get('GITHUB_REPOSITORY') == REPOSITORY and env.get('GITHUB_REF') == BRANCH,
              'Exact manual operational branch/repository required')
    p.require(env.get('HUB_933_CONFIRM') == CONFIRM, 'Exact inactive staging confirmation required')
    p.require(env.get('HUB_933_REVIEWED_SHA') == d.APPROVED_MERGE, 'Exact approved merged source required')
    sha = env.get('GITHUB_SHA', '')
    p.require(re.fullmatch(r'[a-f0-9]{40}', sha) and git_sha(operations_repo) == sha,
              'Operational checkout differs from immutable workflow SHA')
    p.require(git_sha(runtime_repo) == d.APPROVED_MERGE, 'Runtime checkout differs from reviewed merge')
    for repo in [operations_repo, runtime_repo]:
        check = subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--'], cwd=repo, capture_output=True, timeout=10)
        p.require(check.returncode == 0, 'Checkout has unreviewed tracked changes')


def github_pr(token):
    p.require(bool(token), 'Existing runner GitHub authentication required')
    request = urllib.request.Request(PR_URL, headers={'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'hub-933-inactive-stage'})
    try:
        with urllib.request.build_opener(p.NoRedirect()).open(request, timeout=30) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise p.GuardError(f'GitHub provenance GET HTTP {error.code}; details withheld') from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise p.GuardError('GitHub provenance GET failed; details withheld') from None
    return result


def provenance_guard(pr):
    p.require(pr.get('number') == 74 and pr.get('merged') is True and pr.get('state') == 'closed'
              and pr.get('merge_commit_sha') == d.APPROVED_MERGE, 'PR74 merged identity mismatch')
    p.require(pr.get('head', {}).get('sha') == d.APPROVED_HEAD
              and pr.get('head', {}).get('repo', {}).get('full_name') == REPOSITORY,
              'PR74 reviewed head identity mismatch')
    p.require(pr.get('base', {}).get('ref') == 'main'
              and pr.get('base', {}).get('repo', {}).get('full_name') == REPOSITORY,
              'PR74 target identity mismatch')


def baseline_guard(snapshot):
    p.snapshot_guard(snapshot, BASE_VERSION)
    p.require(snapshot['script_etag'] == BASE_ETAG, 'Root-reviewed current executable ETag changed')
    actual = p.fingerprints(snapshot['settings'], snapshot['runtime'], snapshot['domains'])
    p.require(actual == BASE_FINGERPRINTS, 'Root-reviewed full settings/runtime/domain/bindings changed')


def stage(operations_repo, runtime_repo, env, read_pr=github_pr, client_factory=d.CandidateTransport):
    context_guard(env, operations_repo, runtime_repo)
    provenance_guard(read_pr(env.get('GITHUB_TOKEN', '')))
    client = client_factory(env.get('CLOUDFLARE_ACCOUNT_ID', ''), env.get('CLOUDFLARE_API_TOKEN', ''))
    snapshot, modules = p.gather_snapshot(client)
    baseline_guard(snapshot)
    assets, ledger = p.candidate_assets(operations_repo, runtime_repo, d.APPROVED_MERGE, p.APPROVED_BOARD_SHA)
    p.require(p.digest(p.canonical(ledger)) == d.CANDIDATE_LEDGER, 'Approved asset ledger differs')
    with tempfile.TemporaryDirectory(prefix='hub-933-private-offline-') as scratch:
        directory = Path(scratch); (directory/'code').mkdir(); (directory/'assets').mkdir()
        for name, body in modules.items(): (directory/'code'/name).write_bytes(body)
        for name, body in assets.items():
            target = directory/'assets'/name.lstrip('/'); target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        p.offline_builder(operations_repo, directory, snapshot['settings'])
        parts = p.parse_multipart((directory/'actual.multipart').read_bytes())
        # Library refreshes all preconditions again after offline preparation,
        # and after asset staging, before its single inactive version POST.
        result = d.create_inactive_candidate(client, assets, parts, snapshot)
    return {**result, 'status': 'inactive_candidate_verified', 'baseline_version': BASE_VERSION,
            'operations_sha': env['GITHUB_SHA'], 'approved_merge': d.APPROVED_MERGE,
            'approved_head': d.APPROVED_HEAD, 'github_pr': 74, 'github_provenance_verified': True,
            'board_sha256': p.APPROVED_BOARD_SHA, 'activation_requires_independent_fresh_guard': True}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-repo', type=Path, required=True)
    parser.add_argument('--summary', type=Path, required=True)
    args = parser.parse_args()
    # A failure summary contains no raw exception/upstream body, snapshots,
    # credentials, multipart, token, config value, or vendor log.
    try:
        summary = stage(ROOT, args.runtime_repo.resolve(), os.environ)
        status = 0
    except p.GuardError as error:
        summary = {'status': 'stopped_no_activation', 'error': str(error), 'activated': False,
                   'automatic_retry': False, 'production_state_requires_independent_readback': True}
        status = 1
    except Exception:
        summary = {'status': 'stopped_no_activation', 'error': 'Unexpected staging error; details withheld',
                   'activated': False, 'automatic_retry': False,
                   'production_state_requires_independent_readback': True}
        status = 1
    args.summary.write_bytes(p.canonical(summary))
    print('PASS inactive candidate verified; activation not performed' if status == 0
          else 'FAILED staging guard/outcome; no automatic retry or activation; redacted summary only')
    return status


if __name__ == '__main__': sys.exit(main())
