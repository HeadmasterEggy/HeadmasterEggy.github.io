#!/usr/bin/env python3
"""重新生成关系图谱数据。每次发布新文章后运行： python3 source/graph/build.py"""
import os, re, json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
posts_dir = os.path.join(ROOT, "source/_posts")

posts = {}
filename_to_abbr = {}

for root, dirs, files in os.walk(posts_dir):
    if '.corrupted_backup' in root:
        continue
    for f in files:
        if not f.endswith('.md'):
            continue
        path = os.path.join(root, f)
        with open(path) as fp:
            content = fp.read()
        fm_match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
        if not fm_match: continue
        fm = fm_match.group(1)
        title = re.search(r'^title:\s*(.+?)$', fm, re.MULTILINE)
        title = title.group(1).strip().strip("'\"") if title else f[:-3]
        cat = re.search(r'^categories:\s*\n\s*-\s*(.+?)$', fm, re.MULTILINE | re.DOTALL)
        if not cat:
            cat = re.search(r'^categories:\s*(.+?)$', fm, re.MULTILINE)
        category = cat.group(1).strip() if cat else '未分类'
        category = category.split('\n')[0].strip().strip("'-\"").strip()
        abbr_m = re.search(r'^abbrlink:\s*(\w+)$', fm, re.MULTILINE)
        if not abbr_m: continue
        abbr = abbr_m.group(1)
        posts[abbr] = {'id': abbr, 'title': title, 'category': category, 'path': path}
        filename_to_abbr[f[:-3]] = abbr

edges = []
edge_set = set()
for root, dirs, files in os.walk(posts_dir):
    if '.corrupted_backup' in root: continue
    for f in files:
        if not f.endswith('.md'): continue
        src = filename_to_abbr.get(f[:-3])
        if not src: continue
        with open(os.path.join(root, f)) as fp:
            content = fp.read()
        for m in re.finditer(r'\(/posts/([a-f0-9]{6,10})\.html\)', content):
            dst = m.group(1)
            if dst in posts and dst != src:
                key = (src, dst)
                if key not in edge_set:
                    edge_set.add(key)
                    edges.append({'source': src, 'target': dst})

categories = sorted(set(p['category'] for p in posts.values()))
nodes = [{'id': a, 'title': p['title'], 'category': p['category'], 'url': f'/posts/{a}.html',
         'degree': sum(1 for e in edges if e['source']==a or e['target']==a)}
        for a, p in posts.items()]

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json')
with open(out, 'w') as fp:
    json.dump({'nodes': nodes, 'edges': edges, 'categories': categories}, fp, ensure_ascii=False, indent=2)

print(f"✓ {len(nodes)} 节点, {len(edges)} 连接, {len(categories)} 分类 -> {out}")
