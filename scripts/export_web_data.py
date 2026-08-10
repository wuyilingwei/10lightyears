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
STARS_PER_RECORD = 6  # gx, gy, gz (ly), vt_mag, bv_color, label


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
    packed[:, 4] = stars.bv_color.fillna(0.0)
    packed[:, 5] = stars.label
    packed.tofile(OUT / "stars.bin")

    if len(stars) > np.iinfo(np.uint16).max:
        raise RuntimeError("star count exceeds uint16 edge indices")
    pairs = np.empty((len(edges), 2), dtype=np.uint16)
    pairs[:, 0] = edges.src
    pairs[:, 1] = edges.dst
    pairs.tofile(OUT / "edges.bin")
    np.asarray(edges.similarity, dtype=np.float32).tofile(OUT / "edge_weights.bin")

    tracks = [
        {"t": t, "b": b, "p": int(p), "u": str(u), "d": d, "v": int(v),
         "s": s, "l": round(float(ly), 1), "m": round(float(m), 2)}
        for t, b, p, u, d, v, s, ly, m in zip(
            stars.title, stars.bv_id, stars.page, stars.uid, stars.date,
            stars.n_view, stars.tyc2_id, stars.dist_ly, stars.vt_mag)
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
