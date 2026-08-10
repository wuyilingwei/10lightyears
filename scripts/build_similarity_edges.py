#!/usr/bin/env python3
"""Build the k-nearest-neighbour graph that links stylistically close tracks.

Cosine similarity on the MERT CLS tokens, after subtracting the corpus mean.
Raw CLS tokens share a large common component that pushes every pair into
0.68-0.89, which leaves nothing for the renderer to modulate; centring restores
a usable spread without changing retrieval quality.

Usage:
    python3 scripts/build_similarity_edges.py [k]
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "mert_features/cls_tokens_fp16.npy"
ENRICHED = ROOT / "mapping_index/mapping_index_enriched.csv"
OUT_EDGES = ROOT / "mapping_index/similarity_edges.csv"
DEFAULT_K = 4


def main():
    k = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_K
    nodes = pd.read_csv(ENRICHED, float_precision="round_trip")
    rows = nodes.token_row.to_numpy()

    vectors = np.load(TOKENS).astype(np.float32)[rows]
    vectors -= vectors.mean(axis=0)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)

    # Accelerate leaves stale FP flags set, so matmul reports overflow on inputs
    # that are finite and unit-norm; the products themselves are exact
    with np.errstate(all="ignore"):
        sim = vectors @ vectors.T
    np.fill_diagonal(sim, -np.inf)
    top = np.argpartition(-sim, k, axis=1)[:, :k]
    order = np.take_along_axis(sim, top, 1).argsort(axis=1)[:, ::-1]
    top = np.take_along_axis(top, order, 1)

    src = np.repeat(np.arange(len(rows)), k)
    dst = top.ravel()
    edges = pd.DataFrame({
        "src": src,
        "dst": dst,
        "similarity": sim[src, dst].round(5),
        "rank": np.tile(np.arange(1, k + 1), len(rows)),
    })

    # collapse to undirected: keep one row per pair, at its best rank
    lo = np.minimum(edges.src, edges.dst)
    hi = np.maximum(edges.src, edges.dst)
    edges["pair"] = lo * len(rows) + hi
    edges = (edges.sort_values(["pair", "rank"])
                  .drop_duplicates("pair", keep="first")
                  .drop(columns="pair"))
    edges["src"], edges["dst"] = lo.loc[edges.index], hi.loc[edges.index]

    key = nodes[["bv_id", "page", "token_row"]].reset_index(drop=True)
    out = edges.reset_index(drop=True)
    for side in ("src", "dst"):
        joined = key.iloc[out[side].to_numpy()].reset_index(drop=True)
        out[f"{side}_bv_id"] = joined.bv_id
        out[f"{side}_page"] = joined.page
    out = out[["src", "dst", "src_bv_id", "src_page", "dst_bv_id", "dst_page",
               "similarity", "rank"]]
    out.to_csv(OUT_EDGES, index=False)

    degree = np.bincount(np.concatenate([out.src, out.dst]), minlength=len(rows))
    reciprocal = int((pd.Series(list(zip(edges.src, edges.dst))).duplicated()).sum())
    print(f"nodes {len(rows)}, k={k} -> {len(out)} undirected edges")
    print(f"  similarity: min={out.similarity.min():.3f} "
          f"median={out.similarity.median():.3f} max={out.similarity.max():.3f}")
    print(f"  degree: min={degree.min()} median={int(np.median(degree))} max={degree.max()}")
    print(f"  isolated nodes: {int((degree == 0).sum())}, mutual pairs merged: {reciprocal}")
    print(f"  wrote {OUT_EDGES.name}")


if __name__ == "__main__":
    main()
