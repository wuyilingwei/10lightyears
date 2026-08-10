#!/usr/bin/env python3
"""Pack the enriched mapping into the binary + JSON payload the viewer loads.

Numerics go out as typed arrays so the renderer can upload them straight to the
GPU; only the text metadata stays as JSON.

Usage:
    python3 scripts/export_web_data.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web/data"
STARS_PER_RECORD = 6  # gx, gy, gz (ly), vt_mag, sp_axis, lum_code
LUMINOSITY_CODE = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6}
CDN = "https://i0.hdslb.com/"
# 60% of the corpus is A/B/K; without a real type fall back to mid-F (white)
SP_FALLBACK = 3.5


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    stars = pd.read_csv(ROOT / "mapping_index/mapping_index_enriched.csv",
                        float_precision="round_trip")
    edges = pd.read_csv(ROOT / "mapping_index/similarity_edges.csv")

    packed = np.empty((len(stars), STARS_PER_RECORD), dtype=np.float32)
    packed[:, 0] = stars.gx_ly
    packed[:, 1] = stars.gy_ly
    packed[:, 2] = stars.gz_ly
    packed[:, 3] = stars.vt_mag
    packed[:, 4] = stars.sp_axis.fillna(SP_FALLBACK)
    packed[:, 5] = stars.lum_class.fillna("").map(LUMINOSITY_CODE).fillna(0)
    packed.tofile(OUT / "stars.bin")

    if len(stars) > np.iinfo(np.uint16).max:
        raise RuntimeError("star count exceeds uint16 edge indices")
    pairs = np.empty((len(edges), 2), dtype=np.uint16)
    pairs[:, 0] = edges.src
    pairs[:, 1] = edges.dst
    pairs.tofile(OUT / "edges.bin")
    np.asarray(edges.similarity, dtype=np.float32).tofile(OUT / "edge_weights.bin")

    # covers all live on one CDN; store the path and rebuild the URL client-side
    cover = (stars.get("cover", pd.Series([""] * len(stars))).fillna("")
             .str.replace(r"^https?://[^/]+/", "", regex=True))
    author = stars.get("author", pd.Series([""] * len(stars))).fillna("")
    sp = stars.sp_type.fillna("")

    tracks = [
        {"t": t, "b": b, "p": int(p), "u": str(u), "d": d, "v": int(v),
         "s": s, "l": round(float(ly), 1), "m": round(float(m), 2),
         "a": a, "c": c, "y": y, "i": int(cid)}
        for t, b, p, u, d, v, s, ly, m, a, c, y, cid in zip(
            stars.title, stars.bv_id, stars.page, stars.uid, stars.date,
            stars.n_view, stars.tyc2_id, stars.dist_ly, stars.vt_mag,
            author, cover, sp, stars.cid)
    ]
    manifest = {
        "count": len(stars),
        "edges": len(edges),
        "frame": "galactic",
        "unit": "ly",
        "extent": round(float(np.abs(packed[:, :3]).max()), 1),
        "mag_range": [round(float(stars.vt_mag.min()), 3),
                      round(float(stars.vt_mag.max()), 3)],
        "dist_range": [round(float(stars.dist_ly.min()), 1),
                       round(float(stars.dist_ly.max()), 1)],
        "cdn": CDN,
        "covers": int((cover != "").sum()),
        "authors": int((author != "").sum()),
        "tracks": tracks,
    }
    (OUT / "tracks.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    for name in ("stars.bin", "edges.bin", "edge_weights.bin", "tracks.json"):
        print(f"  {name:18s} {(OUT / name).stat().st_size / 1024:8.1f} KB")
    print(f"stars {len(stars)}, edges {len(edges)}, extent {manifest['extent']} ly")


if __name__ == "__main__":
    main()
