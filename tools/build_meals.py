"""Build the passcode-locked Meal Prep Picker for GitHub Pages.

Usage:
  python3 build_meals.py SOURCE_HTML PHOTOS_DIR OUT_DIR PASSCODE [--supabase-url URL --supabase-key KEY] [--migrate migrate.json]

SOURCE_HTML is the Meal Prep Picker page from Claude (the artifact). PHOTOS_DIR holds <recipe id>.webp files.
Everything copyrighted (recipe text, photos) is written to OUT_DIR only as AES-GCM ciphertext
(data.bin, photos/<id>.bin). The passcode unlocks it in the browser; nothing readable is published.
"""
import argparse, base64, json, os, re, secrets, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITER = 250000

ap = argparse.ArgumentParser()
ap.add_argument('source'); ap.add_argument('photos'); ap.add_argument('out'); ap.add_argument('passcode')
ap.add_argument('--supabase-url', default=''); ap.add_argument('--supabase-key', default='')
ap.add_argument('--migrate', default='')
ap.add_argument('--demo', action='store_true', help='also write try.html: opens with the key in the link, saves nothing')
a = ap.parse_args()

src = open(a.source, encoding='utf-8').read()
# strip an artifact skeleton if present
if '<body>' in src[:3000]:
    src = src[src.index('<body>') + 6:]
    src = re.sub(r'</body>\s*</html>\s*$', '', src)

style = src[src.index('<style>'):src.index('</style>') + 8]
fonts = '\n'.join(l for l in src.split('\n')[:12] if l.startswith('<link'))
body_start = src.index('</style>') + 8
script_start = src.index('<script>')
markup = src[body_start:script_start].strip()
app_js = src[script_start + 8:src.rindex('</script>')]

# ---- data out of the script ----
m = re.search(r'^const RECIPES = (\[.*\]);$', app_js, re.M)
recipes = json.loads(m.group(1))
app_js = app_js[:m.start()] + 'const RECIPES = window.__MP.recipes;' + app_js[m.end():]

def rep(a_, b_, n=1):
    global app_js
    c = app_js.count(a_)
    assert c == n, (c, a_[:80])
    app_js = app_js.replace(a_, b_)

rep('try { [db, user] = await Promise.all([window.claude?.use?.("db") ?? null, window.claude?.use?.("user") ?? null]); } catch (e) {}',
    'try { db = window.__MP.makeDb(); user = window.__MP.user; } catch (e) { console.error(e); }')
rep('"Saving on this device only. Open the shared link to sync with each other."',
    '(window.__MP.demo ? "Preview: nothing is saved. Your picks and list reset when you reload the page." : "Saving on this device only. Syncing is not set up yet.")')
rep('src="photos/${r.id}.webp"', 'data-photo="${r.id}" src="${window.__MP.blank}"', 2)

# ---- encrypt ----
salt = secrets.token_bytes(16)
_old = os.path.join(a.out, 'index.html')
if os.path.exists(_old):
    _m = re.search(r'window.__MPCFG = (\{.*?\});', open(_old, encoding='utf-8').read())
    if _m: salt = base64.b64decode(json.loads(_m.group(1))['salt'])
key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(a.passcode.encode())
aes = AESGCM(key)
def enc(b):
    iv = secrets.token_bytes(12)
    return iv + aes.encrypt(iv, b, None)

payload = {'recipes': recipes}
if a.migrate:
    payload['migrate'] = json.load(open(a.migrate))
os.makedirs(os.path.join(a.out, 'photos'), exist_ok=True)
open(os.path.join(a.out, 'data.bin'), 'wb').write(enc(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()))
n = 0
ids = {r['id'] for r in recipes}
for f in sorted(os.listdir(a.photos)):
    rid, ext = os.path.splitext(f)
    if ext != '.webp' or rid not in ids: continue
    open(os.path.join(a.out, 'photos', rid + '.bin'), 'wb').write(enc(open(os.path.join(a.photos, f), 'rb').read()))
    n += 1
# remove stale photos
for f in os.listdir(os.path.join(a.out, 'photos')):
    if os.path.splitext(f)[0] not in ids: os.remove(os.path.join(a.out, 'photos', f))

# ---- app.js ----
open(os.path.join(a.out, 'app.js'), 'w', encoding='utf-8').write('// Meal Prep Picker app. Recipe data and photos load encrypted (see index.html).\n' + app_js)

# ---- index.html ----
cfg = {'salt': base64.b64encode(salt).decode(), 'iter': ITER,
       'sbUrl': a.supabase_url.rstrip('/'), 'sbKey': a.supabase_key}
gate = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gate.js'), encoding='utf-8').read()
html = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#2C6943">
<title>Meal Prep Picker</title>
{fonts}
{style}
<style>
:root {{ padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }}
body {{ margin: 0; }}
img {{ max-width: 100%; }}
.lock {{ min-height: 100vh; display: grid; place-items: center; padding: 24px max(16px, env(safe-area-inset-left, 0px)); }}
.lockcard {{ width: min(420px, 100%); background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; display: grid; gap: 14px; }}
.lockcard input {{ width: 100%; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); font-size: 17px; }}
.lockcard .err {{ color: var(--chile); font-size: 14px; min-height: 1.2em; }}
</style>
</head>
<body>
<div class="lock" id="lock">
  <form class="lockcard" id="lockform" autocomplete="on">
    <div class="brand" style="margin:0">Meal Prep Picker</div>
    <p class="sub" style="margin:0">Enter the passcode to open the cookbooks. You only need to do this once on each device.</p>
    <input id="pass" type="password" autocomplete="current-password" placeholder="Passcode" aria-label="Passcode" required>
    <button class="btn primary" type="submit" id="unlockbtn" style="justify-content:center;padding:12px">Open</button>
    <div class="err" id="lockerr" role="alert"></div>
  </form>
</div>
<div id="app" hidden>
{markup}
</div>
<script>window.__MPCFG = {json.dumps(cfg)};</script>
<script>
{gate}
</script>
</body>
</html>
'''
open(os.path.join(a.out, 'index.html'), 'w', encoding='utf-8').write(html)
if a.demo:
    dcfg = dict(cfg, demo=True, sbUrl='', sbKey='')
    dhtml = html.replace('window.__MPCFG = ' + json.dumps(cfg), 'window.__MPCFG = ' + json.dumps(dcfg))
    open(os.path.join(a.out, 'try.html'), 'w', encoding='utf-8').write(dhtml)
    print('preview link: https://totentanzmealprep.github.io/try.html#' + base64.urlsafe_b64encode(key).decode().rstrip('='))
print(f'built {len(recipes)} recipes, {n} photos -> {a.out}')
