#!/usr/bin/env python3
"""
The Drifter's Codex — chapter data builder

Reads:
  - data/_source/toefl_rank_a.csv      (900 headwords)
  - data/_drafts/inscriptions.jsonl    (stele inscriptions + modern examples)
  - data/_drafts/story_drafts.v2.md    (16 chapters, 5 fragments each)

Writes:
  - data/manifest.js
  - data/chapters/chapter_NN.js (16 files)
"""

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_CSV = ROOT / "data" / "_source" / "toefl_rank_a.csv"
STORY_V1 = ROOT / "data" / "_drafts" / "story_drafts.v1.md"
STORY_V2 = ROOT / "data" / "_drafts" / "story_drafts.v2.md"
INSCRIPTIONS_JSONL = ROOT / "data" / "_drafts" / "inscriptions.jsonl"
OUT_DIR = ROOT / "data"
CHAPTER_DIR = OUT_DIR / "chapters"

NUM_CHAPTERS = 16

CHAPTER_THEMES = [
    ("忘られた概念の島",   "Foundations I"),
    ("沈んだ法の島",       "Foundations II"),
    ("機関室の祠",         "Engine Room I"),
    ("鏡の修道院",         "Engine Room II"),
    ("七つの河の合流点",   "Channels I"),
    ("螺旋階段の塔",       "Channels II"),
    ("裁定の谷",           "Decision I"),
    ("総括の図書館",       "Decision II"),
    ("均衡の野原",         "Field I"),
    ("展望の岬",           "Field II"),
    ("忘却の渡り廊下",     "Bridge I"),
    ("回復の温泉",         "Bridge II"),
    ("漂着物の浜",         "The Drift"),
    ("影の地下都市",       "The Shadow"),
    ("収束の天文台",       "The Convergence"),
    ("頂の灯台",           "The Apex"),
]


def load_words():
    with SOURCE_CSV.open() as f:
        return list(csv.DictReader(f))


def load_inscriptions():
    by_head = {}
    if not INSCRIPTIONS_JSONL.exists():
        return by_head
    with INSCRIPTIONS_JSONL.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            by_head[d["headword"]] = d
    return by_head


def _parse_md(path):
    text = path.read_text()
    chapters = {}
    current_ch = None
    current_th = None
    buf = []

    def flush():
        if current_ch is not None and current_th is not None and buf:
            chapters.setdefault(current_ch, {})[current_th] = "\n".join(buf).strip()

    for line in text.splitlines():
        m_ch = re.match(r"^## Chapter (\d+)", line)
        m_th = re.match(r"^### TH=(\d+)", line)
        if m_ch:
            flush()
            current_ch = int(m_ch.group(1))
            current_th = None
            buf = []
        elif m_th:
            flush()
            current_th = int(m_th.group(1))
            buf = []
        else:
            if current_th is not None:
                buf.append(line)
    flush()
    return chapters


def parse_story_md():
    v1 = _parse_md(STORY_V1) if STORY_V1.exists() else {}
    v2 = _parse_md(STORY_V2) if STORY_V2.exists() else {}
    merged = {}
    for ch_num in set(list(v1.keys()) + list(v2.keys())):
        merged[ch_num] = {}
        v1_ch = v1.get(ch_num, {})
        v2_ch = v2.get(ch_num, {})
        for th in set(list(v1_ch.keys()) + list(v2_ch.keys())):
            merged[ch_num][th] = v2_ch.get(th, v1_ch.get(th, ""))
    return merged


INTERACTIVE_RE = re.compile(r"\[([^\]:]+):([a-zA-Z][a-zA-Z\-]*)\]")


def text_to_segments(body, valid_headwords):
    segments = []
    pos = 0
    for m in INTERACTIVE_RE.finditer(body):
        jp_phrase, headword = m.group(1), m.group(2).lower()
        if headword not in valid_headwords:
            continue
        if m.start() > pos:
            prefix = body[pos:m.start()]
            if prefix:
                segments.append({"type": "text", "text": prefix})
        segments.append({
            "type": "interactive",
            "headword": headword,
            "jp_phrase": jp_phrase,
        })
        pos = m.end()
    if pos < len(body):
        tail = body[pos:]
        if tail:
            segments.append({"type": "text", "text": tail})
    return segments


def strip_markup(body):
    return INTERACTIVE_RE.sub(lambda m: m.group(1), body)


def split_into_chapters(rows):
    n = len(rows)
    per = n // NUM_CHAPTERS
    rem = n % NUM_CHAPTERS
    chapters = []
    idx = 0
    for ch in range(NUM_CHAPTERS):
        size = per + (1 if ch < rem else 0)
        chapters.append(rows[idx: idx + size])
        idx += size
    return chapters


def build_chapter(ch_idx, words_rows, inscriptions, stories):
    name, subtitle = CHAPTER_THEMES[ch_idx]
    chapter_num = ch_idx + 1
    chapter_id = f"chapter_{chapter_num:02d}"
    fragments_raw = stories.get(chapter_num, {})
    valid_headwords = {row["headword"] for row in words_rows}

    thresholds = sorted(fragments_raw.keys())
    fragments = []
    interactive_by_threshold = {}
    for t in thresholds:
        body = fragments_raw[t]
        segs = text_to_segments(body, valid_headwords)
        heads_in_seg = [s["headword"] for s in segs if s["type"] == "interactive"]
        interactive_by_threshold[t] = heads_in_seg
        fragments.append({
            "threshold": t,
            "text": strip_markup(body),
            "segments": segs,
        })

    words = []
    for row in words_rows:
        head = row["headword"]
        ins = inscriptions.get(head, {})
        words.append({
            "headword": head,
            "sublist": int(row["sublist"]),
            "pos": row["pos"],
            "jp_meaning": row["jp_meaning"],
            "stele_en": ins.get("stele_en", ""),
            "stele_jp": ins.get("stele_jp", ""),
            "modern_en": ins.get("modern_en", ""),
            "modern_jp": ins.get("modern_jp", ""),
        })

    has_interactive = any(seg["type"] == "interactive"
                          for frag in fragments for seg in frag["segments"])

    return {
        "id": chapter_id,
        "index": chapter_num,
        "island_name": name,
        "subtitle": subtitle,
        "word_count": len(words),
        "has_interactive": has_interactive,
        "fragments": fragments,
        "interactive_by_threshold": interactive_by_threshold,
        "words": words,
    }


def main():
    words = load_words()
    inscriptions = load_inscriptions()
    stories = parse_story_md()
    chapters_words = split_into_chapters(words)

    CHAPTER_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest_chapters = []
    all_word_island = {}

    for i, words_rows in enumerate(chapters_words):
        payload = build_chapter(i, words_rows, inscriptions, stories)
        out_path = CHAPTER_DIR / f"{payload['id']}.js"
        js = (
            "window.DRIFTERS_DATA = window.DRIFTERS_DATA || {};\n"
            f"window.DRIFTERS_DATA[\"{payload['id']}\"] = "
            + json.dumps(payload, ensure_ascii=False, indent=2)
            + ";\n"
        )
        out_path.write_text(js)
        for w in payload["words"]:
            all_word_island[w["headword"]] = payload["index"]
        manifest_chapters.append({
            "id": payload["id"],
            "index": payload["index"],
            "island_name": payload["island_name"],
            "subtitle": payload["subtitle"],
            "word_count": payload["word_count"],
            "fragment_count": len(payload["fragments"]),
            "has_interactive": payload["has_interactive"],
        })
        interactive_count = sum(1 for f in payload["fragments"] for s in f["segments"] if s["type"] == "interactive")
        flag = " [interactive]" if payload["has_interactive"] else ""
        print(f"[write] {out_path.name}  {payload['word_count']} words, {len(payload['fragments'])} fragments, {interactive_count} interactive{flag}")

    manifest = {
        "chapters": manifest_chapters,
        "total_words": sum(c["word_count"] for c in manifest_chapters),
        "word_to_chapter": all_word_island,
    }
    manifest_path = OUT_DIR / "manifest.js"
    manifest_path.write_text(
        "window.DRIFTERS_MANIFEST = "
        + json.dumps(manifest, ensure_ascii=False, indent=2)
        + ";\n"
    )
    print(f"[write] {manifest_path.name}  total {manifest['total_words']} words")


if __name__ == "__main__":
    main()
