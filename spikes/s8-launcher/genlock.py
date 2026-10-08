"""Writes packaging/mods.lock.json from ONE saved Modrinth response.

    curl -G -A 'MineVibe/0.0.0 (+https://github.com/jasperaelvoet/MineVibe)' \
      --data-urlencode 'ids=["v2j28coa","bAZQdGpg",...]' https://api.modrinth.com/v2/versions -o versions.json
    python3 genlock.py versions.json ../../packaging/mods.lock.json
"""
import json
import sys

src, out = sys.argv[1], sys.argv[2]
d = {v['id']: v for v in json.load(open(src))}
# (slug, name, versionId, modId, side, optional, note)
spec = [
    ('fabric-api', 'Fabric API', 'v2j28coa', 'fabric-api', 'both', False, None),
    ('sodium', 'Sodium', 'bAZQdGpg', 'sodium', 'client', False,
     'Pinned to 0.9.2 (release), not the 0.9.3 alpha. Polyform Shield: never rehost.'),
    ('lithium', 'Lithium', 'xS0Q8LSi', 'lithium', 'both', False, None),
    ('ferrite-core', 'FerriteCore', 'd5ddUdiB', 'ferritecore', 'both', False, None),
    ('immediatelyfast', 'ImmediatelyFast', '3MP9UR23', 'immediatelyfast', 'client', False, None),
    ('entityculling', 'Entity Culling', 'F4loCvYt', 'entityculling', 'client', False,
     'Custom license: never rehost.'),
    ('moreculling', 'More Culling', 't7vAlfgO', 'moreculling', 'client', False, 'Requires Cloth Config.'),
    ('cloth-config', 'Cloth Config API', 'fg2uyxOW', 'cloth-config', 'both', False, None),
    ('dynamic-fps', 'Dynamic FPS', 'Jwq069rR', 'dynamic_fps', 'client', False, None),
    ('badoptimizations', 'BadOptimizations', 'Sp0ctspw', 'badoptimizations', 'client', False, None),
    ('sodium-extra', 'Sodium Extra', 'te2y9qZn', 'sodium-extra', 'client', False, 'Requires Sodium.'),
    ('iris', 'Iris Shaders', 'vTN4NRGW', 'iris', 'client', True,
     'Opt-in. OpenGL only (the launcher always forces OpenGL).'),
    ('c2me-fabric', 'C2ME', 'ODMLK8M9', 'c2me', 'both', True,
     'Opt-in, ALPHA on 26.3: enable only with automatic world backups.'),
    ('chunky', 'Chunky', '4Eotm6ov', 'chunky', 'both', True, 'Opt-in: world pre-generation.'),
    ('spark', 'spark', 'e3hsPc1o', 'spark', 'both', True, 'Dev only: profiler.'),
    ('modmenu', 'Mod Menu', 'kyy7dbrZ', 'modmenu', 'client', True,
     'Dev only. Its Modrinth dependency eXts2L7r (Text Placeholder API) ships inside the jar (jar-in-jar).'),
]
mods = []
for slug, name, vid, modid, side, opt, note in spec:
    v = d[vid]
    prim = [f for f in v['files'] if f.get('primary')]
    assert len(prim) == 1, vid
    f = prim[0]
    e = {
        'slug': slug, 'name': name, 'projectId': v['project_id'], 'versionId': vid,
        'versionNumber': v['version_number'], 'versionType': v['version_type'], 'modId': modid,
        'filename': f['filename'], 'size': f['size'], 'sha512': f['hashes']['sha512'], 'url': f['url'],
        'side': side, 'optional': opt,
    }
    if note:
        e['note'] = note
    mods.append(e)
lock = {
    '$comment': 'Pinned by Modrinth version id + sha512 (PLAN section 10). Filled from ONE '
                'GET https://api.modrinth.com/v2/versions?ids=[...] (primary file only). Never resolve '
                '"latest" at runtime and never rehost these jars.',
    'lockVersion': 1,
    'minecraft': '26.3',
    'loader': '0.19.5',
    'generated': '2026-10-08',
    'mods': mods,
}
open(out, 'w').write(json.dumps(lock, indent=2) + '\n')
print(len(mods), sum(m['size'] for m in mods if not m['optional']))
