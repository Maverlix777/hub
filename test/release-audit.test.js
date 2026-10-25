import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {jsonBlock, githubReleaseURL, compareAsset, hashDownload, audit} from '../tools/hub-release-audit.mjs';
test('extracts catalog JSON and rejects missing or wrong shape',()=>{
  assert.deepEqual(jsonBlock('<script type="application/json" id="manifest">[]</script>','manifest'),[]);
  assert.throws(()=>jsonBlock('none','manifest')); assert.throws(()=>jsonBlock('<script id="manifest">{}</script>','manifest'));
});
test('GitHub links preserve exact tag/filename and reject deceptive or credential hosts',()=>{
  assert.deepEqual(githubReleaseURL('https://github.com/a/b/releases/download/v1/a%20b.ipa'),{repo:'a/b',tag:'v1',asset:'a b.ipa'});
  assert.deepEqual(githubReleaseURL('https://github.com/a/b/releases/latest'),{repo:'a/b',latest:true});
  for(const url of ['http://github.com/a/b/releases/latest','https://github.com.evil/a/b/releases/latest','https://x:secret@github.com/a/b/releases/latest'])assert.equal(githubReleaseURL(url),null);
});
test('asset identity, digest, size, unavailable and unknown metadata remain distinct',()=>{
  const item={url:'https://github.com/a/b/releases/latest',file:'a.ipa',size:3,sha256:'123'};
  const release={tag_name:'v1',assets:[{name:'a.ipa',size:3,digest:'sha256:123',browser_download_url:'https://github.com/a/b/releases/download/v1/a.ipa'}]};
  assert.equal(compareAsset(item,release).status,'metadata_verified');assert.equal(compareAsset({...item,file:'b.ipa'},release).status,'missing_asset');
  assert.deepEqual(compareAsset({...item,size:4,sha256:'456'},release).mismatches,['size','sha256']);
  assert.equal(compareAsset(item,{assets:[{name:'a.ipa',size:3}]}).status,'digest_unknown');
});
test('real streamed bytes independently confirm SHA and size; mismatch is not success',async()=>{
  const bytes='synthetic binary';const expected={size:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')};
  assert.equal((await hashDownload('https://github.com/a/b/releases/download/v1/file',expected,async()=>new Response(bytes))).status,'bytes_verified');
  assert.equal((await hashDownload('https://github.com/a/b/releases/download/v1/file',{...expected,size:999},async()=>new Response(bytes))).status,'bytes_mismatch');
});
test('redirect to unapproved host and HTTP failure cannot report downloaded',async()=>{
  let calls=0;const response=await hashDownload('https://github.com/a/b/releases/download/v1/file',{},async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://evil.test/secret'}});});
  assert.equal(response.status,'blocked_redirect');assert.equal(calls,1);
  assert.equal((await hashDownload('https://github.com/a/b/releases/download/v1/file',{},async()=>new Response(null,{status:404}))).status,'http_error');
});
test('offline audit inventories every catalog and app without implying live verification',async()=>{
  const report=await audit(fileURLToPath(new URL('..',import.meta.url)));
  assert.equal(report.counts.catalog,36);assert.equal(report.counts.apps,5);
  assert.equal(report.downloads.filter(x=>x.status==='declared_unavailable').length,1);
  assert.ok(report.downloads.every(x=>['declared_unavailable','not_checked'].includes(x.status)));assert.equal(report.readOnly,true);
});



test('expired shared budget stops hashing before any network request',async()=>{let calls=0;const result=await hashDownload('https://github.com/a/b/releases/download/v1/file',{},async()=>{calls++;return new Response('x');},Date.now()-1);assert.equal(result.status,'deferred_budget');assert.equal(calls,0);});
