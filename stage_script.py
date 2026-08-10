#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import numpy as np
import pandas as pd


MODEL_NAME = "m-a-p/MERT-v1-95M"
DEFAULT_INPUT_ROOT = Path("/kaggle/input")
DEFAULT_WORK_ROOT = Path("/kaggle/working")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def kaggle_command() -> list[str]:
    executable = shutil.which("kaggle")
    return [executable] if executable else [sys.executable, "-m", "kaggle"]


def read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def find_raw_archives(input_root: Path) -> list[Path]:
    candidates = sorted(input_root.glob("**/fav_*.tar.gz"))
    return candidates


def extract_archive(archive_path: Path, extract_dir: Path) -> None:
    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    extract_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as tar:
        tar.extractall(extract_dir)


def find_expanded_raw_dirs(input_root: Path) -> list[Path]:
    raw_dirs: list[Path] = []
    manifests = sorted(input_root.glob("**/valid_manifest.jsonl"))
    for manifest in manifests:
        parent = manifest.parent
        try:
            rows = read_jsonl(manifest)
        except Exception:
            continue
        if not rows:
            continue
        first = rows[0]
        audio = parent / str(first.get("audio_filename", ""))
        html = parent / str(first.get("html_filename", ""))
        if audio.exists() and html.exists():
            raw_dirs.append(parent)
    return raw_dirs


def collect_raw_inputs(input_root: Path, work_root: Path) -> list[Path]:
    raw_dirs: list[Path] = []
    archives = find_raw_archives(input_root)
    for index, archive in enumerate(archives, 1):
        extract_dir = work_root / f"raw_extract_{index:03d}"
        extract_archive(archive, extract_dir)
        raw_dirs.append(extract_dir)
    raw_dirs.extend(find_expanded_raw_dirs(input_root))
    unique: list[Path] = []
    seen: set[str] = set()
    for raw_dir in raw_dirs:
        key = str(raw_dir.resolve())
        if key not in seen:
            seen.add(key)
            unique.append(raw_dir)
    if not unique:
        raise FileNotFoundError(f"no raw dataset with valid_manifest.jsonl found under {input_root}")
    return unique


def ffprobe_duration(path: Path) -> float | None:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        result = subprocess.run(cmd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return float(result.stdout.strip())
    except Exception:
        return None


def load_audio_ffmpeg(path: Path, sample_rate: int, clip_seconds: float, rng: random.Random) -> np.ndarray:
    duration = ffprobe_duration(path)
    offset = 0.0
    if duration and duration > clip_seconds:
        offset = rng.uniform(0.0, max(0.0, duration - clip_seconds))
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-ss",
        f"{offset:.3f}",
        "-i",
        str(path),
        "-t",
        f"{clip_seconds:.3f}",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    result = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    audio = np.frombuffer(result.stdout, dtype=np.float32)
    if audio.size == 0:
        raise RuntimeError("ffmpeg decoded zero samples")
    return audio


def re_search(patterns: list[str], text: str) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, re.S)
        if match:
            return match.group(1)
    return ""


def parse_html_metadata(html_path: Path, bvid: str, cid: int, page: int) -> dict:
    text = html_path.read_text(encoding="utf-8", errors="replace")
    uid = re_search(
        [
            r'"owner"\s*:\s*\{[^{}]*"mid"\s*:\s*(\d+)',
            r'"mid"\s*:\s*(\d+)[^{}]*"name"',
            r"space\.bilibili\.com/(\d+)",
        ],
        text,
    )
    pub_ts = re_search([r'"pubdate"\s*:\s*(\d+)', r'"ctime"\s*:\s*(\d+)'], text)
    date = ""
    if pub_ts:
        try:
            date = time.strftime("%Y-%m-%d", time.localtime(int(pub_ts)))
        except Exception:
            date = ""
    if not date:
        date = re_search([r'"datePublished"\s*:\s*"([^"]+)"', r'"uploadDate"\s*:\s*"([^"]+)"'], text)[:10]
    n_view = re_search([r'"view"\s*:\s*(\d+)', r'"play"\s*:\s*(\d+)'], text)
    aid = re_search([r'"aid"\s*:\s*(\d+)', r'"aid"\s*:\s*"(\d+)"'], text)
    params = ["isOutside=true"]
    if aid:
        params.append(f"aid={aid}")
    params.extend([f"bvid={bvid}", f"cid={cid}", f"p={page}"])
    link = "//player.bilibili.com/player.html?" + "&".join(params)
    return {"uid": uid, "date": date, "n_view": n_view, "link": link}


def import_mert(allow_cpu_fallback: bool):
    import torch
    from transformers import AutoModel, Wav2Vec2FeatureExtractor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        capability = torch.cuda.get_device_capability(0)
        if capability[0] < 7:
            message = (
                f"GPU {torch.cuda.get_device_name(0)} has CUDA capability {capability}; "
                "current Kaggle PyTorch build requires sm_70+"
            )
            if allow_cpu_fallback:
                print(f"[mert] {message}; using CPU fallback for this run")
                device = "cpu"
            else:
                raise RuntimeError(message)
    elif not allow_cpu_fallback:
        raise RuntimeError("Kaggle GPU is required; torch.cuda.is_available() is false")
    processor = Wav2Vec2FeatureExtractor.from_pretrained(MODEL_NAME, trust_remote_code=True)
    model = AutoModel.from_pretrained(MODEL_NAME, trust_remote_code=True).to(device)
    model.eval()
    return torch, processor, model, device


def extract_cls_token(torch, processor, model, device: str, audio: np.ndarray) -> np.ndarray:
    inputs = processor(audio, sampling_rate=processor.sampling_rate, return_tensors="pt")
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.no_grad():
        outputs = model(**inputs, output_hidden_states=True)
    last_hidden = outputs.hidden_states[-1]
    cls_like = last_hidden[:, 0, :].detach().cpu().numpy()[0]
    return cls_like.astype(np.float16)


def write_features_parquet(rows: list[dict], vectors: np.ndarray, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    np.save(output_dir / "cls_tokens_fp16.npy", vectors.astype(np.float16))
    df = pd.DataFrame(rows)
    df["token_row"] = np.arange(len(df), dtype=np.int32)
    df["cls_token_fp16"] = [vec.astype(np.float16).tolist() for vec in vectors]
    df.to_parquet(output_dir / "features.parquet", index=False)


def create_or_version_dataset(output_dir: Path, slug: str, title: str, message: str, kaggle_json: Path | None) -> None:
    if not slug:
        return
    (output_dir / "dataset-metadata.json").write_text(
        json.dumps({"title": title, "id": slug, "licenses": [{"name": "CC0-1.0"}]}, indent=2),
        encoding="utf-8",
    )
    env = os.environ.copy()
    if kaggle_json:
        cred_dir = kaggle_json.parent
        env["KAGGLE_CONFIG_DIR"] = str(cred_dir)
    exists = subprocess.run(
        kaggle_command() + ["datasets", "files", slug],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if exists.returncode != 0:
        create = subprocess.run(
            kaggle_command() + ["datasets", "create", "-p", str(output_dir), "-r", "skip"],
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if create.returncode == 0:
            return
    version = subprocess.run(
        [
            *kaggle_command(),
            "datasets",
            "version",
            "-p",
            str(output_dir),
            "-r",
            "skip",
            "-m",
            message,
        ],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if version.returncode != 0:
        details = ""
        if "create" in locals():
            details += f" create output: {create.stdout[-2000:]}"
        details += f" version output: {version.stdout[-2000:]}"
        raise RuntimeError("failed to create/version Kaggle features dataset." + details)


def maybe_write_embedded_kaggle_json(encoded: str, work_root: Path) -> Path | None:
    if not encoded:
        existing = work_root / "kaggle.json"
        return existing if existing.exists() else None
    path = work_root / "kaggle.json"
    path.write_bytes(base64.b64decode(encoded))
    os.chmod(path, 0o600)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract MERT CLS-like tokens from raw Bilibili favorite dataset.")
    parser.add_argument("--input-root", default=str(DEFAULT_INPUT_ROOT))
    parser.add_argument("--work-root", default=str(DEFAULT_WORK_ROOT))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--clip-seconds", type=float, default=30.0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dataset-slug", default="")
    parser.add_argument("--dataset-title", default="shizaixingsheng test MERT features")
    parser.add_argument("--embedded-kaggle-json-b64", default="")
    parser.add_argument("--allow-cpu-fallback", action="store_true")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    rng = random.Random(args.seed)
    input_root = Path(args.input_root)
    work_root = Path(args.work_root)
    output_dir = work_root / "mert_features"

    kaggle_json = maybe_write_embedded_kaggle_json(args.embedded_kaggle_json_b64, work_root)
    raw_dirs = collect_raw_inputs(input_root, work_root)
    samples: list[tuple[Path, dict]] = []
    for raw_dir in raw_dirs:
        samples.extend((raw_dir, item) for item in read_jsonl(raw_dir / "valid_manifest.jsonl"))
    if args.limit:
        samples = samples[: args.limit]

    torch, processor, model, device = import_mert(args.allow_cpu_fallback)
    rows: list[dict] = []
    vectors: list[np.ndarray] = []
    failures: list[dict] = []
    sample_rate = int(processor.sampling_rate)

    for index, (raw_dir, item) in enumerate(samples, 1):
        audio_path = raw_dir / item["audio_filename"]
        html_path = raw_dir / item["html_filename"]
        try:
            audio = load_audio_ffmpeg(audio_path, sample_rate, args.clip_seconds, rng)
            token = extract_cls_token(torch, processor, model, device, audio)
            meta = parse_html_metadata(html_path, item["bvid"], int(item["cid"]), int(item["page"]))
            rows.append(
                {
                    "bv_id": item["bvid"],
                    "page": int(item["page"]),
                    "cid": int(item["cid"]),
                    "uid": meta["uid"],
                    "date": meta["date"],
                    "n_view": meta["n_view"],
                    "link": meta["link"],
                    "title": item.get("title", ""),
                    "part": item.get("part", ""),
                    "audio_filename": item["audio_filename"],
                    "html_filename": item["html_filename"],
                    "source_raw_dir": raw_dir.name,
                }
            )
            vectors.append(token)
            print(f"[mert] {index}/{len(samples)} ok {item['bvid']} p{item['page']}")
        except Exception as exc:
            failure = {"item": item, "error": str(exc)}
            failures.append(failure)
            print(f"[mert] {index}/{len(samples)} failed: {exc}")

    if not vectors:
        raise RuntimeError("no feature vectors extracted")

    vector_array = np.vstack(vectors).astype(np.float16)
    write_features_parquet(rows, vector_array, output_dir)
    (output_dir / "feature_failures.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in failures),
        encoding="utf-8",
    )
    (output_dir / "features_manifest.json").write_text(
        json.dumps(
            {
                "created_at": now_iso(),
                "model": MODEL_NAME,
                "sample_rate": sample_rate,
                "clip_seconds": args.clip_seconds,
                "seed": args.seed,
                "n_features": len(rows),
                "n_failures": len(failures),
                "source_raw_dirs": [str(path) for path in raw_dirs],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    if args.dataset_slug:
        create_or_version_dataset(
            output_dir,
            args.dataset_slug,
            args.dataset_title,
            f"MERT features {now_iso()}",
            kaggle_json,
        )

    if kaggle_json and args.embedded_kaggle_json_b64:
        kaggle_json.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
