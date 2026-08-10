#!/usr/bin/env python3
"""Enrich the video-to-star mapping with real Tycho-2 astrometry and Hipparcos parallax.

Upstream CSV only carries the first two components of the equatorial unit vector, so the
z component is recovered here from catalogue declination. The upstream `dist` column is
Tycho-2 `prox` (angular separation to the nearest neighbour) and is passed through
unchanged under a name that reflects that.

Usage:
    python3 scripts/enrich_star_positions.py [input.csv] [output.csv]
"""
import io
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
TAP = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync"
PC_TO_LY = 3.261563777
VT_LIMIT = 7.0  # upstream star set is naked-eye bright; one bulk pull covers it

TYC2_COLS = (
    'TYC1,TYC2,TYC3,RAmdeg,DEmdeg,"RA(ICRS)" AS RAobs,"DE(ICRS)" AS DEobs,'
    "VTmag,BTmag,pmRA,pmDE,prox,HIP"
)


def tap_query(adql, tries=6):
    body = urllib.parse.urlencode(
        {"request": "doQuery", "lang": "ADQL", "format": "csv",
         "maxrec": "300000", "query": adql}
    ).encode()
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(TAP, data=body)
            with urllib.request.urlopen(req, timeout=300) as resp:
                return pd.read_csv(io.StringIO(resp.read().decode()))
        except Exception as exc:  # transient TLS/5xx from the archive
            last = exc
            print(f"  retry {attempt + 1}/{tries}: {exc}", file=sys.stderr)
            time.sleep(8)
    raise RuntimeError(f"TAP query failed: {last}")


def cached(name, build):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / name
    if path.exists():
        return pd.read_csv(path)
    frame = build()
    frame.to_csv(path, index=False)
    return frame


def split_tyc(series):
    parts = series.str.extract(r"^TYC\s+(\d+)-(\d+)-(\d+)$")
    if parts.isna().any().any():
        bad = series[parts.isna().any(axis=1)].head().tolist()
        raise ValueError(f"unparsable tyc2_id: {bad}")
    return parts.astype(int).set_axis(["tyc1", "tyc2", "tyc3"], axis=1)


def fetch_positions():
    return cached(
        "tyc2_bright.csv",
        lambda: tap_query(f'SELECT {TYC2_COLS} FROM "I/259/tyc2" WHERE VTmag < {VT_LIMIT}'),
    )


def fetch_parallax(hip_ids):
    ids = sorted({int(h) for h in hip_ids if pd.notna(h)})

    def build():
        chunks = []
        for start in range(0, len(ids), 800):
            batch = ",".join(str(i) for i in ids[start:start + 800])
            chunks.append(tap_query(
                f'SELECT HIP,Plx,e_Plx FROM "I/311/hip2" WHERE HIP IN ({batch})'))
        return pd.concat(chunks, ignore_index=True).drop_duplicates("HIP")

    return cached("hip2_parallax.csv", build)


def enrich(src):
    keys = split_tyc(src.tyc2_id)
    src = pd.concat([src, keys], axis=1)
    src["join_key"] = (src.tyc1.astype(str) + "-" + src.tyc2.astype(str)
                       + "-" + src.tyc3.astype(str))

    cat = fetch_positions()
    cat["join_key"] = (cat.TYC1.astype(str) + "-" + cat.TYC2.astype(str)
                       + "-" + cat.TYC3.astype(str))
    cat = cat.drop_duplicates("join_key")

    df = src.merge(cat, on="join_key", how="left")
    unmatched = df.RAmdeg.isna() & df.RAobs.isna()
    if unmatched.any():
        raise RuntimeError(f"{int(unmatched.sum())} stars absent from Tycho-2 "
                           f"(raise VT_LIMIT={VT_LIMIT})")

    # mean position is blank for a minority of entries; fall back to the observed one
    ra = df.RAmdeg.fillna(df.RAobs)
    de = df.DEmdeg.fillna(df.DEobs)
    ra_rad, de_rad = np.radians(ra), np.radians(de)
    ux = np.cos(de_rad) * np.cos(ra_rad)
    uy = np.cos(de_rad) * np.sin(ra_rad)
    uz = np.sin(de_rad)

    plx = fetch_parallax(df.HIP)
    df = df.merge(plx, on="HIP", how="left")
    positive = df.Plx > 0
    dist_pc = pd.Series(np.where(positive, 1000.0 / df.Plx.where(positive), np.nan))
    dist_ly = dist_pc * PC_TO_LY
    rel_err = df.e_Plx / df.Plx.where(positive)
    quality = np.where(df.Plx.isna() | ~positive, "none",
                       np.where(rel_err < 0.2, "good", "poor"))

    page = src.bv_id.str.extract(r"_p(\d+)$")[0]
    out = pd.DataFrame({
        "bv_id": src.bv_id.str.replace(r"_p\d+$", "", regex=True),
        "page": page.fillna(1).astype(int),
        "tyc2_id": src.tyc2_id,
        "label": src.label.astype("Int64"),

        "ra_deg": ra.round(8),
        "de_deg": de.round(8),
        "x": ux.round(9),
        "y": uy.round(9),
        "z": uz.round(9),

        "vt_mag": df.VTmag,
        "bt_mag": df.BTmag,
        "bv_color": (df.BTmag - df.VTmag).round(4),

        "hip": df.HIP.astype("Int64"),
        "plx_mas": df.Plx,
        "e_plx_mas": df.e_Plx,
        "dist_pc": dist_pc.round(3),
        "dist_ly": dist_ly.round(3),
        "dist_quality": quality,
        "px_ly": (ux * dist_ly).round(4),
        "py_ly": (uy * dist_ly).round(4),
        "pz_ly": (uz * dist_ly).round(4),

        "uid": src.uid.astype("Int64"),
        "date": src.date,
        "n_view": src.n_view.astype("Int64"),
        "link": src.link,

        "src_x": src.x,
        "src_y": src.y,
        "src_prox": df.prox.astype("Int64"),
    })
    out = attach_track_metadata(out)
    return out, ra, de, ux, uy, df


def attach_track_metadata(out):
    """Pull title/part/cid from the MERT feature table, which also carries the
    authoritative uid/date/n_view (the mapping CSV has three blank rows)."""
    path = ROOT / "mert_features/features.parquet"
    if not path.exists():
        return out
    meta = pd.read_parquet(path, columns=["bv_id", "page", "cid", "uid", "date",
                                          "n_view", "title", "part", "token_row"])
    merged = out.merge(meta, on=["bv_id", "page"], how="left", suffixes=("", "_m"))
    merged["uid"] = pd.to_numeric(merged.uid_m, errors="coerce").astype("Int64").fillna(merged.uid)
    merged["n_view"] = pd.to_numeric(merged.n_view_m, errors="coerce").astype("Int64").fillna(merged.n_view)
    merged["date"] = merged.date_m.fillna(merged.date)
    merged["cid"] = merged.cid.astype("Int64")
    merged["token_row"] = merged.token_row.astype("Int64")
    return merged.drop(columns=["uid_m", "n_view_m", "date_m"])


def main():
    inp = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "mapping_index/mapping_index..csv"
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "mapping_index/mapping_index_enriched.csv"

    # round_trip: the default parser is off by an ULP on 16-digit uid values
    src = pd.read_csv(inp, float_precision="round_trip")
    print(f"input  {inp.name}: {len(src)} rows")
    out, ra, de, ux, uy, df = enrich(src)
    out.to_csv(dst, index=False)
    print(f"output {dst.name}: {len(out)} rows, {len(out.columns)} cols")

    # verification: the upstream x,y must reproduce as the equatorial unit vector
    # scaled by a single isotropic constant, and prox must reproduce `dist`
    scale = float(np.nanmedian(pd.concat([ux / src.x, uy / src.y])))
    resid = np.hypot(src.x * scale - ux, src.y * scale - uy)
    prox = df.prox.astype(float)
    lo, span = prox.min(), prox.max() - prox.min()
    prox_err = np.abs(src.dist - (2 * (prox - lo) / span - 1)).max()
    print(f"  isotropic scale R = {scale:.8f}, xy residual max = {np.nanmax(resid):.2e}")
    print(f"  src dist == normalised prox, max error = {prox_err:.2e}")
    print(f"  parallax: good {int((out.dist_quality == 'good').sum())}, "
          f"poor {int((out.dist_quality == 'poor').sum())}, "
          f"none {int((out.dist_quality == 'none').sum())}")
    print(f"  distance ly: p5={out.dist_ly.quantile(.05):.0f} "
          f"median={out.dist_ly.median():.0f} p95={out.dist_ly.quantile(.95):.0f}")


if __name__ == "__main__":
    main()
