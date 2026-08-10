# 十光年的距离

星尘十周年生贺企划的星图数据集。将历年 5850 首曲目一一映射到第谷星表（Tycho-2）中的
真实恒星，供 3D 星图前端使用。

## 数据

| 路径 | 说明 |
| --- | --- |
| `mapping_index/mapping_index_enriched.csv` | 主数据集。真实赤道与银道坐标、视差距离、测光、曲名与聚类簇 |
| `mapping_index/similarity_edges.csv` | 曲风近邻图，18998 条无向边 |
| `mapping_index/mapping_index..csv` | 上游原始映射（5850 行） |
| `mapping_index/mapping_index.csv` | 早期 42 行小样本，另一次独立映射 |
| `mert_features/features.parquet` | 曲目元数据与 768 维音频特征 |
| `mert_features/cls_tokens_fp16.npy` | 同上特征的矩阵形式，`(5850, 768)` fp16，行序对应 `token_row` |
| `stage_script.py` | 上游特征提取脚本 |

### 主数据集字段

- `x, y, z` — 赤道坐标系（ICRS J2000）单位向量，可直接用作球面方向
- `gx, gy, gz` / `gl_deg, gb_deg` — 银道坐标系单位向量与银经银纬
- `px_ly, py_ly, pz_ly` — 以太阳为原点、单位光年的真实三维坐标（赤道系）
- `gx_ly, gy_ly, gz_ly` — 同上，银道系。星图用这一组，银盘落在 XY 平面
- `dist_ly` / `dist_pc` / `dist_quality` — 由 Hipparcos 视差换算的距离。
  `good` 表示视差相对误差 <20%（5500 行），`poor` 314 行，`none` 33 行。
  低信噪比视差直接取倒数会得到非物理距离（最坏一颗落在 326000 光年），
  故距离取指数递减空间密度先验下的后验众数（Bailer-Jones 2015），
  `good` 星的中位改动仅 0.06%，而最远值收敛到 4144 光年。
  `dist_ly_naive` 保留未正则化的 1/视差以便对照
- `vt_mag, bt_mag, bv_color` — Tycho-2 测光，用于亮度与色温
- `label` — 上游 KNN 聚类簇号
- `token_row` — 对应 `cls_tokens_fp16.npy` 的行下标

数据集为 5847 行：上游 5850 条中有 3 条从未抓到 UP 主、投稿日期与播放量，已剔除。
- `src_x, src_y, src_prox` — 上游原始列，仅作追溯

上游 CSV 的 `dist` 列既不是距离也不是视星等，而是 Tycho-2 的 `prox`
（最近邻角距，单位 0.1 角秒，999 表示孤立）。该列在主数据集中更名为 `src_prox`，
无天文用途。

## 重建

```bash
python3 scripts/enrich_star_positions.py    # 星表增补，VizieR 结果缓存在 .cache/
python3 scripts/build_similarity_edges.py   # 曲风近邻连线
python3 scripts/export_web_data.py          # 打包 web/data/ 前端载荷
```

`web/data/*.bin` 与 `wrangler.jsonc` 不随仓库分发，克隆后跑一遍上面三条即可生成前端数据。

## 星图

`web/` 是三维星图前端，纯静态，无构建步骤。本地预览：

```bash
python3 -m http.server 8000 --directory web
```

- 恒星按真实银道坐标摆放，不做径向压缩，因此银盘的扁平结构（|b|<10° 富集 1.53 倍）
  在拉远时可以直接看到
- 点的颜色取自 B-V 色指数，大小取自视星等
- 连线是 MERT 音频特征的 k 近邻，选中恒星时点亮

## 数据来源

- Tycho-2 `I/259/tyc2` — Høg et al. 2000
- Hipparcos new reduction `I/311/hip2` — van Leeuwen 2007
- 音频特征由 `m-a-p/MERT-v1-95M` 提取
