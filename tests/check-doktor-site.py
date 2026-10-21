"""Проверка public/doktor: HTML парсится, внутренние ссылки существуют, внешних ресурсов и скриптов нет, обязательные страницы на месте. Запуск: python3 -I tests/check-doktor-site.py
Логика скопирована из check.py репо Maverlix777/doktor (site/doktor/check.py, HEAD 899a074); ROOT заменён на public/doktor, добавлены проверки обязательных файлов и <script."""
import os, sys
from html.parser import HTMLParser
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public', 'doktor')
class P(HTMLParser):
    def __init__(s): super().__init__(convert_charrefs=True); s.links=[]; s.res=[]; s.ids=set(); s.stack=[]; s.err=[]
    VOID={"meta","link","br","img","hr","input"}
    def handle_starttag(s,t,a):
        a=dict(a)
        if "id" in a: s.ids.add(a["id"])
        if t=="a" and "href" in a: s.links.append(a["href"])
        if t in("script","img","iframe","source","video","audio"): s.res.append((t,a.get("src")))
        if t=="link" and a.get("href"): s.res.append((t,a["href"]))
        if t not in s.VOID: s.stack.append(t)
    def handle_endtag(s,t):
        if t in s.VOID: return
        if s.stack and s.stack[-1]==t: s.stack.pop()
        else: s.err.append(f"unbalanced </{t}> stack={s.stack[-3:]}")
bad=0; pages={}
for d,_,fs in os.walk(ROOT):
    for f in fs:
        if f.endswith(".html"):
            p=os.path.join(d,f); x=P(); x.feed(open(p,encoding="utf-8").read()); x.close()
            pages[p]=x
            if x.stack or x.err: print("PARSE",p,x.stack,x.err); bad+=1
for p,x in pages.items():
    for t,u in x.res:
        if u and (u.startswith(("http:","https:","//"))): print("EXTERNAL RESOURCE",p,t,u); bad+=1
        if t=="script": print("SCRIPT",p); bad+=1
        if u and not u.startswith(("http","//")):
            if not os.path.exists(os.path.join(os.path.dirname(p),u)): print("MISSING RES",p,u); bad+=1
    for h in x.links:
        if h.startswith(("http:","https:","mailto:")): continue
        path,_,frag=h.partition("#")
        tgt=p if not path else os.path.normpath(os.path.join(os.path.dirname(p),path))
        if not os.path.exists(tgt): print("BROKEN",p,h); bad+=1; continue
        if frag and tgt in pages and frag not in pages[tgt].ids: print("NO ANCHOR",p,h); bad+=1
for need in ("index.html", "privacy.html", "support.html", "terms.html"):
    if not os.path.isfile(os.path.join(ROOT, need)): print("MISSING REQUIRED", need); bad+=1
for p in pages:
    if "<script" in open(p,encoding="utf-8").read().lower(): print("SCRIPT TAG",p); bad+=1
print(f"doktor site OK: {len(pages)} pages" if not bad else f"FAIL problems={bad}")
sys.exit(1 if bad else 0)
