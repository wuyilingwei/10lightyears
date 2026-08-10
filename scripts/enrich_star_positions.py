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

# Exponentially-decreasing-space-density prior (Bailer-Jones 2015). Inverting a
# low signal-to-noise parallax yields non-physical distances -- the worst entry
# here lands at 326000 ly -- so distances come from the posterior mode instead.
# The scale is fitted to the well-measured subset by fit_prior_length().
EDSD_FALLBACK_PC = 200.0

# ICRS -> Galactic rotation (ESA 1997). Puts the disc in the XY plane, which is
# what makes the rendered field read as the Milky Way rather than a tilted band.
ICRS_TO_GALACTIC = np.array([
    [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
    [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
    [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
])

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


# Spectral sequence as a continuous axis: class index + subclass/10, so B9.5
# sits just short of A0. The viewer interpolates its colour ramp along this.
SPECTRAL_ORDER = "OBAFGKM"
SPECTRAL_RE = re.compile(r"([OBAFGKM])\s*(\d(?:\.\d)?)?")
# Longest alternative first so IV/VI/III win over I and V. No \b: in "K0III"
# the digit and the numeral are both word characters, so there is no boundary
# between them. Trailing guard is uppercase-only to keep "Iab", "IIIa" etc.
LUMINOSITY_RE = re.compile(r"(?<![A-Z])(VI|IV|III|II|I|V)(?![A-Z])")


def parse_spectral(sp):
    """-> (position on the O..M axis, luminosity class) ; NaN/'' when unparsable."""
    if not isinstance(sp, str) or not sp.strip():
        return np.nan, ""
    m = SPECTRAL_RE.search(sp)
    if not m:
        return np.nan, ""          # W/C/S/N and other exotics fall through
    letter = m.group(1).upper()
    sub = float(m.group(2)) if m.group(2) else 5.0
    lum = LUMINOSITY_RE.search(sp, m.end())
    return SPECTRAL_ORDER.index(letter) + sub / 10.0, lum.group(1) if lum else ""


def fetch_spectral_types(hip_ids):
    ids = sorted({int(h) for h in hip_ids if pd.notna(h)})

    def build():
        chunks = []
        for start in range(0, len(ids), 900):
            batch = ",".join(str(i) for i in ids[start:start + 900])
            chunks.append(tap_query(
                f'SELECT HIP,SpType FROM "I/239/hip_main" WHERE HIP IN ({batch})'))
        return pd.concat(chunks, ignore_index=True).drop_duplicates("HIP")

    return cached("hip_sptype.csv", build)


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


def fit_prior_length(dist_pc, quality):
    """Scale the prior so its mode (at 2L) sits on the mode of the trustworthy
    distances, leaving well-measured stars essentially untouched."""
    good = dist_pc[(quality == "good") & dist_pc.notna() & (dist_pc > 0)]
    if len(good) < 100:
        return EDSD_FALLBACK_PC
    counts, edges = np.histogram(np.log10(good), bins=40)
    peak = 10 ** ((edges[counts.argmax()] + edges[counts.argmax() + 1]) / 2)
    return float(peak / 2)


def edsd_distance(plx_mas, e_plx_mas, length_pc):
    """Posterior mode of r under the EDSD prior, in parsec.

    Root of  r^3/L - 2r^2 + (w/s^2) r - 1/s^2 = 0  with w, s in arcsec.
    Where the parallax is informative this returns 1/w; where it is not, it
    decays to the prior mode instead of diverging.
    """
    out = np.full(len(plx_mas), np.nan)
    w = plx_mas.to_numpy(dtype=float) / 1000.0
    s = e_plx_mas.to_numpy(dtype=float) / 1000.0
    usable = np.isfinite(w) & np.isfinite(s) & (s > 0)
    for i in np.flatnonzero(usable):
        coeffs = [1.0 / length_pc, -2.0, w[i] / s[i] ** 2, -1.0 / s[i] ** 2]
        roots = np.roots(coeffs)
        real = roots[np.abs(roots.imag) < 1e-8].real
        real = real[real > 0]
        if real.size == 0:
            continue
        # two positive roots occur only for informative parallaxes; the smaller
        # one is the mode, the larger is a spurious tail solution
        out[i] = real.min() if w[i] > 0 else real.max()
    return pd.Series(out, index=plx_mas.index)


def to_galactic(ux, uy, uz):
    # Accelerate leaves stale FP flags set; the rotation itself is exact
    with np.errstate(all="ignore"):
        gx, gy, gz = ICRS_TO_GALACTIC @ np.vstack([ux, uy, uz])
    lon = np.degrees(np.arctan2(gy, gx)) % 360.0
    lat = np.degrees(np.arcsin(np.clip(gz, -1.0, 1.0)))
    return gx, gy, gz, lon, lat


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
    naive_pc = pd.Series(np.where(positive, 1000.0 / df.Plx.where(positive), np.nan))
    rel_err = df.e_Plx / df.Plx.where(positive)
    quality = pd.Series(np.where(df.Plx.isna() | ~positive, "none",
                                 np.where(rel_err < 0.2, "good", "poor")))

    length_pc = fit_prior_length(naive_pc, quality)
    dist_pc = edsd_distance(df.Plx, df.e_Plx, length_pc)
    # stars with no parallax at all still need a position: use the prior mode
    dist_pc = dist_pc.fillna(2 * length_pc)
    dist_ly = dist_pc * PC_TO_LY
    print(f"  prior length L = {length_pc:.1f} pc (mode {2 * length_pc * PC_TO_LY:.0f} ly)")

    spec = fetch_spectral_types(df.HIP)
    df = df.merge(spec, on="HIP", how="left")
    parsed = [parse_spectral(s) for s in df.SpType]
    spec_axis = pd.Series([p[0] for p in parsed])
    lum_class = pd.Series([p[1] for p in parsed])
    print(f"  spectral types: {int(df.SpType.notna().sum())} fetched, "
          f"{int(spec_axis.notna().sum())} on the OBAFGKM axis, "
          f"{int((lum_class != '').sum())} with a luminosity class")

    gx, gy, gz, gl, gb = to_galactic(ux, uy, uz)

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
        "sp_type": df.SpType,
        "sp_axis": spec_axis.round(3),
        "lum_class": lum_class,

        "gl_deg": gl.round(6),
        "gb_deg": gb.round(6),
        "gx": gx.round(9),
        "gy": gy.round(9),
        "gz": gz.round(9),

        "hip": df.HIP.astype("Int64"),
        "plx_mas": df.Plx,
        "e_plx_mas": df.e_Plx,
        "dist_pc": dist_pc.round(3),
        "dist_ly": dist_ly.round(3),
        "dist_ly_naive": (naive_pc * PC_TO_LY).round(3),
        "dist_quality": quality,
        "px_ly": (ux * dist_ly).round(4),
        "py_ly": (uy * dist_ly).round(4),
        "pz_ly": (uz * dist_ly).round(4),
        "gx_ly": (gx * dist_ly).round(4),
        "gy_ly": (gy * dist_ly).round(4),
        "gz_ly": (gz * dist_ly).round(4),

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


def attach_author_and_cover(out):
    """Join the Bilibili scrape, if it has been run. Optional so the pipeline
    still produces a dataset on a fresh clone."""
    path = ROOT / "mapping_index/track_meta.csv"
    if not path.exists():
        print("  no track_meta.csv yet; author/cover columns left blank")
        out["author"] = ""
        out["cover"] = ""
        return out
    meta = pd.read_csv(path).drop_duplicates("bv_id")
    merged = out.merge(meta[["bv_id", "author", "pic"]], on="bv_id", how="left")
    merged["author"] = merged.author.fillna("")
    merged["cover"] = merged.pic.fillna("")
    print(f"  author on {int((merged.author != '').sum())} rows, "
          f"cover on {int((merged.cover != '').sum())} rows")
    return merged.drop(columns=["pic"])


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
    merged = merged.drop(columns=["uid_m", "n_view_m", "date_m"])

    # a handful of tracks were never scraped upstream; they carry no author,
    # date or view count in either source and are dropped rather than rendered
    merged = attach_author_and_cover(merged)

    incomplete = merged[["uid", "date", "n_view"]].isna().any(axis=1)
    if incomplete.any():
        print(f"  dropping {int(incomplete.sum())} tracks with no author/date/views: "
              + ", ".join(merged.bv_id[incomplete]))
    return merged[~incomplete].reset_index(drop=True)


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
