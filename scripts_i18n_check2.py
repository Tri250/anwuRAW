#!/usr/bin/env python3
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

def has_key(d, key):
    """check key or any plural variant"""
    if key in d:
        return True, d[key]
    for suf in ("_one", "_other", "_two", "_few", "_many", "_zero"):
        if key + suf in d:
            return True, d[key + suf]
    return False, None

en = json.load(open("src/i18n/locales/en.json"))
flat_en = {}
def build(d, prefix=""):
    for k, v in d.items():
        full = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            build(v, full)
        else:
            flat_en[full] = v
build(en)

candidates = [
    "adjustments.channelMixer.title",
    "adjustments.channelMixer.outputs",
    "adjustments.channelMixer.reset",
    "adjustments.channelMixer.hint",
    "adjustments.channelMixer.red",
    "adjustments.channelMixer.green",
    "adjustments.channelMixer.blue",
    "adjustments.splitToning.title",
    "adjustments.splitToning.enabled",
    "adjustments.splitToning.highlights",
    "adjustments.splitToning.shadows",
    "adjustments.splitToning.saturation",
    "adjustments.splitToning.balance",
    "editor.adjustments.sections.channel_mixer",
    "editor.adjustments.sections.split_toning",
    "editor.masks.params.decontaminate",
    "editor.ai.params.sensitivity",
    "editor.ai.params.pressure",
    "editor.ai.params.intensity",
    "editor.crop.tooltips.aiStraighten",
    "export.status.completed",
    "library.items.imagesCount",
    "library.viewMode.grid",
    "library.viewMode.list",
    "library.viewMode.culling",
    "modals.culling.applyButton",
    "modals.focusStack.descriptionWithCount",
    "ui.bottomBar.tooltips.rateStars",
]
for key in candidates:
    parts = key.split(".")
    d = en
    ok = True
    for p in parts[:-1]:
        if isinstance(d, dict) and p in d:
            d = d[p]
        else:
            ok = False
            break
    if ok:
        ok, val = has_key(d if isinstance(d, dict) else {}, parts[-1])
    print(("OK   " if ok else "MISS ") + key + ("" if ok else "   <<<< ADD"))
