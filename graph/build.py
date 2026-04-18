#!/usr/bin/env python3
"""重新生成关系图谱数据。每次发布新文章后运行： python3 source/graph/build.py

- 跳过 skip_render 文件夹（不会生成 HTML 页面 → 点了会 404）
- 显式链接 `/posts/xxx.html` 作为强连接
- 共享 tag 的文章之间补一条弱连接（让图谱更密）
"""
import os, re, json, sys

try:
    import yaml
except ImportError:
    print("需要 pyyaml: pip install pyyaml --break-system-packages")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
posts_dir = os.path.join(ROOT, "source/_posts")

# skip_render 文件夹不会渲染成 HTML，点了会 404，所以不放进图谱
SKIP_FOLDERS = {'标签集合', '思维导图', '.corrupted_backup'}

posts = {}
filename_to_abbr = {}
post_tags = {}

for root, dirs, files in os.walk(posts_dir):
    rel = os.path.relpath(root, posts_dir)
    top = rel.split(os.sep)[0] if rel != '.' else ''
    if top in SKIP_FOLDERS:
        continue
    for f in files:
        if not f.endswith('.md'): continue
        path = os.path.join(root, f)
        with open(path) as fp:
            content = fp.read()
        fm_match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
        if not fm_match: continue
        try:
            data = yaml.safe_load(fm_match.group(1)) or {}
        except yaml.YAMLError:
            continue
        abbr = data.get('abbrlink')
        if not abbr: continue
        abbr = str(abbr).strip().strip("'\"")
        title = str(data.get('title', f[:-3]))
        cats = data.get('categories', [])
        if isinstance(cats, str): cats = [cats]
        category = cats[0] if cats else '未分类'
        tags = data.get('tags', [])
        if isinstance(tags, str): tags = [tags]
        tags = [str(t) for t in (tags or [])]
        posts[abbr] = {'id': abbr, 'title': title, 'category': str(category), 'tags': tags}
        filename_to_abbr[f[:-3]] = abbr
        post_tags[abbr] = set(tags)

# 1. 显式链接边
edges = []
edge_set = set()
for root, dirs, files in os.walk(posts_dir):
    rel = os.path.relpath(root, posts_dir)
    top = rel.split(os.sep)[0] if rel != '.' else ''
    if top in SKIP_FOLDERS: continue
    for f in files:
        if not f.endswith('.md'): continue
        src = filename_to_abbr.get(f[:-3])
        if not src: continue
        with open(os.path.join(root, f)) as fp:
            content = fp.read()
        for m in re.finditer(r'\(/posts/([a-f0-9]{6,10})\.html\)', content):
            dst = m.group(1)
            if dst in posts and dst != src:
                key = tuple(sorted([src, dst]))
                if key not in edge_set:
                    edge_set.add(key)
                    edges.append({'source': src, 'target': dst, 'weight': 2, 'kind': 'link'})

link_edge_count = len(edges)

# 2. 共享 tag 弱连接
tag_to_posts = {}
for abbr, tags in post_tags.items():
    for t in tags:
        tag_to_posts.setdefault(t, set()).add(abbr)

for tag, abbrs in tag_to_posts.items():
    if len(abbrs) < 2:
        continue
    abbrs = sorted(abbrs)
    # 小 tag 保持全连接，大 tag 用链式弱连接避免出现大量孤点/爆图
    if len(abbrs) <= 20:
        for i, a in enumerate(abbrs):
            for b in abbrs[i+1:]:
                key = (a, b)
                if key in edge_set: continue
                edge_set.add(key)
                edges.append({'source': a, 'target': b, 'weight': 1, 'kind': 'tag:' + tag})
    else:
        for a, b in zip(abbrs, abbrs[1:]):
            key = tuple(sorted([a, b]))
            if key in edge_set: continue
            edge_set.add(key)
            edges.append({'source': a, 'target': b, 'weight': 0.5, 'kind': 'tag-chain:' + tag})

tag_edge_count = len(edges) - link_edge_count

# 3. 同 category 弱连接（只在小类别下，避免巨大 hub）
cat_to_posts = {}
for abbr, p in posts.items():
    cat_to_posts.setdefault(p['category'], set()).add(abbr)

cat_edge_count = 0
for cat, abbrs in cat_to_posts.items():
    if len(abbrs) < 2:
        continue
    abbrs = sorted(abbrs)
    # 小分类全连接，大分类链式连接，防止大课内笔记全部掉成孤点
    if len(abbrs) <= 15:
        for i, a in enumerate(abbrs):
            for b in abbrs[i+1:]:
                key = (a, b)
                if key in edge_set: continue
                edge_set.add(key)
                edges.append({'source': a, 'target': b, 'weight': 1, 'kind': 'category:' + cat})
                cat_edge_count += 1
    else:
        for a, b in zip(abbrs, abbrs[1:]):
            key = tuple(sorted([a, b]))
            if key in edge_set: continue
            edge_set.add(key)
            edges.append({'source': a, 'target': b, 'weight': 0.5, 'kind': 'category-chain:' + cat})
            cat_edge_count += 1

categories = sorted(set(p['category'] for p in posts.values()))
nodes = []
for abbr, p in posts.items():
    deg = sum(1 for e in edges if e['source']==abbr or e['target']==abbr)
    nodes.append({
        'id': abbr,
        'title': p['title'],
        'category': p['category'],
        'tags': p['tags'],
        'url': f'/posts/{abbr}.html',
        'degree': deg,
    })

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json')
with open(out, 'w') as fp:
    json.dump({'nodes': nodes, 'edges': edges, 'categories': categories}, fp, ensure_ascii=False, indent=2)

print(f"✓ 节点: {len(nodes)}")
print(f"✓ 边: {len(edges)}")
print(f"  - 显式 /posts/xxx 链接: {link_edge_count}")
print(f"  - 共享 tag 连接: {tag_edge_count}")
print(f"  - 同 category 连接: {cat_edge_count}")
print(f"✓ 分类: {len(categories)}")
print(f"→ {out}")
