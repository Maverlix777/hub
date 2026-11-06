#!/usr/bin/env python3
"""#933 preparation prototype. GET-only transport; no upload or activation entry point."""
import hashlib
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import shutil
import sys
import urllib.error
import urllib.request
from email import policy
from email.parser import BytesParser

BASE_COMMIT = 'b5e136ffd117144bd812d50f66890e70f07079de'
BASE_LEDGER_SHA = '160cce7ad6acb2929c3e0ce68afeb3ae3bb9dcdb33a0bcc4e89a14399f1782d6'
EXECUTABLE_SHA = 'fc7a45a477e255c77c07ebebfd607272f3137b408fb8a7fb194185b6d0f20265'
APPROVED_BOARD_SHA = 'e0cf6adf4df1417bb0e5e3862883496478f5f1af36cd999010d2c9cfc21411d1'
WORKER = 'kolobovdjp-hub'
HOSTNAME = 'hub.kolobovdjp.org'
ORIGINAL_HASHES = {
    'src/board-sources.js': '25ed94cc6f77a5a19775d5c4cc5b139bf0b551fc3fd944043b36ab711d71e84f',
    'src/board.js': '05bc08f04b9ac311f51d28bf9f9fb999ffbc14af51c451053b53f143ab0c5647',
    'src/issue-responses.js': '59ca15ee2a85f6bb0ee285118556651bcabb6a8d46b17631e9be67224c21d212',
    'src/issues-delivery.js': '497b31a78824830f01bbaea12035f772c71d4ff321e15c3870c81d99258a1854',
    'src/messenger.js': 'a645bc44b2db731b5b5131fd6d4c77a7ec99ad4ab3ec6099a39f4222c4b26934',
    'src/outbox.js': '2a1eee493195f0e517078da59b49e2816aedf488e2c477af2aa3b4845edaa9ad',
    'src/push.js': '2780c52a1852a2a1a6d31fce3e9c62b7bd7ca12718bd6700e19c3604f70c9e34',
    'src/telemetry.js': '3a4718e54ca0665ef01d76cdaca23c31e04f8fbcc76cfb17f33d782e1004942a',
    'src/worker.js': '11339f2f1903068b5ecd395574650f8372f78a966c2d5878dad041f3f1ab2007',
}
SECRET_NAMES = {'HUB_GATEWAY_SECRET', 'PUSH_DELIVERY_TOKEN', 'RATE_LIMIT_HMAC_KEY', 'VAPID_PRIVATE_KEY'}
PLAIN_NAMES = {'BOARD_OWNER_USERNAME', 'CANONICAL_ORIGIN', 'HUB_GATEWAY_ORIGIN', 'HUB_OWNER_USER_ID',
               'LEGACY_ORIGIN', 'RP_ID', 'RP_NAME', 'VAPID_PUBLIC_KEY'}
KNOWN_SETTINGS = {'placement', 'compatibility_date', 'compatibility_flags', 'usage_model', 'tags',
                  'tail_consumers', 'logpush', 'annotations', 'bindings'}
KNOWN_ASSETS = {'html_handling': 'none', 'serve_directly': False, 'raw_run_worker_first': True, 'base_path': '/'}


class GuardError(Exception):
    pass


def require(value, message):
    if not value:
        raise GuardError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def fingerprints(settings, runtime, domains):
    """Only digests leave the runner; full settings/plain values stay in memory."""
    return {'settings_sha256': digest(canonical(settings)), 'runtime_sha256': digest(canonical(runtime)),
            'domains_sha256': digest(canonical(domains)),
            'sorted_bindings_sha256': digest(canonical(sorted(settings['bindings'], key=lambda b: b['name'])))}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise GuardError('Authenticated redirect rejected')


class ReadOnlyCloudflare:
    def __init__(self, account, token):
        require(bool(account and token), 'Existing runner authentication required')
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + account
        self.token = token

    def request(self, path, method='GET', raw=False):
        require(method == 'GET', 'Prototype forbids every production write')
        require(path.startswith('/workers/'), 'Unexpected read scope')
        request = urllib.request.Request(self.base + path, method='GET',
                                         headers={'Authorization': 'Bearer ' + self.token})
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=45) as response:
                body = response.read()
                mime = response.headers.get('content-type', '')
        except urllib.error.HTTPError as error:
            raise GuardError(f'Cloudflare GET HTTP {error.code}; details withheld') from None
        except (urllib.error.URLError, TimeoutError):
            raise GuardError('Cloudflare GET transport error; details withheld') from None
        if raw:
            return body, mime
        payload = json.loads(body)
        require(payload.get('success') is True, 'Cloudflare GET failed; details withheld')
        return payload['result']


def snapshot_guard(snapshot, expected_version):
    require(re.fullmatch(r'[0-9a-f-]{36}', expected_version) is not None, 'Expected exact accepted version UUID')
    require(snapshot['active'] == snapshot['latest'] == expected_version, 'Concurrent or inactive candidate version present')
    require(snapshot['percentage'] == 100, 'Expected one100% version')
    require(snapshot['main_sha'] == EXECUTABLE_SHA, 'Current executable changed')
    require(re.fullmatch(r'[a-f0-9]{64}', snapshot.get('script_etag', '')), 'Current executable ETag absent')
    require(snapshot['source_hashes'] == ORIGINAL_HASHES, 'Current source originals changed')
    domains = snapshot['domains']
    require(len(domains) == 1 and domains[0]['hostname'] == HOSTNAME and domains[0]['service'] == WORKER
            and domains[0]['enabled'] is True, 'Domain ownership changed')
    require(snapshot['runtime'] == {'assets': KNOWN_ASSETS, 'compatibility_date': '2026-10-17',
            'compatibility_flags': ['nodejs_compat'], 'usage_model': 'standard'}, 'Unsupported runtime/assets setting')
    return validate_settings(snapshot['settings'])


def validate_settings(settings):
    require(set(settings) == KNOWN_SETTINGS, 'Unsupported or missing setting; do not drop metadata')
    require(settings['compatibility_date'] == '2026-10-17'
            and settings['compatibility_flags'] == ['nodejs_compat']
            and settings['usage_model'] == 'standard', 'Unsupported runtime configuration')
    require(settings['placement'] == {} and settings['tail_consumers'] == []
            and settings['logpush'] is False, 'Unsupported placement/tail/logpush setting')
    tags = settings['tags']
    require(isinstance(tags, list) and all(isinstance(tag, str) for tag in tags), 'Unsupported tags')
    # Wrangler removes these tags even without configured environments; stop instead of PATCHing.
    require(not any(t.startswith(('cf:service=', 'cf:environment=')) for t in tags),
            'Wrangler would PATCH service/environment tags')
    require(isinstance(settings['annotations'], dict)
            and set(settings['annotations']) <= {'workers/triggered_by'},
            'Unsupported user annotation; do not drop metadata')
    bindings = settings['bindings']
    require(len(bindings) == 14 and len({b['name'] for b in bindings}) == 14, 'Accepted14-binding snapshot changed')
    for binding in bindings:
        name, kind = binding['name'], binding['type']
        allowed = {'name', 'type'}
        if name in PLAIN_NAMES:
            require(kind == 'plain_text' and isinstance(binding.get('text'), str), 'Plain binding changed')
            allowed.add('text')
        elif name in SECRET_NAMES:
            require(kind == 'secret_text', 'Secret binding changed')
        elif name == 'ASSETS':
            require(kind == 'assets', 'ASSETS binding changed')
        elif name == 'HUB_DB':
            require(kind == 'd1' and bool(binding.get('id') or binding.get('database_id')), 'D1 binding changed')
            allowed.update({'id', 'database_id'})
        else:
            raise GuardError('Unreviewed binding name')
        require(set(binding) <= allowed, 'Unsupported binding field; no credential extraction')
    require({b['name'] for b in bindings} == PLAIN_NAMES | SECRET_NAMES | {'ASSETS', 'HUB_DB'}, 'Binding set changed')
    return bindings


def config_for(settings, directory):
    bindings = validate_settings(settings)
    directory = Path(directory).resolve()
    return {
        # Separate code from assets: --no-bundle otherwise recursively includes assets as modules.
        'name': WORKER, 'main': str(directory / 'code' / 'worker.js'),
        'compatibility_date': settings['compatibility_date'],
        'compatibility_flags': settings['compatibility_flags'],
        'workers_dev': False, 'preview_urls': False, 'no_bundle': True, 'upload_source_maps': True,
        # The accepted API placement is {}. Wrangler requires a mode when this
        # optional config key exists; omit it so multipart adds no placement field.
        'tail_consumers': [],
        'assets': {'directory': str(directory / 'assets'), 'binding': 'ASSETS',
                   'html_handling': 'none', 'run_worker_first': True, 'base_path': '/'},
        'unsafe': {'bindings': [{'name': b['name'], 'type': 'inherit'} for b in bindings if b['name'] != 'ASSETS'],
                   'metadata': {'usage_model': settings['usage_model']}},
    }


def parse_multipart(body, content_type=None):
    if content_type is None:
        first = body.split(b'\r\n', 1)[0]
        require(first.startswith(b'--'), 'Missing multipart boundary')
        content_type = 'multipart/form-data; boundary=' + first[2:].decode()
    msg = BytesParser(policy=policy.default).parsebytes(('Content-Type: ' + content_type + '\r\n\r\n').encode() + body)
    require(msg.is_multipart() and not msg.defects, 'Incomplete multipart')
    parts = {}
    for part in msg.iter_parts():
        name = part.get_param('name', header='content-disposition')
        require(name not in parts and not part.defects, 'Duplicate or malformed multipart module')
        parts[name] = part.get_payload(decode=True)
    return parts


def inspect_payload(parts, settings, original_main, original_map):
    require(set(parts) == {'metadata', 'worker.js', 'worker.js.map'}, 'Unexpected upload module set')
    metadata = json.loads(parts['metadata'])
    require(set(metadata) == {'annotations', 'bindings', 'compatibility_date', 'compatibility_flags',
            'keep_bindings', 'main_module', 'tail_consumers', 'usage_model'}, 'Unexpected upload metadata field')
    require(metadata['annotations'] == {} and metadata['tail_consumers'] == []
            and metadata['main_module'] == 'worker.js', 'Unexpected annotations/tails/entrypoint')
    require(parts['worker.js'] == original_main, 'No-bundle executable was modified')
    # Locked Wrangler scanSourceMaps sets file and strips only leading relative prefixes.
    # Assert the complete known normalized bytes, retaining every substantive map field.
    expected_map = json.loads(original_map)
    expected_map['file'] = 'worker.js'
    def clean_prefix(name):
        for prefix in ['./', '.\\', '../', '..\\']:
            while name.startswith(prefix): name = name[len(prefix):]
        return name
    if expected_map.get('sourceRoot'):
        expected_map['sourceRoot'] = clean_prefix(expected_map['sourceRoot'])
    expected_map['sources'] = [clean_prefix(name) for name in expected_map['sources']]
    expected_map_bytes = json.dumps(expected_map, ensure_ascii=False, separators=(',', ':')).encode()
    require(parts['worker.js.map'] == expected_map_bytes, 'Map differs from exact locked Wrangler normalization')
    expected_bindings = [{'name': b['name'], 'type': 'inherit'} for b in validate_settings(settings) if b['name'] != 'ASSETS']
    expected_bindings.append({'name': 'ASSETS', 'type': 'assets'})
    require(sorted(metadata['bindings'], key=lambda x:x['name']) == sorted(expected_bindings, key=lambda x:x['name']),
            'Upload bindings would change')
    require(set(metadata['keep_bindings']) == {'plain_text', 'json', 'secret_text', 'secret_key'}, 'Vars/secrets retention absent')
    require(metadata['compatibility_date'] == settings['compatibility_date']
            and metadata['compatibility_flags'] == settings['compatibility_flags']
            and metadata['usage_model'] == settings['usage_model'], 'Upload runtime would change')
    forbidden = {'routes', 'migrations', 'secrets', 'containers', 'logpush', 'tags', 'observability'}
    require(not forbidden.intersection(metadata), 'Unexpected global/migration metadata')
    return metadata


def git_blob(repo, ref, path):
    require(re.fullmatch(r'[0-9a-f]{40}', ref) is not None, 'Full immutable Git SHA required')
    return subprocess.check_output(['git', 'show', ref + ':' + path], cwd=repo)


def candidate_assets(operations_repo, runtime_repo, reviewed_sha, approved_board_sha):
    baseline = json.loads((Path(__file__).with_name('hub-933-assets-baseline.json')).read_text())
    require(digest(canonical(baseline)) == BASE_LEDGER_SHA and len(baseline) == 32, 'Baseline ledger changed')
    paths = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', reviewed_sha, 'public'], cwd=runtime_repo,
                                     text=True).splitlines()
    require(sorted('/' + p[len('public/'):] for p in paths) == sorted(baseline), 'Asset paths added or deleted')
    data, ledger = {}, {}
    for path, entry in baseline.items():
        name = 'public' + path
        original = git_blob(operations_repo, BASE_COMMIT, name)
        require({'size': len(original), 'sha256': digest(original)} == entry, 'Immutable base source differs from ledger')
        candidate = git_blob(runtime_repo, reviewed_sha, name)
        if path == '/apps/board.js':
            require(digest(candidate) == approved_board_sha and candidate != original, 'Reviewed board.js hash absent/unchanged')
        else:
            require(candidate == original, 'Unreviewed additional asset change')
        data[path] = candidate
        ledger[path] = {'size': len(candidate), 'sha256': digest(candidate)}
    return data, ledger


def unchanged_snapshot(before, after):
    require(canonical(before) == canonical(after), 'Concurrent live snapshot change; no candidate upload')


def gather_snapshot(client):
    script = '/workers/scripts/' + WORKER
    deployments = client.request(script + '/deployments')['deployments']
    require(bool(deployments), 'No active deployment')
    versions = deployments[0]['versions']
    require(len(versions) == 1, 'Multiple active versions')
    active = versions[0]['version_id']
    history = client.request(script + '/versions')['items']
    require([v['id'] for v in history[:3]] == [
        '44fd04c8-3a37-42c5-9718-62f669c3e5df', '2a2ef721-7f6f-49b8-b512-a9230bae9d01',
        '443ffe71-e590-4c36-9837-8dd82965af7a'], 'Accepted immutable asset lineage changed')
    settings = client.request(script + '/settings')
    detail = client.request(script + '/versions/' + active)['resources']
    runtime = detail['script_runtime']
    domains = client.request('/workers/domains?hostname=' + HOSTNAME)
    modules = parse_multipart(*client.request(script + '/content/v2', raw=True))
    require(set(modules) == {'worker.js', 'worker.js.map'}, 'Unexpected current module set')
    sm = json.loads(modules['worker.js.map'])
    originals = {}
    require(len(sm['sources']) == len(sm['sourcesContent']), 'Missing source originals')
    for name, original in zip(sm['sources'], sm['sourcesContent']):
        match = re.search(r'(?:^|/)src/([^/]+\.js)$', name)
        if match and 'node_modules/' not in name:
            key = 'src/' + match.group(1)
            require(key not in originals, 'Duplicate application original')
            originals[key] = digest(original.encode())
    snapshot = {'active': active, 'latest': history[0]['id'], 'percentage': versions[0]['percentage'],
                'settings': settings, 'runtime': runtime, 'domains': domains,
                'main_sha': digest(modules['worker.js']), 'source_hashes': originals,
                'script_etag': detail['script']['etag']}
    snapshot_guard(snapshot, active)
    final_versions = client.request(script + '/deployments')['deployments'][0]['versions']
    require(final_versions == versions and client.request(script + '/versions')['items'][0]['id'] == history[0]['id'],
            'Snapshot ownership changed during readback')
    return snapshot, modules


def offline_builder(repo, directory, settings):
    """Runs real locked Wrangler only with --dry-run; captures logs in memory."""
    directory = Path(directory)
    config_path = directory / 'prototype.production.local.jsonc'
    config_path.write_text(json.dumps(config_for(settings, directory)))
    output = directory / 'actual.multipart'
    command = ['node', str(Path(repo)/'node_modules/wrangler/bin/wrangler.js'), 'versions', 'upload',
               '--no-bundle', '--strict', '--keep-vars', '--upload-source-maps', '--dry-run',
               '--outfile', str(output), '--config', str(config_path)]
    # No authentication reaches the offline vendor process. Diagnostic stdout and
    # stderr are private captured bytes; vendor debug-file output goes to /dev/null.
    debug_path = directory / 'offline-debug.log'
    debug_path.symlink_to('/dev/null')
    vendor_env = {k: v for k, v in os.environ.items() if not k.startswith(('CLOUDFLARE_', 'GITHUB_', 'GH_'))}
    vendor_env.update({'WRANGLER_LOG_PATH': str(debug_path), 'WRANGLER_SEND_METRICS': 'false'})
    result = subprocess.run(command, cwd=repo, capture_output=True, timeout=45, env=vendor_env)
    require(result.returncode == 0, 'Locked offline Wrangler builder failed; captured log withheld')
    metadata = inspect_payload(parse_multipart(output.read_bytes()), settings,
                               (directory/'code/worker.js').read_bytes(), (directory/'code/worker.js.map').read_bytes())
    return metadata


def synthetic_settings():
    bindings = [{'name': n, 'type': 'plain_text', 'text': 'synthetic-private-value'} for n in sorted(PLAIN_NAMES)]
    bindings += [{'name': n, 'type': 'secret_text'} for n in sorted(SECRET_NAMES)]
    bindings += [{'name': 'HUB_DB', 'type': 'd1', 'id': 'synthetic-database'}, {'name': 'ASSETS', 'type': 'assets'}]
    return {'placement': {}, 'compatibility_date': '2026-10-17',
            'compatibility_flags': ['nodejs_compat'], 'usage_model': 'standard', 'tags': ['owner-tag'],
            'tail_consumers': [], 'logpush': False, 'annotations': {}, 'bindings': bindings}


def offline_candidate(operations_repo, runtime_repo, reviewed_sha, directory):
    """Offline preparation proof; never calls Cloudflare or activates a version."""
    data, ledger = candidate_assets(operations_repo, runtime_repo, reviewed_sha, APPROVED_BOARD_SHA)
    directory = Path(directory)
    require(not directory.exists(), 'Use a new scratch directory')
    directory.mkdir(mode=0o700)
    (directory/'code').mkdir(); (directory/'assets').mkdir()
    for path, body in data.items():
        target = directory/'assets'/path.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(body)
    build_dir = directory/'build'
    result = subprocess.run(['node', str(Path(operations_repo)/'node_modules/wrangler/bin/wrangler.js'),
                             'deploy', '--dry-run', '--outdir', str(build_dir)],
                            cwd=operations_repo, capture_output=True, timeout=45)
    require(result.returncode == 0, 'Offline reference build failed; log withheld')
    require(digest((build_dir/'worker.js').read_bytes()) == EXECUTABLE_SHA, 'Reference executable changed')
    for name in ['worker.js', 'worker.js.map']:
        shutil.copyfile(build_dir/name, directory/'code'/name)
    metadata = offline_builder(operations_repo, directory, synthetic_settings())
    (directory/'candidate-ledger.json').write_bytes(canonical(ledger))
    print('PASS offline candidate32 paths:31 unchanged + approved board.js=' + APPROVED_BOARD_SHA)
    print('PASS actual locked multipart:14 bindings,13 inherit,4 secret names,D1,no database/value export')
    print('PASS exact executable SHA256=' + EXECUTABLE_SHA + '; complete locked-normalized map validated')
    print('PASS no global metadata/routes/migrations; only preparation performed; no upload/activation')
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline-runtime-repo', type=Path, required=True)
    parser.add_argument('--reviewed-sha', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        offline_candidate(Path(__file__).resolve().parents[1], args.offline_runtime_repo, args.reviewed_sha, args.out)
    except GuardError as error:
        print('FAILED: ' + str(error), file=sys.stderr); sys.exit(1)
    except Exception:
        print('FAILED: unexpected offline preparation error; details withheld', file=sys.stderr); sys.exit(1)
