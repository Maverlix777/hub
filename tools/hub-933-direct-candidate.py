#!/usr/bin/env python3
"""Bounded #933 inactive-candidate protocol. Library only; no CLI/activation entry point."""
import base64
import importlib.util
import json
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare933', ROOT/'tools/hub-933-assets-prepare.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
SESSION = '/workers/scripts/' + p.WORKER + '/assets-upload-session'
UPLOAD = '/workers/assets/upload?base64=true'
SINGLE_PREFIX = '/workers/assets/upload/'
VERSION = '/workers/scripts/' + p.WORKER + '/versions?bindings_inherit=strict'
APPROVED_MERGE = '78546f13bc99401fc6f4acc11a175befcd61b933'
APPROVED_HEAD = 'bd5801529ac56b9df334397d60c4be1bfbc1cd3d'
CANDIDATE_LEDGER = '0adfbe1db328475f1e16387885f85f81b848cfdb2bbf7f214d13af8861196a7a'
MIMES = {'.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json'}


def encode_multipart(parts):
    boundary = 'Hub933' + secrets.token_hex(16)
    chunks = []
    for name, mime, body in parts:
        p.require(re.fullmatch(r'[a-zA-Z0-9_.-]+', name), 'Unexpected multipart name')
        disposition = 'form-data; name="' + name + '"'
        if name != 'metadata': disposition += '; filename="' + name + '"'
        chunks.extend([('--' + boundary + '\r\nContent-Disposition: ' + disposition + '\r\nContent-Type: '
                        + mime + '\r\n\r\n').encode(), body, b'\r\n'])
    chunks.append(('--' + boundary + '--\r\n').encode())
    return b''.join(chunks), 'multipart/form-data; boundary=' + boundary


def token_claims(token):
    # Routing/expiry checks only. Signature verification remains the upstream API's job.
    p.require(isinstance(token, str) and 0 < len(token) < 65536, 'Missing/invalid upload token; value withheld')
    try:
        pieces = token.split('.')
        claims = json.loads(base64.urlsafe_b64decode(pieces[1] + '='*((-len(pieces[1]))%4)))
        p.require(len(pieces) == 3 and isinstance(claims, dict), 'Invalid upload token; value withheld')
    except (ValueError, IndexError, UnicodeError):
        raise p.GuardError('Invalid upload token; value withheld') from None
    if 'exp' in claims:
        p.require(isinstance(claims['exp'], (int, float)) and claims['exp'] > time.time(), 'Upload token expired')
    return claims


def validate_token(token):
    token_claims(token)
    return token


class CandidateTransport(p.ReadOnlyCloudflare):
    """Only the three documented staging routes. Each call has exactly one HTTP attempt."""
    def __init__(self, account, token):
        super().__init__(account, token)
        self.session_sent = self.version_sent = False

    def post(self, path, body, mime, upload_token=None):
        is_upload = path == UPLOAD or re.fullmatch(re.escape(SINGLE_PREFIX) + r'[a-f0-9]{32}', path) is not None
        p.require(path in {SESSION, VERSION} or is_upload, 'Forbidden production staging path')
        p.require(is_upload == (upload_token is not None), 'Wrong credential domain for staging operation')
        if path == SESSION:
            p.require(not self.session_sent, 'Session creation cannot be retried'); self.session_sent = True
        if path == VERSION:
            p.require(not self.version_sent, 'Inactive version creation cannot be retried'); self.version_sent = True
        bearer = validate_token(upload_token) if upload_token is not None else self.token
        request = urllib.request.Request(self.base + path, method='POST', data=body,
            headers={'Authorization': 'Bearer ' + bearer, 'Content-Type': mime})
        try:
            with urllib.request.build_opener(p.NoRedirect()).open(request, timeout=60) as response:
                data = response.read(); status = response.status
        except urllib.error.HTTPError as error:
            raise p.GuardError(f'Staging HTTP {error.code}; response withheld; no retry') from None
        except (urllib.error.URLError, TimeoutError):
            raise p.GuardError('Staging outcome uncertain; details withheld; no retry') from None
        try: payload = json.loads(data)
        except ValueError: raise p.GuardError('Malformed staging response; details withheld; no retry') from None
        p.require(payload.get('success') is True, 'Staging success=false; response withheld; no retry')
        return status, payload['result']


def manifest_for(assets, repo=ROOT):
    baseline = json.loads((ROOT/'tools/hub-933-assets-baseline.json').read_text())
    p.require(set(assets) == set(baseline) and len(assets) == 32, 'Exact32 asset paths required')
    ledger = {name: {'sha256': p.digest(body), 'size': len(body)} for name, body in assets.items()}
    p.require(p.digest(p.canonical(ledger)) == CANDIDATE_LEDGER, 'Approved candidate asset ledger differs')
    for name in assets:
        p.require(Path(name).suffix in MIMES, 'Unsupported MIME extension')
    encoded = {name: base64.b64encode(body).decode() for name, body in assets.items()}
    program = """const fs=require('node:fs'),path=require('node:path'),b=require('blake3-wasm');
const files=JSON.parse(fs.readFileSync(0,'utf8')),out={};
for(const n of Object.keys(files).sort()){const raw=Buffer.from(files[n],'base64');out[n]={hash:b.hash(files[n]+path.extname(n).slice(1)).toString('hex').slice(0,32),size:raw.length};}
process.stdout.write(JSON.stringify(out));"""
    result = subprocess.run(['node', '-e', program], input=json.dumps(encoded).encode(), cwd=repo,
                            capture_output=True, timeout=20)
    p.require(result.returncode == 0, 'Locked BLAKE3 manifest helper failed; output withheld')
    manifest = json.loads(result.stdout)
    p.require(set(manifest) == set(assets) and all(re.fullmatch(r'[a-f0-9]{32}', x['hash'])
              and x['size'] == len(assets[n]) for n, x in manifest.items()), 'Manifest helper mismatch')
    return manifest


def version_parts(offline_parts, settings, original_modules, completion_token):
    metadata = p.inspect_payload(offline_parts, settings, original_modules['worker.js'], original_modules['worker.js.map'])
    metadata = dict(metadata)
    metadata['assets'] = {'jwt': validate_token(completion_token), 'config': {
        'html_handling': 'none', 'run_worker_first': True, 'base_path': '/'}}
    parts = [('metadata', 'application/json', json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode()),
             ('worker.js', 'application/javascript+module', offline_parts['worker.js']),
             ('worker.js.map', 'application/source-map', offline_parts['worker.js.map'])]
    return encode_multipart(parts)


def create_inactive_candidate(client, assets, offline_parts, accepted_snapshot, snapshot_reader=p.gather_snapshot):
    """One bounded staging transaction. No activation/rollback/retry path exists."""
    manifest = manifest_for(assets)
    before, original_modules = snapshot_reader(client)
    p.snapshot_guard(before, accepted_snapshot['active'])
    p.unchanged_snapshot(accepted_snapshot, before)
    p.require(p.digest(original_modules['worker.js']) == p.EXECUTABLE_SHA, 'Executable bytes differ from accepted snapshot')
    p.inspect_payload(offline_parts, before['settings'], original_modules['worker.js'], original_modules['worker.js.map'])
    p.require(bool(before.get('script_etag')), 'Accepted executable ETag absent')
    status, session = client.post(SESSION, p.canonical({'manifest': manifest}), 'application/json')
    p.require(status == 200 and set(session) == {'jwt', 'buckets'}, 'Unexpected upload-session response')
    session_token = validate_token(session['jwt'])
    buckets = session['buckets']
    p.require(isinstance(buckets, list) and len(buckets) <= 32, 'Malformed asset upload buckets')
    requested = []
    for bucket in buckets:
        p.require(isinstance(bucket, list) and bool(bucket), 'Malformed empty asset bucket')
        requested.extend(bucket)
    lookup = {}
    for name, entry in manifest.items():
        pair = (assets[name], MIMES[Path(name).suffix])
        p.require(entry['hash'] not in lookup or lookup[entry['hash']] == pair, 'Ambiguous content hash collision')
        lookup[entry['hash']] = pair
    p.require(all(isinstance(h, str) and h in lookup for h in requested)
              and len(set(requested)) == len(requested), 'Unknown or duplicate server-requested asset hash')
    completion_token = session_token if not buckets else None
    single = token_claims(session_token).get('wrangler_single_asset_uploads') is True
    upload_buckets = [[h] for h in requested] if single else buckets
    for bucket in upload_buckets:
        if single:
            h = bucket[0]
            body, mime = lookup[h]
            path = SINGLE_PREFIX + h
        else:
            body, mime = encode_multipart([(h, lookup[h][1], base64.b64encode(lookup[h][0])) for h in bucket])
            path = UPLOAD
        upload_status, result = client.post(path, body, mime, upload_token=session_token)
        p.require(upload_status in {201, 202} and isinstance(result, dict), 'Unexpected asset response')
        if upload_status == 201:
            p.require(set(result) == {'jwt'}, 'Missing completion JWT')
            completion_token = validate_token(result['jwt'])
        else:
            p.require(result == {}, 'Unexpected partial-upload response')
    p.require(completion_token is not None, 'All buckets uploaded without completion token; no candidate')
    current, current_modules = snapshot_reader(client)
    p.unchanged_snapshot(before, current)
    p.require(current_modules == original_modules, 'Current code/map raced staging; no candidate')
    body, mime = version_parts(offline_parts, before['settings'], original_modules, completion_token)
    version_status, version = client.post(VERSION, body, mime)
    p.require(version_status == 200 and isinstance(version.get('id'), str)
              and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', version['id']),
              'Candidate response uncertain; no retry or activation')
    candidate_id = version['id']
    script = '/workers/scripts/' + p.WORKER
    resources = client.request(script + '/versions/' + candidate_id)['resources']
    p.require(resources['script']['etag'] == before['script_etag'], 'Candidate executable ETag changed; no activation')
    order = lambda bindings: sorted(bindings, key=lambda b: b['name'])
    p.require(order(resources['bindings']) == order(before['settings']['bindings']), 'Candidate bindings changed')
    p.require(resources['script_runtime'] == before['runtime'], 'Candidate runtime/assets routing changed')
    domains = client.request('/workers/domains?hostname=' + p.HOSTNAME)
    p.require(domains == before['domains'], 'Domain changed during candidate staging')
    settings = client.request(script + '/settings')
    p.validate_settings(settings)
    p.require(p.canonical(settings) == p.canonical(before['settings']), 'Full settings changed during staging')
    current_parts = p.parse_multipart(*client.request(script + '/content/v2', raw=True))
    p.require(set(current_parts) == {'worker.js', 'worker.js.map'}
              and p.digest(current_parts['worker.js']) == p.EXECUTABLE_SHA, 'Executable readback mismatch')
    source_map = json.loads(current_parts['worker.js.map'])
    p.require(len(source_map['sources']) == len(source_map['sourcesContent']), 'Readback source originals incomplete')
    originals = {}
    for name, original in zip(source_map['sources'], source_map['sourcesContent']):
        match = re.search(r'(?:^|/)src/([^/]+\.js)$', name)
        if match and 'node_modules/' not in name:
            key = 'src/' + match.group(1)
            p.require(key not in originals, 'Duplicate readback source original')
            originals[key] = p.digest(original.encode())
    p.require(originals == p.ORIGINAL_HASHES, 'Runtime source originals changed during staging')
    # These ownership reads must follow every content/config readback. This is an
    # observation, not a lock: the independent activation owner must refresh it.
    active = client.request(script + '/deployments')['deployments'][0]['versions']
    p.require(active == [{'version_id': before['active'], 'percentage': 100}], 'Active version changed; no activation')
    latest = client.request(script + '/versions')['items'][0]['id']
    p.require(latest == candidate_id, 'Candidate ownership/concurrent latest uncertain; no activation')
    return {'candidate_id': candidate_id, 'active_unchanged': True, 'asset_count': 32,
            'uploaded_hash_count': len(requested), 'executable_sha256': p.EXECUTABLE_SHA,
            'candidate_ledger_sha256': CANDIDATE_LEDGER, 'activated': False,
            'before_fingerprints': p.fingerprints(before['settings'], before['runtime'], before['domains']),
            'after_fingerprints': p.fingerprints(settings, resources['script_runtime'], domains),
            'script_etag': before['script_etag']}
