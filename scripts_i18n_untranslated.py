#!/usr/bin/env python3
"""Find zh-CN values that look untranslated (mostly ASCII / same as English)."""
import json, re

def iter_items(d, prefix=""):
    for k, v in d.items():
        full = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            yield from iter_items(v, full)
        else:
            yield full, v

en = json.load(open("src/i18n/locales/en.json"))
zh = json.load(open("src/i18n/locales/zh-CN.json"))

en_map = dict(iter_items(en))
count = 0
for k, v in iter_items(zh):
    if not isinstance(v, str):
        continue
    # no CJK char and length > 1 => suspicious
    has_cjk = re.search(r'[\u4e00-\u9fff]', v)
    if not has_cjk and len(v.strip()) > 1:
        count += 1
        print(f"{k} = {v!r}   (en: {en_map.get(k)!r})")
print(f"\nTOTAL suspicious: {count}")
