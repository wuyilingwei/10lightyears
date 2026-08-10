# 十光年的距离

星尘十周年生贺企划的星图数据集。将历年 5850 首曲目一一映射到第谷星表（Tycho-2）中的
真实恒星，供 3D 星图前端使用。

## 数据

| 路径 | 说明 |
| --- | --- |
| `mapping_index/mapping_index_enriched.csv` | 主数据集。真实赤道坐标 xyz、视差距离、测光、曲名与聚类簇 |
| `mapping_index/mapping_index..csv` | 上游原始映射（5850 行） |
| `mapping_index/mapping_index.csv` | 早期 42 行小样本，另一次独立映射 |
| `mert_features/features.parquet` | 曲目元数据与 768 维音频特征 |
| `mert_features/cls_tokens_fp16.npy` | 同上特征的矩阵形式，`(5850, 768)` fp16，行序对应 `token_row` |
| `stage_script.py` | 上游特征提取脚本 |

### 主数据集字段

- `x, y, z` — 赤道坐标系（ICRS J2000）单位向量，可直接用作球面方向
- `px_ly, py_ly, pz_ly` — 以太阳为原点、单位光年的真实三维坐标
- `dist_ly` / `dist_pc` / `dist_quality` — 由 Hipparcos 视差换算的距离；
  `good` 表示视差相对误差 <20%（5503 行），`poor` 314 行，`none` 33 行
- `vt_mag, bt_mag, bv_color` — Tycho-2 测光，用于亮度与色温
- `label` — 曲风 KNN 聚类簇号，同簇曲目之间连线
- `token_row` — 对应 `cls_tokens_fp16.npy` 的行下标
- `src_x, src_y, src_prox` — 上游原始列，仅作追溯

上游 CSV 的 `dist` 列既不是距离也不是视星等，而是 Tycho-2 的 `prox`
（最近邻角距，单位 0.1 角秒，999 表示孤立）。该列在主数据集中更名为 `src_prox`，
无天文用途。

## 重建

```bash
python3 scripts/enrich_star_positions.py
```

从 VizieR 拉取 Tycho-2 位置测光与 Hipparcos 视差，结果缓存在 `.cache/`。

## 数据来源

- Tycho-2 `I/259/tyc2` — Høg et al. 2000
- Hipparcos new reduction `I/311/hip2` — van Leeuwen 2007
- 音频特征由 `m-a-p/MERT-v1-95M` 提取
