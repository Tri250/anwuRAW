#!/usr/bin/env python3
"""Diff i18n keys between en.json and zh-CN.json, grouped by top-level namespace."""
import json

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
zh = json.load(open("src/i18n/locales/zh-CN.json"))

en_keys = flatten(en)
zh_keys = flatten(zh)
missing = sorted(en_keys - zh_keys)
extra = sorted(zh_keys - en_keys)

print(f"en total: {len(en_keys)}, zh total: {len(zh_keys)}")
print(f"missing in zh: {len(missing)}, extra in zh: {len(extra)}")
print("\n=== MISSING (grouped by top namespace) ===")
from collections import defaultdict
groups = defaultdict(list)
for k in missing:
    groups[k.split(".")[0]].append(k)
for ns in sorted(groups):
    print(f"\n--- {ns} ({len(groups[ns])}) ---")
    for k in groups[ns]:
        print(k)
if extra:
    print("\n=== EXTRA in zh (not in en) ===")
    for k in extra[:50]:
        print(k)
