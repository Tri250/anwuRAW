#!/usr/bin/env python3
"""Extract all i18n keys used in source and verify they exist in en.json."""
import json, re, os

def flatten(d, prefix=""):
    keys = set()
    for k, v in d.items():
        full = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            keys |= flatten(v, full)
        else:
            keys.add(full)
    return keys

en = json.load(open("src/i18n/locales/en.json"))
en_keys = flatten(en)

pattern = re.compile(r"""(?:\bt|i18n\.t)\(\s*['"`]([a-zA-Z0-9_.]+)['"`]""")
dynamic = re.compile(r"""\bt\(\s*`([^`]+)\${""")
missing = {}
count = 0
for root, dirs, files in os.walk("src"):
    dirs[:] = [d for d in dirs if d not in ("i18n", "node_modules")]
    for f in files:
        if not f.endswith((".tsx", ".ts")):
            continue
        p = os.path.join(root, f)
        src = open(p, encoding="utf-8").read()
        for m in pattern.finditer(src):
            key = m.group(1)
            count += 1
            if key not in en_keys:
                missing.setdefault(key, []).append(p)
        for m in dynamic.finditer(src):
            prefix_key = m.group(1)
            missing.setdefault(prefix_key + "* (dynamic prefix)", []).append(p)

print(f"static keys used: {count}")
print(f"missing keys: {sum(1 for k in missing)}")
for k in sorted(missing):
    files = sorted(set(missing[k]))
    print(f"  MISSING: {k}")
    for f in files:
        print(f"      at {f}")
