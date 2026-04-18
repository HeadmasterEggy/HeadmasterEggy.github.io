#!/usr/bin/env python3
"""生成更接近 Obsidian 的关系图谱数据。

策略：
- 节点 = source/_posts 下的 Markdown 笔记（包括 标签集合 / 思维导图）
- 边 = 真实笔记链接
  - [[wikilink]]
  - markdown 相对 .md 链接
  - /posts/abbrlink.html permalink 链接
- 不再用共享 tag/category 人工补边，避免图谱“乱连”
- 标签集合 / 思维导图 保留为辅助节点，让结构更像 Obsidian 里的知识图谱
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote

try:
    import yaml
except ImportError:
    print("需要 pyyaml: pip install pyyaml --break-system-packages")
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[2]
POSTS_DIR = ROOT / "source" / "_posts"
OUT = Path(__file__).resolve().parent / "data.json"

IGNORE_DIRS = {".obsidian", ".corrupted_backup", "node_modules", ".git"}
SPECIAL_NODE_TYPES = {
    "标签集合": "collection",
    "思维导图": "map",
}

WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
POST_URL_RE = re.compile(r"/posts/([A-Za-z0-9]+)\.html")
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?", re.S)


def normalize_list(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return [str(x) for x in value if str(x).strip()]
    return [str(value)]


def parse_note(path: Path):
    text = path.read_text(encoding="utf-8", errors="ignore")
    fm = {}
    body = text
    m = FRONTMATTER_RE.match(text)
    if m:
        try:
            fm = yaml.safe_load(m.group(1)) or {}
            if not isinstance(fm, dict):
                fm = {}
        except Exception:
            fm = {}
        body = text[m.end():]
    return fm, body


def first_excerpt(body: str, fallback: str = "") -> str:
    lines = [ln.strip() for ln in body.splitlines()]
    in_code = False
    for line in lines:
        if line.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if not line:
            continue
        if line.startswith("#"):
            continue
        if line.startswith(">"):
            line = line.lstrip("> ").strip()
        if line.startswith("- [[") or line.startswith("* [["):
            continue
        line = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"<[^>]+>", "", line)
        line = line.strip()
        if line:
            return line[:140]
    return fallback[:140] if fallback else ""


def classify_node(rel: str):
    top = rel.split("/", 1)[0] if "/" in rel else "根目录"
    return SPECIAL_NODE_TYPES.get(top, "note")


notes = {}
path_no_ext_map = {}
stem_map = {}
abbr_map = {}

for path in POSTS_DIR.rglob("*.md"):
    parts = set(path.parts)
    if parts & IGNORE_DIRS:
        continue
    rel = path.relative_to(POSTS_DIR).as_posix()
    fm, body = parse_note(path)
    node_type = classify_node(rel)
    title = str(fm.get("title") or path.stem)
    categories = normalize_list(fm.get("categories"))
    tags = normalize_list(fm.get("tags"))
    top_folder = rel.split("/", 1)[0] if "/" in rel else "根目录"
    category = top_folder if node_type != "note" else (categories[0] if categories else top_folder)
    abbr = fm.get("abbrlink")
    abbr = str(abbr).strip().strip("'\"") if abbr is not None else ""
    published = bool(abbr) and node_type == "note"

    notes[rel] = {
        "id": rel,
        "title": title,
        "rel": rel,
        "stem": path.stem,
        "folder": top_folder,
        "category": category or "未分类",
        "categories": categories,
        "tags": tags,
        "abbrlink": abbr,
        "type": node_type,
        "published": published,
        "url": f"/posts/{abbr}.html" if published else None,
        "body": body,
        "excerpt": first_excerpt(body, title),
    }
    path_no_ext_map[rel[:-3]] = rel
    stem_map.setdefault(path.stem, []).append(rel)
    if abbr:
        abbr_map[abbr] = rel


def resolve_obsidian_target(target: str, current_rel: str):
    target = target.split("|", 1)[0].split("#", 1)[0].strip()
    target = unquote(target).strip().lstrip("/")
    if not target or "://" in target:
        return None
    if target.endswith(".md"):
        target = target[:-3]

    if target in path_no_ext_map:
        return path_no_ext_map[target]

    current_parent = str(Path(current_rel).parent).replace("\\", "/")
    if current_parent != ".":
        rel_candidate = str((Path(current_parent) / target)).replace("\\", "/")
        if rel_candidate in path_no_ext_map:
            return path_no_ext_map[rel_candidate]

    suffix_matches = [rel for noext, rel in path_no_ext_map.items() if noext.endswith(target)]
    if len(suffix_matches) == 1:
        return suffix_matches[0]

    if "/" not in target and len(stem_map.get(target, [])) == 1:
        return stem_map[target][0]

    return None


def resolve_markdown_target(raw_target: str, current_rel: str):
    raw_target = raw_target.strip().split("#", 1)[0].split("?", 1)[0].strip()
    raw_target = unquote(raw_target)
    if not raw_target or "://" in raw_target or raw_target.startswith("mailto:"):
        return None

    m = POST_URL_RE.search(raw_target)
    if m:
        return abbr_map.get(m.group(1))

    if not raw_target.endswith(".md"):
        return None

    current_parent = Path(current_rel).parent
    if raw_target.startswith("/"):
        candidate = raw_target.lstrip("/")
    else:
        candidate = str((current_parent / raw_target).resolve().relative_to(POSTS_DIR.resolve())).replace("\\", "/")
    return notes.get(candidate, {}).get("rel")


edge_map = {}


def add_edge(src: str, dst: str, origin: str):
    if not src or not dst or src == dst:
        return
    key = tuple(sorted((src, dst)))
    if key not in edge_map:
        src_type = notes[src]["type"]
        dst_type = notes[dst]["type"]
        involves_helper = src_type != "note" or dst_type != "note"
        edge_map[key] = {
            "source": src,
            "target": dst,
            "kind": "hub" if involves_helper else "direct",
            "weight": 1.2 if involves_helper else 2,
            "origins": [origin],
        }
    else:
        if origin not in edge_map[key]["origins"]:
            edge_map[key]["origins"].append(origin)


for rel, note in notes.items():
    body = note["body"]

    for raw in WIKILINK_RE.findall(body):
        dst = resolve_obsidian_target(raw, rel)
        if dst:
            add_edge(rel, dst, "wikilink")

    for raw in MARKDOWN_LINK_RE.findall(body):
        dst = resolve_markdown_target(raw, rel)
        if dst:
            add_edge(rel, dst, "markdown")

    for m in POST_URL_RE.finditer(body):
        dst = abbr_map.get(m.group(1))
        if dst:
            add_edge(rel, dst, "permalink")

edges = list(edge_map.values())

degree = {rel: 0 for rel in notes}
for edge in edges:
    degree[edge["source"]] += 1
    degree[edge["target"]] += 1

nodes = []
for rel, note in sorted(notes.items(), key=lambda kv: (kv[1]["type"], kv[1]["category"], kv[1]["title"].lower())):
    nodes.append({
        "id": note["id"],
        "title": note["title"],
        "category": note["category"],
        "categories": note["categories"],
        "folder": note["folder"],
        "tags": note["tags"],
        "url": note["url"],
        "degree": degree[rel],
        "type": note["type"],
        "published": note["published"],
        "path": note["rel"],
        "excerpt": note["excerpt"],
    })

categories = sorted({node["category"] for node in nodes})
meta = {
    "nodeCount": len(nodes),
    "edgeCount": len(edges),
    "noteCount": sum(1 for n in nodes if n["type"] == "note"),
    "collectionCount": sum(1 for n in nodes if n["type"] == "collection"),
    "mapCount": sum(1 for n in nodes if n["type"] == "map"),
    "publishedCount": sum(1 for n in nodes if n["published"]),
    "isolatedCount": sum(1 for n in nodes if n["degree"] == 0),
}

OUT.write_text(
    json.dumps(
        {
            "nodes": nodes,
            "edges": edges,
            "categories": categories,
            "meta": meta,
        },
        ensure_ascii=False,
        indent=2,
    ),
    encoding="utf-8",
)

print(f"✓ 节点: {len(nodes)}")
print(f"✓ 边: {len(edges)}")
print(f"✓ 普通笔记: {meta['noteCount']}")
print(f"✓ 标签集合: {meta['collectionCount']}")
print(f"✓ 思维导图: {meta['mapCount']}")
print(f"✓ 已发布页面: {meta['publishedCount']}")
print(f"✓ 孤点: {meta['isolatedCount']}")
print(f"→ {OUT}")
