#!/usr/bin/env python3
"""Scoped #931 code-only deploy. Credentials and snapshots remain in runner memory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from email import policy
from email.parser import BytesParser

WORKER = 'kolobovdjp-hub'
HOSTNAME = 'hub.kolobovdjp.org'
BASE_VERSION = '443ffe71-e590-4c36-9837-8dd82965af7a'
REVIEWED_HEAD = '08a7e92a2a74fb2c64065a1b6f9a19ae868cb297'
BASE_HASHES = {
    'src/outbox.js': '2a1eee493195f0e517078da59b49e2816aedf488e2c477af2aa3b4845edaa9ad',
    'src/issues-delivery.js': '497b31a78824830f01bbaea12035f772c71d4ff321e15c3870c81d99258a1854',
    'src/worker.js': '11339f2f1903068b5ecd395574650f8372f78a966c2d5878dad041f3f1ab2007',
    'src/board-sources.js': '9cee1bf95e77eb2dba6c113526bfb862ed99f76b19a3cd32ef4014ef1052f217',
    'src/board.js': '6a5b6c0df74d98661e25384771f9031187acd25db2950d3b1dc30b9f313f9a92',
    'src/telemetry.js': '3a4718e54ca0665ef01d76cdaca23c31e04f8fbcc76cfb17f33d782e1004942a',
    'src/issue-responses.js': '59ca15ee2a85f6bb0ee285118556651bcabb6a8d46b17631e9be67224c21d212',
    'src/push.js': '2780c52a1852a2a1a6d31fce3e9c62b7bd7ca12718bd6700e19c3604f70c9e34',
    'src/messenger.js': 'a645bc44b2db731b5b5131fd6d4c77a7ec99ad4ab3ec6099a39f4222c4b26934',
}


class DeployError(Exception):
    """A deliberately sanitized deployment failure."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise DeployError('HTTP redirect rejected; credentials not forwarded')


def authenticated_open(request, timeout):
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)


def require(condition, message):
    if not condition:
        raise DeployError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def multipart(parts):
    boundary = 'Hub931' + secrets.token_hex(16)
    body = []
    metadata = json.dumps({'main_module': 'worker.js'}).encode()
    for name, content_type, data in [('metadata', 'application/json', metadata)] + parts:
        require(re.fullmatch(r'[a-zA-Z0-9_.-]+', name) is not None, 'Unsafe module name')
        disposition = f'form-data; name="{name}"'
        if name != 'metadata':
            disposition += f'; filename="{name}"'
        body.extend([
            f'--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {content_type}\r\n\r\n'.encode(),
            data, b'\r\n',
        ])
    body.append(f'--{boundary}--\r\n'.encode())
    return b''.join(body), 'multipart/form-data; boundary=' + boundary


def parse_modules(raw, content_type):
    require(content_type.startswith('multipart/'), 'Expected complete multipart Worker content')
    message = BytesParser(policy=policy.default).parsebytes(
        ('Content-Type: ' + content_type + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + raw)
    require(message.is_multipart() and not message.defects, 'Malformed Worker multipart')
    modules = []
    for item in message.iter_parts():
        require(not item.defects, 'Malformed Worker module')
        name = item.get_param('name', header='content-disposition')
        require(name and name != 'metadata', 'Unexpected Worker content part')
        modules.append((name, item.get_content_type(), item.get_payload(decode=True)))
    require(len(modules) == 2 and {m[0] for m in modules} == {'worker.js', 'worker.js.map'},
            'Expected exactly worker.js and worker.js.map')
    require(all(m[2] for m in modules), 'Empty Worker module')
    return modules


def source_hashes(modules):
    source_map = json.loads(next(m[2] for m in modules if m[0] == 'worker.js.map'))
    require(source_map.get('version') == 3, 'Unexpected source map version')
    names, contents = source_map.get('sources', []), source_map.get('sourcesContent', [])
    require(len(names) == len(contents), 'Source map has incomplete originals')
    result = {}
    for name, content in zip(names, contents):
        # External --outdir maps use ../runtime/src paths; deployed maps may use src/.
        # Normalize only application originals, never a dependency's own src directory.
        match = re.search(r'(?:^|/)src/([^/]+\.js)$', name)
        if match and 'node_modules/' not in name:
            canonical_name = 'src/' + match.group(1)
            require(canonical_name not in result and isinstance(content, str), 'Duplicate/missing source original')
            result[canonical_name] = sha(content.encode())
    require(set(result) == set(BASE_HASHES), 'Unexpected application module set')
    return result


def module_hashes(modules):
    return {name: sha(data) for name, _, data in modules}


def local_modules(bundle_dir, repo_dir):
    modules = []
    for name, mime in [('worker.js', 'application/javascript+module'), ('worker.js.map', 'application/source-map')]:
        p = bundle_dir / name
        require(p.is_file() and not p.is_symlink(), 'Missing regular bundle module')
        modules.append((name, mime, p.read_bytes()))
    wanted = {name: sha((repo_dir / name).read_bytes()) for name in BASE_HASHES}
    require(source_hashes(modules) == wanted, 'Bundle originals differ from reviewed checkout')
    return modules, wanted


def verify_merge(reviewed_sha, repo_dir):
    require(re.fullmatch(r'[0-9a-f]{40}', reviewed_sha or '') is not None, 'Expected full reviewed merge SHA')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo_dir, text=True).strip()
    require(head == reviewed_sha, 'Checkout is not exact reviewed merge SHA')
    token = os.environ.get('GITHUB_TOKEN', '')
    require(bool(token), 'Missing existing GitHub runner token')
    request = urllib.request.Request('https://api.github.com/repos/Maverlix777/hub/pulls/60', headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hub-931-content-deploy',
    })
    try:
        with authenticated_open(request, timeout=30) as response:
            pr = json.load(response)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        raise DeployError('Cannot verify merged PR60 through GitHub API') from None
    require(pr.get('merged') is True and pr.get('merge_commit_sha') == reviewed_sha,
            'Reviewed SHA is not merged PR60')
    require(pr.get('head', {}).get('sha') == REVIEWED_HEAD and pr.get('base', {}).get('ref') == 'main',
            'PR60 head/base differs from independently reviewed code')
    print('PASS exact merged PR60 SHA and reviewed head')


class Cloudflare:
    def __init__(self):
        account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
        self.token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
        require(bool(account and self.token), 'Missing existing Cloudflare runner secrets')
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + account
        self.script = '/workers/scripts/' + WORKER

    def request(self, path, method='GET', body=None, content_type=None, raw=False):
        require(method in {'GET', 'PUT'} and (method == 'GET' or path == self.script + '/content'),
                'Forbidden Cloudflare write path')
        headers = {'Authorization': 'Bearer ' + self.token}
        if content_type:
            headers['Content-Type'] = content_type
        req = urllib.request.Request(self.base + path, method=method, data=body, headers=headers)
        try:
            with authenticated_open(req, timeout=60) as response:
                data = response.read()
                response_type = response.headers.get('Content-Type', '')
        except urllib.error.HTTPError as error:
            raise DeployError(f'Cloudflare {method} HTTP {error.code}; response withheld') from None
        except (urllib.error.URLError, TimeoutError):
            raise DeployError(f'Cloudflare {method} transport failed; details withheld') from None
        if raw:
            return data, response_type
        payload = json.loads(data)
        require(payload.get('success') is True, 'Cloudflare success=false; details withheld')
        return payload['result']

    def active(self):
        deployments = self.request(self.script + '/deployments')['deployments']
        require(bool(deployments), 'No current deployment')
        versions = deployments[0]['versions']
        require(len(versions) == 1 and versions[0]['percentage'] == 100, 'Expected one version at100%')
        return versions[0]['version_id']

    def content(self):
        return parse_modules(*self.request(self.script + '/content/v2', raw=True))

    def settings(self):
        result = self.request(self.script + '/settings')
        result['bindings'] = sorted(result.get('bindings', []), key=lambda b: b['name'])
        return result

    def domain(self):
        result = self.request('/workers/domains?hostname=' + HOSTNAME)
        require(len(result) == 1 and result[0]['service'] == WORKER and result[0]['enabled'] is True,
                'Public domain no longer names the expected active service')
        return result

    def runtime(self, version):
        return self.request(self.script + '/versions/' + version)['resources']['script_runtime']

    def upload(self, modules):
        body, content_type = multipart(modules)
        return self.request(self.script + '/content', method='PUT', body=body, content_type=content_type)


def deploy(api, modules, wanted):
    require(api.active() == BASE_VERSION, 'Live baseline version changed; no write')
    old_domain, old_settings, old_runtime = api.domain(), api.settings(), api.runtime(BASE_VERSION)
    old_modules = api.content()  # Complete multipart stays only in this process memory.
    require(source_hashes(old_modules) == BASE_HASHES, 'Live source originals changed; no write')
    require(api.active() == BASE_VERSION, 'Live version raced preflight; no write')
    require(api.domain() == old_domain and api.settings() == old_settings,
            'Live domain/config raced preflight; no write')
    print('PASS preflight baseline,9/9 source hashes,domain and unchanged configuration')
    result = api.upload(modules)
    # Exactly one PUT: no automatic retry or rollback may race another deployment.
    new_version = api.active()
    uploaded = api.content()
    require(new_version != BASE_VERSION and module_hashes(uploaded) == module_hashes(modules),
            'Postcondition: active content does not identify uploaded modules; manual state review required')
    require(bool(result.get('etag')), 'Postcondition: upload ETag absent; manual state review required')
    version_result = api.request(api.script + '/versions/' + new_version)
    require(version_result['resources']['script']['etag'] == result['etag'],
            'Postcondition: active version ETag differs; manual state review required')
    require(source_hashes(uploaded) == wanted, 'Postcondition: deployed originals differ from reviewed merge')
    require(api.settings() == old_settings, 'Postcondition: configuration changed')
    require(api.domain() == old_domain, 'Postcondition: domain changed')
    require(api.runtime(new_version) == old_runtime, 'Postcondition: runtime/assets settings changed')
    require(api.active() == new_version, 'Postcondition: concurrent active version change')
    print('PASS content-only rollout; active_version=' + new_version)
    print('PASS9/9 reviewed originals; module SHA256=' + sha(canonical(module_hashes(uploaded))))
    print('PASS bindings/config/asset runtime/domain unchanged; config SHA256=' + sha(canonical(old_settings)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-merge-only', action='store_true')
    args = parser.parse_args()
    repo_dir = Path(os.environ['HUB_REPO_DIR']).resolve()
    verify_merge(os.environ.get('HUB_REVIEWED_SHA', ''), repo_dir)
    if args.verify_merge_only:
        return
    require(os.environ.get('HUB_CONTENT_CONFIRM') == 'APPLY #931 CONTENT ONLY', 'Missing scoped confirmation')
    modules, wanted = local_modules(Path(os.environ['HUB_BUNDLE_DIR']), repo_dir)
    deploy(Cloudflare(), modules, wanted)


if __name__ == '__main__':
    try:
        main()
    except DeployError as error:
        print('FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('FAILED: unexpected deployment validation/transport error; details withheld', file=sys.stderr)
        sys.exit(1)
