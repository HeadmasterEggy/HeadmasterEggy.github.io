#!/usr/bin/env python3
"""生成更简洁、接近 Obsidian 分类星型结构的关系图谱。

规则：
- 节点 = 普通笔记 + 每个类别一个“大类节点”
- 普通笔记之间只保留跨类别的真实链接
- 同类别内部，不再互相乱连，统一只连到该类别的大类节点
- 大类节点优先复用真实存在的“总览文档”；没有就生成一个合成节点

这样图谱会更像：
  文档 -> 大类节点 <- 文档
而不是同类文档之间形成一团网。
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path, PurePosixPath
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
SKIP_NODE_TOP_FOLDERS = {"标签集合", "思维导图"}
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
        if in_code or not line:
            continue
        if line.startswith("#"):
            continue
        if line.startswith(">"):
            line = line.lstrip("> ").strip()
        if line.startswith("- [[") or line.startswith("* [["):
            continue
        line = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", line)
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"<[^>]+>", "", line).strip()
        if line:
            return line[:140]
    return fallback[:140] if fallback else ""


def top_folder(rel: str) -> str:
    parts = PurePosixPath(rel).parts
    return parts[0] if parts else "根目录"


def derive_cluster(rel: str) -> str | None:
    parts = PurePosixPath(rel).parts
    if len(parts) <= 1:
        return None
    if parts[0] == "Course" and len(parts) >= 2:
        return parts[1]
    return parts[0]


def normalize_text(s: str) -> str:
    return re.sub(r"[\s_\-]+", "", (s or "").strip().lower())


notes = {}
path_no_ext_map = {}
stem_map = {}
abbr_map = {}
clusters = {}

for path in POSTS_DIR.rglob("*.md"):
    if set(path.parts) & IGNORE_DIRS:
        continue
    rel = path.relative_to(POSTS_DIR).as_posix()
    if top_folder(rel) in SKIP_NODE_TOP_FOLDERS:
        continue

    fm, body = parse_note(path)
    title = str(fm.get("title") or path.stem)
    categories = normalize_list(fm.get("categories"))
    tags = normalize_list(fm.get("tags"))
    abbr = fm.get("abbrlink")
    abbr = str(abbr).strip().strip("'\"") if abbr is not None else ""
    cluster = derive_cluster(rel)
    category = cluster or (categories[0] if categories else top_folder(rel))

    notes[rel] = {
        "id": rel,
        "rel": rel,
        "stem": path.stem,
        "title": title,
        "top_folder": top_folder(rel),
        "cluster": cluster,
        "category": category or "未分类",
        "categories": categories,
        "tags": tags,
        "abbrlink": abbr,
        "published": bool(abbr),
        "url": f"/posts/{abbr}.html" if abbr else None,
        "body": body,
        "excerpt": first_excerpt(body, title),
        "type": "note",
        "synthetic": False,
    }
    path_no_ext_map[rel[:-3]] = rel
    stem_map.setdefault(path.stem, []).append(rel)
    if abbr:
        abbr_map[abbr] = rel
    if cluster:
        clusters.setdefault(cluster, []).append(rel)


hub_for_cluster = {}
cluster_label = {}

for cluster, ids in clusters.items():
    if len(ids) < 2:
        continue

    label = cluster
    cluster_label[cluster] = label
    norm_cluster = normalize_text(cluster)
    ranked = []
    for rel in ids:
        note = notes[rel]
        stem_match = normalize_text(note["stem"]) == norm_cluster
        title_match = normalize_text(note["title"]) == norm_cluster
        score = 0
        if title_match:
            score += 6
        if stem_match:
            score += 3
        if note["rel"].endswith(f"/{cluster}.md") or note["rel"] == f"{cluster}.md":
            score += 2
        if note["top_folder"] == cluster:
            score += 1
        ranked.append((score, len(note["rel"]), rel, title_match))
    ranked.sort(reverse=True)
    best_score, _, best_rel, best_title_match = ranked[0]

    if best_title_match or best_score >= 8:
        hub_for_cluster[cluster] = best_rel
        notes[best_rel]["type"] = "hub"
    else:
        hub_id = f"hub::{cluster}"
        hub_for_cluster[cluster] = hub_id
        notes[hub_id] = {
            "id": hub_id,
            "rel": hub_id,
            "stem": cluster,
            "title": label,
            "top_folder": cluster,
            "cluster": cluster,
            "category": cluster,
            "categories": [cluster],
            "tags": [],
            "abbrlink": "",
            "published": False,
            "url": None,
            "body": "",
            "excerpt": f"{label} 的大类节点，用来把同类文档挂到一起。",
            "type": "hub",
            "synthetic": True,
        }


all_nodes = notes
real_note_ids = {nid for nid, n in all_nodes.items() if not n["synthetic"]}


def resolve_obsidian_target(target: str, current_rel: str):
    target = target.split("|", 1)[0].split("#", 1)[0].strip()
    target = unquote(target).strip().lstrip("/")
    if not target or "://" in target:
        return None
    if target.endswith(".md"):
        target = target[:-3]

    if target in path_no_ext_map:
        return path_no_ext_map[target]

    current_parent = PurePosixPath(current_rel).parent
    rel_candidate = os.path.normpath(str(current_parent.joinpath(target))).replace("\\", "/")
    if rel_candidate in path_no_ext_map:
        return path_no_ext_map[rel_candidate]

    suffix_matches = [rel for noext, rel in path_no_ext_map.items() if noext.endswith(target)]
    if len(suffix_matches) == 1:
        return suffix_matches[0]

    if "/" not in target and len(stem_map.get(target, [])) == 1:
        return stem_map[target][0]

    return None


def resolve_markdown_target(raw_target: str, current_rel: str):
    raw_target = unquote(raw_target.strip().split("#", 1)[0].split("?", 1)[0].strip())
    if not raw_target or "://" in raw_target or raw_target.startswith("mailto:"):
        return None

    m = POST_URL_RE.search(raw_target)
    if m:
        return abbr_map.get(m.group(1))

    if not raw_target.endswith(".md"):
        return None

    current_parent = PurePosixPath(current_rel).parent
    if raw_target.startswith("/"):
        candidate = PurePosixPath(raw_target.lstrip("/"))
    else:
        candidate = current_parent.joinpath(raw_target)
    candidate = PurePosixPath(os.path.normpath(str(candidate)))
    candidate_rel = candidate.as_posix()
    return candidate_rel if candidate_rel in real_note_ids else None


edge_map = {}


def add_edge(src: str, dst: str, kind: str, origin: str):
    if not src or not dst or src == dst:
        return
    key = tuple(sorted((src, dst)))
    if key not in edge_map:
        edge_map[key] = {
            "source": src,
            "target": dst,
            "kind": kind,
            "weight": 1.25 if kind == "hub" else 2,
            "origins": [origin],
        }
    else:
        if origin not in edge_map[key]["origins"]:
            edge_map[key]["origins"].append(origin)
        if edge_map[key]["kind"] != "direct" and kind == "direct":
            edge_map[key]["kind"] = "direct"
            edge_map[key]["weight"] = 2


for rel in sorted(real_note_ids):
    note = all_nodes[rel]
    body = note["body"]

    for raw in WIKILINK_RE.findall(body):
        dst = resolve_obsidian_target(raw, rel)
        if dst in real_note_ids:
            src_cluster = note["cluster"]
            dst_cluster = all_nodes[dst]["cluster"]
            if src_cluster and src_cluster == dst_cluster and src_cluster in hub_for_cluster:
                hub = hub_for_cluster.get(src_cluster)
                if rel == hub or dst == hub:
                    add_edge(rel, dst, "hub", "wikilink")
            else:
                add_edge(rel, dst, "direct", "wikilink")

    for raw in MARKDOWN_LINK_RE.findall(body):
        dst = resolve_markdown_target(raw, rel)
        if dst in real_note_ids:
            src_cluster = note["cluster"]
            dst_cluster = all_nodes[dst]["cluster"]
            if src_cluster and src_cluster == dst_cluster and src_cluster in hub_for_cluster:
                hub = hub_for_cluster.get(src_cluster)
                if rel == hub or dst == hub:
                    add_edge(rel, dst, "hub", "markdown")
            else:
                add_edge(rel, dst, "direct", "markdown")

    for m in POST_URL_RE.finditer(body):
        dst = abbr_map.get(m.group(1))
        if dst in real_note_ids:
            src_cluster = note["cluster"]
            dst_cluster = all_nodes[dst]["cluster"]
            if src_cluster and src_cluster == dst_cluster and src_cluster in hub_for_cluster:
                hub = hub_for_cluster.get(src_cluster)
                if rel == hub or dst == hub:
                    add_edge(rel, dst, "hub", "permalink")
            else:
                add_edge(rel, dst, "direct", "permalink")


# 保证同类文档统一挂到一个大类节点上
for cluster, ids in clusters.items():
    if len(ids) < 2:
        continue
    hub = hub_for_cluster[cluster]
    for rel in ids:
        if rel == hub:
            continue
        add_edge(rel, hub, "hub", "cluster")


edges = list(edge_map.values())
degree = {nid: 0 for nid in all_nodes}
for edge in edges:
    degree[edge["source"]] += 1
    degree[edge["target"]] += 1

nodes = []
for nid, note in sorted(all_nodes.items(), key=lambda kv: (kv[1]["type"] != "hub", kv[1]["category"], kv[1]["title"].lower())):
    nodes.append({
        "id": note["id"],
        "title": note["title"],
        "category": note["category"],
        "categories": note["categories"],
        "folder": note["top_folder"],
        "cluster": note["cluster"],
        "tags": note["tags"],
        "url": note["url"],
        "degree": degree[nid],
        "type": note["type"],
        "published": note["published"],
        "synthetic": note["synthetic"],
        "path": note["rel"],
        "excerpt": note["excerpt"],
    })

categories = sorted({node["category"] for node in nodes})
meta = {
    "nodeCount": len(nodes),
    "edgeCount": len(edges),
    "publishedCount": sum(1 for n in nodes if n["published"]),
    "hubCount": sum(1 for n in nodes if n["type"] == "hub"),
    "syntheticHubCount": sum(1 for n in nodes if n["type"] == "hub" and n["synthetic"]),
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
print(f"✓ 已发布正文: {meta['publishedCount']}")
print(f"✓ 大类节点: {meta['hubCount']} (其中合成 {meta['syntheticHubCount']})")
print(f"✓ 孤点: {meta['isolatedCount']}")
print(f"→ {OUT}")
