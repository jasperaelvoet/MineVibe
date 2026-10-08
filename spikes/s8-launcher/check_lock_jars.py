"""Checks every lock entry's modId against the jar's fabric.mod.json (downloads opt-ins to scratch if needed)."""
import hashlib
import json
import os
import sys
import urllib.request
import zipfile

lock_path, mods_dir, scratch = sys.argv[1], sys.argv[2], sys.argv[3]
lock = json.load(open(lock_path))
ok = True
for m in lock['mods']:
    path = os.path.join(mods_dir, m['filename'])
    if not os.path.exists(path):
        path = os.path.join(scratch, m['filename'])
        if not os.path.exists(path):
            req = urllib.request.Request(m['url'], headers={'User-Agent': 'MineVibe/0.0.0 (+https://github.com/jasperaelvoet/MineVibe)'})
            data = urllib.request.urlopen(req).read()
            open(path, 'wb').write(data)
    data = open(path, 'rb').read()
    sha = hashlib.sha512(data).hexdigest()
    with zipfile.ZipFile(path) as z:
        fmj = json.loads(z.read('fabric.mod.json').decode('utf-8'), strict=False)
    match = fmj['id'] == m['modId'] and sha == m['sha512'] and len(data) == m['size']
    ok = ok and match
    print(f"{'OK ' if match else 'BAD'} {m['slug']:18} lock={m['modId']:18} jar={fmj['id']:18} env={fmj.get('environment', '*')}")
print('ALL OK' if ok else 'MISMATCH')
