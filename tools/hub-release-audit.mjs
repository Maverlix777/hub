#!/usr/bin/env node
// Read-only audit. Uses existing gh authentication internally; never extracts a token.
import {readFile, writeFile, access} from 'node:fs/promises';
import {resolve, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export function jsonBlock(html, id) {
  const match = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/script>`));
  if (!match) throw new Error(`Missing JSON block: ${id}`);
  const value=JSON.parse(match[1]); if(!Array.isArray(value)) throw new Error('Expected array'); return value;
}
export function githubReleaseURL(value) {
  try { const u=new URL(value); if(u.protocol!=='https:' || u.hostname!=='github.com' || u.username || u.password) return null;
    const parts=u.pathname.split('/').filter(Boolean); if(parts[2]!=='releases') return null;
    if(parts[3]==='download' && parts.length===6) return {repo:parts.slice(0,2).join('/'),tag:decodeURIComponent(parts[4]),asset:decodeURIComponent(parts[5])};
    if(parts[3]==='latest' && parts.length===4) return {repo:parts.slice(0,2).join('/'),latest:true};
  } catch {} return null;
}
export function compareAsset(item, release) {
  const parsed=githubReleaseURL(item.url); const asset=release?.assets?.find(a=>a.name===(parsed?.asset || item.file));
  if(!asset) return {status:'missing_asset'};
  const digest=asset.digest?.replace(/^sha256:/,'');
  const mismatches=[]; if(asset.size!==item.size)mismatches.push('size'); if(digest && digest!==item.sha256)mismatches.push('sha256');
  return {status:mismatches.length?'metadata_mismatch':digest?'metadata_verified':'digest_unknown',mismatches,tag:release.tag_name,publishedAt:release.published_at,asset:asset.name,url:asset.browser_download_url,size:asset.size,sha256:digest||null,draft:!!release.draft,prerelease:!!release.prerelease};
}
const ghCache=new Map();
let deadline=Infinity;
function gh(endpoint) {
  if(!ghCache.has(endpoint)) {
    // Endpoint is constructed only from validated repository/path components, no shell.
    if(Date.now()>=deadline) throw new Error('audit_budget_exhausted');
    const raw=execFileSync('gh',['api',endpoint,'--paginate','--slurp'],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:Math.max(1,Math.min(10000,deadline-Date.now())),stdio:['ignore','pipe','pipe']});
    const pages=JSON.parse(raw); ghCache.set(endpoint,Array.isArray(pages[0])?pages.flat():pages[0]);
  } return ghCache.get(endpoint);
}
export async function hashDownload(url, expected, fetchImpl=fetch, budgetDeadline=Infinity) {
  const expiresAt=Math.min(budgetDeadline,Date.now()+60000);
  const allowed = new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','kolobovdjp.org','hub.kolobovdjp.org']);
  let current=new URL(url); let response;
  for(let redirects=0;redirects<8;redirects++) {
    if(Date.now()>=expiresAt)return {status:'deferred_budget'};
    if(current.protocol!=='https:' || current.username || current.password || !allowed.has(current.hostname)) return {status:'blocked_redirect'};
    response=await fetchImpl(current,{redirect:'manual',signal:AbortSignal.timeout(Math.max(1,expiresAt-Date.now()))});
    if([301,302,303,307,308].includes(response.status)) { const location=response.headers.get('location'); await response.body?.cancel(); if(!location)return{status:'invalid_redirect'}; current=new URL(location,current); continue; }
    break;
  }
  if(!response?.ok) {await response?.body?.cancel();return {status:[401,403].includes(response?.status)?'access_denied_unverified':'http_error',httpStatus:response?.status||0};}
  const hash=createHash('sha256');let size=0;
  for await(const chunk of response.body) {if(Date.now()>=expiresAt)return{status:'deferred_budget'};size+=chunk.length;if(size>512*1024*1024)throw new Error('asset_size_limit');hash.update(chunk);}
  const sha256=hash.digest('hex');return{status:size===expected.size && sha256===expected.sha256?'bytes_verified':'bytes_mismatch',httpStatus:response.status,size,sha256};
}
export async function audit(root, {network=false,hash=false,budgetMs=30000}={}) {
  deadline=Date.now()+Math.max(1000,Math.min(Number(budgetMs)||30000,180000)); ghCache.clear();
  const html=await readFile(resolve(root,'public/apps/downloads.html'),'utf8');const index=await readFile(resolve(root,'public/index.html'),'utf8');
  const items=jsonBlock(html,'manifest');const apps=jsonBlock(index,'apps');const checkedAt=new Date().toISOString();
  const rows=[];const repositories=new Set();
  for(const item of items) {
    const row={project:item.project,platform:item.platform,kind:item.kind,version:item.version,file:item.file,url:item.url||null};
    if(item.available===false) {rows.push({...row,status:'declared_unavailable'});continue;}
    const link=githubReleaseURL(item.url);
    if(link)repositories.add(link.repo);
    if(!network) {rows.push({...row,status:'not_checked',byteVerification:'not_checked'});continue;}
    if(Date.now()>=deadline) {rows.push({...row,status:'deferred_budget',byteVerification:'not_checked'});continue;}
    row.byteVerification='not_checked';
    try {
      if(link) {
        const release=gh(`repos/${link.repo}/releases/${link.latest?'latest':`tags/${encodeURIComponent(link.tag)}`}`);
        Object.assign(row,compareAsset(item,release));
        try {row.publicationCommit=gh(`repos/${link.repo}/commits/${encodeURIComponent(release.tag_name)}`).sha;}catch{row.publicationCommit=null;}
        row.sourceCommitVerification='not_established_by_publication_tag';
        if(hash && row.url && !row.draft && !row.prerelease)row.download=await hashDownload(row.url,item,fetch,deadline);
      } else {
        row.status='external_artifact_unverified';
        const external=new URL(item.url);
        if(external.protocol==='https:' && ['kolobovdjp.org','hub.kolobovdjp.org'].includes(external.hostname) && !external.username && !external.password) {
          const response=await fetch(external,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now())))});
          row.httpStatus=response.status; row.status=[401,403].includes(response.status)?'access_denied_unverified':response.ok?'external_reachable_unverified':'external_http_unverified';
        }
        if(hash)row.download=await hashDownload(item.url,item,fetch,deadline);
      }
    } catch {row.status=Date.now()>=deadline?'deferred_budget':'request_failed';}
    if(row.download)row.byteVerification=row.download.status;
    rows.push(row);
  }
  const appLinks=[];
  for(const app of apps) {
    const row={id:app.id,href:app.href};
    if(!/^https?:/.test(app.href)) {
      const path=resolve(root,'public',app.href);if(relative(resolve(root,'public'),path).startsWith('..'))row.status='invalid_path';else{try{await access(path);row.status='local_present';}catch{row.status='local_missing';}}
    } else if(network && Date.now()<deadline) {try {const r=await fetch(app.href,{method:'HEAD',redirect:'follow',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now())))});row.httpStatus=r.status;row.status=r.ok?'reachable':'http_error';}catch{row.status='request_failed';}}
    else row.status='not_checked'; appLinks.push(row);
  }
  const uncatalogued=[];const releaseInventory=[];
  if(network)for(const repo of repositories) {
    if(Date.now()>=deadline){releaseInventory.push({repo,status:'deferred_budget'});continue;}
    try {for(const release of gh(`repos/${repo}/releases`)) {
      if(release.draft || release.prerelease)continue;
      releaseInventory.push({repo,tag:release.tag_name,publishedAt:release.published_at,assets:release.assets.map(a=>({name:a.name,size:a.size,digest:a.digest||null,url:a.browser_download_url}))});
      for(const asset of release.assets)if(/\.(apk|ipa|aab)$/i.test(asset.name) && !rows.some(r=>r.url===asset.browser_download_url))uncatalogued.push({repo,tag:release.tag_name,publishedAt:release.published_at,file:asset.name,url:asset.browser_download_url,size:asset.size,sha256:asset.digest?.replace(/^sha256:/,'')||null,status:'candidate_requires_suitability_review'});
    }}catch{releaseInventory.push({repo,status:'request_failed'});}
  }
  return {schemaVersion:1,checkedAt,completedAt:new Date().toISOString(),staleAfter:new Date(Date.parse(checkedAt)+30*60*1000).toISOString(),readOnly:true,network,hash,budgetMs,budgetExhausted:Date.now()>=deadline,counts:{catalog:items.length,apps:apps.length},apps:appLinks,downloads:rows,uncatalogued,releaseInventory};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);const option=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
  const root=resolve(option('--root')||resolve(dirname(fileURLToPath(import.meta.url)),'..'));
  const report=await audit(root,{network:args.includes('--network'),hash:args.includes('--hash'),budgetMs:Number(option('--budget-ms')||30000)});
  const output=option('--output');if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report,null,2));
}



