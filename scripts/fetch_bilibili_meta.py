#!/usr/bin/env python3
"""Fetch cover URL and author name for every mapped track.

The batch archives endpoint is closed to anonymous callers, so this walks the
per-video endpoint at a polite rate. Results append to a JSONL cache, so an
interrupted run resumes instead of starting over.

Usage:
    python3 scripts/fetch_bilibili_meta.py
"""
import json
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache/bilibili_meta.jsonl"
OUT = ROOT / "mapping_index/track_meta.csv"
API = "https://api.bilibili.com/x/web-interface/view?bvid="
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
DELAY = 0.34          # ~3 req/s
COOLDOWN = 45.0       # on rate-limit


def load_cache():
    seen = {}
    if CACHE.exists():
        for line in CACHE.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            seen[rec["bv_id"]] = rec
    return seen


def fetch(bv):
    req = urllib.request.Request(API + bv, headers={
        "User-Agent": UA, "Referer": "https://www.bilibili.com/",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.load(resp)


def main():
    stars = pd.read_csv(ROOT / "mapping_index/mapping_index_enriched.csv")
    wanted = sorted(set(stars.bv_id))
    CACHE.parent.mkdir(exist_ok=True)

    seen = load_cache()
    todo = [b for b in wanted if b not in seen]
    print(f"{len(wanted)} unique videos, {len(seen)} cached, {len(todo)} to fetch", flush=True)

    fails = 0
    with CACHE.open("a", encoding="utf-8") as sink:
        for n, bv in enumerate(todo, 1):
            rec = {"bv_id": bv}
            try:
                payload = fetch(bv)
                code = payload.get("code")
                if code == 0:
                    d = payload["data"]
                    owner = d.get("owner") or {}
                    rec.update(pic=d.get("pic") or "", author=owner.get("name") or "",
                               mid=owner.get("mid"), duration=d.get("duration"),
                               ok=True)
                elif code == -412:                       # rate limited
                    print(f"  rate limited at {n}, cooling down", flush=True)
                    time.sleep(COOLDOWN)
                    continue
                else:
                    rec.update(ok=False, error=f"code {code}: {payload.get('message')}")
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                rec.update(ok=False, error=str(exc))
                fails += 1
                if fails % 20 == 0:
                    time.sleep(10)

            sink.write(json.dumps(rec, ensure_ascii=False) + "\n")
            sink.flush()
            if n % 250 == 0:
                got = sum(1 for r in load_cache().values() if r.get("ok"))
                print(f"  {n}/{len(todo)} fetched, {got} usable so far", flush=True)
            time.sleep(DELAY + random.uniform(0, 0.12))

    seen = load_cache()
    rows = [r for r in seen.values() if r.get("ok")]
    frame = pd.DataFrame(rows)[["bv_id", "pic", "author", "mid"]]
    # https keeps the browser from blocking the image on a secure page
    frame["pic"] = frame.pic.str.replace("^http://", "https://", regex=True)
    frame.to_csv(OUT, index=False)

    missing = [b for b in wanted if b not in {r["bv_id"] for r in rows}]
    print(f"\nwrote {OUT.name}: {len(frame)} rows")
    print(f"  with cover  {int((frame.pic != '').sum())}")
    print(f"  with author {int((frame.author != '').sum())}")
    print(f"  unresolved  {len(missing)}")
    if missing[:5]:
        print("  e.g. " + ", ".join(missing[:5]))


if __name__ == "__main__":
    main()
