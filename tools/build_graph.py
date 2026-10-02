#!/usr/bin/env python3
"""Конвертує дані OpenStreetMap у компактний офлайн-граф для застосунку.

Приклади:
  # з файлу .osm / .osm.gz / .osm.bz2 (наприклад, експорт з openstreetmap.org)
  python3 tools/build_graph.py kyiv.osm -o data/kyiv.json --name "Київ"

  # завантажити область через Overpass API (south,west,north,east)
  python3 tools/build_graph.py --overpass 50.40,30.45,50.48,30.60 -o data/center.json

Для великих регіонів спершу відфільтруйте .pbf з Geofabrik утилітою osmium:
  osmium extract -b 30.2,50.2,30.9,50.6 ukraine-latest.osm.pbf -o kyiv.osm.pbf
  osmium tags-filter kyiv.osm.pbf w/highway -o kyiv-roads.osm
Скрипт використовує лише стандартну бібліотеку Python.
"""

import argparse
import bz2
import gzip
import io
import json
import math
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

CAR_HIGHWAYS = [
    'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
    'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
    'unclassified', 'residential', 'living_street',
]
FLAG_ONEWAY, FLAG_ONEWAY_REVERSE, FLAG_ROUNDABOUT = 1, 2, 4
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'


def open_input(path):
    if path.endswith('.gz'):
        return gzip.open(path, 'rb')
    if path.endswith('.bz2'):
        return bz2.open(path, 'rb')
    return open(path, 'rb')


def download_overpass(bbox, highways):
    s, w, n, e = bbox
    query = (
        '[out:xml][timeout:300];'
        f'way["highway"~"^({"|".join(highways)})$"]({s},{w},{n},{e});'
        '(._;>;);out body;'
    )
    data = urllib.parse.urlencode({'data': query}).encode()
    print('Завантаження з Overpass API…', file=sys.stderr)
    with urllib.request.urlopen(OVERPASS_URL, data=data, timeout=600) as r:
        return io.BytesIO(r.read())


def is_drivable(tags, highways):
    if tags.get('highway') not in highways or tags.get('area') == 'yes':
        return False
    car = tags.get('motorcar') or tags.get('motor_vehicle')
    if car in ('no', 'private'):
        return False
    if tags.get('access') in ('no', 'private') and car not in ('yes', 'designated', 'destination'):
        return False
    return True


def way_flags(tags):
    flags = 0
    oneway = tags.get('oneway', '')
    if tags.get('junction') in ('roundabout', 'circular'):
        flags |= FLAG_ROUNDABOUT
        if oneway != 'no':
            flags |= FLAG_ONEWAY
    if oneway in ('yes', 'true', '1'):
        flags |= FLAG_ONEWAY
    elif oneway in ('-1', 'reverse'):
        flags |= FLAG_ONEWAY_REVERSE
    elif tags.get('highway') in ('motorway', 'motorway_link') and oneway != 'no':
        flags |= FLAG_ONEWAY
    return flags


def parse_osm(stream, highways):
    coords = {}
    ways = []
    for _, el in ET.iterparse(stream, events=('end',)):
        if el.tag == 'node':
            coords[int(el.get('id'))] = (float(el.get('lat')), float(el.get('lon')))
            el.clear()
        elif el.tag == 'way':
            tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
            if is_drivable(tags, highways):
                refs = [int(nd.get('ref')) for nd in el.findall('nd')]
                ways.append({
                    'name': tags.get('name:uk') or tags.get('name') or '',
                    'cls': tags['highway'],
                    'flags': way_flags(tags),
                    'refs': refs,
                })
            el.clear()
    return coords, ways


def local_xy(lat, lon, lat0):
    k = 111320.0
    return lon * k * math.cos(math.radians(lat0)), lat * k


def douglas_peucker(points, keep, tol):
    """points — список (x, y); keep — множина індексів, які не можна видаляти."""
    out = [False] * len(points)
    out[0] = out[-1] = True
    for i in keep:
        out[i] = True
    anchors = [i for i, v in enumerate(out) if v]
    for a, b in zip(anchors, anchors[1:]):
        stack = [(a, b)]
        while stack:
            i, j = stack.pop()
            if j - i < 2:
                continue
            (x1, y1), (x2, y2) = points[i], points[j]
            dx, dy = x2 - x1, y2 - y1
            norm = math.hypot(dx, dy) or 1e-9
            best, best_d = -1, -1.0
            for m in range(i + 1, j):
                x, y = points[m]
                d = abs(dy * (x - x1) - dx * (y - y1)) / norm
                if d > best_d:
                    best, best_d = m, d
            if best_d > tol:
                out[best] = True
                stack.append((i, best))
                stack.append((best, j))
    return out


def largest_component(ways):
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for w in ways:
        root = find(w['refs'][0])
        for r in w['refs'][1:]:
            parent[find(r)] = root
    sizes = {}
    for w in ways:
        root = find(w['refs'][0])
        sizes[root] = sizes.get(root, 0) + len(w['refs'])
    if not sizes:
        return ways
    best = max(sizes, key=sizes.get)
    return [w for w in ways if find(w['refs'][0]) == best]


def build(coords, ways, name, bbox=None, simplify=5.0):
    ways = [w for w in ways if len(w['refs']) >= 2 and all(r in coords for r in w['refs'])]
    if bbox:
        s, w_, n, e = bbox
        ways = [w for w in ways
                if any(s <= coords[r][0] <= n and w_ <= coords[r][1] <= e for r in w['refs'])]
    ways = largest_component(ways)

    usage = {}
    for w in ways:
        for r in set(w['refs']):
            usage[r] = usage.get(r, 0) + 1
    lat0 = sum(coords[w['refs'][0]][0] for w in ways) / max(1, len(ways))

    node_index, nodes_flat = {}, []
    names, name_index = [], {}
    classes, class_index = [], {}
    out_ways = []
    for w in ways:
        refs = w['refs']
        keep = {i for i, r in enumerate(refs) if usage[r] > 1 or refs.count(r) > 1}
        pts = [local_xy(*coords[r], lat0) for r in refs]
        mask = douglas_peucker(pts, keep, simplify) if simplify > 0 else [True] * len(refs)
        kept = [r for r, m in zip(refs, mask) if m]

        ids = []
        for r in kept:
            if r not in node_index:
                node_index[r] = len(node_index)
                lat, lon = coords[r]
                nodes_flat += [round(lat, 6), round(lon, 6)]
            ids.append(node_index[r])

        if w['name']:
            if w['name'] not in name_index:
                name_index[w['name']] = len(names)
                names.append(w['name'])
            ni = name_index[w['name']]
        else:
            ni = -1
        if w['cls'] not in class_index:
            class_index[w['cls']] = len(classes)
            classes.append(w['cls'])
        out_ways.append([ni, class_index[w['cls']], w['flags'], *ids])

    return {'name': name, 'nodes': nodes_flat, 'names': names, 'classes': classes, 'ways': out_ways}


def parse_bbox(text):
    vals = [float(v) for v in text.split(',')]
    if len(vals) != 4:
        raise argparse.ArgumentTypeError('bbox: south,west,north,east')
    return vals


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', nargs='?', help='.osm, .osm.gz або .osm.bz2')
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--name', default='Карта')
    ap.add_argument('--bbox', type=parse_bbox, help='обрізати: south,west,north,east')
    ap.add_argument('--overpass', type=parse_bbox, metavar='BBOX', help='завантажити область з Overpass API')
    ap.add_argument('--include-service', action='store_true', help='включати проїзди (highway=service)')
    ap.add_argument('--simplify', type=float, default=5.0, help='допуск спрощення геометрії, м (0 — вимкнути)')
    args = ap.parse_args()

    highways = set(CAR_HIGHWAYS) | ({'service'} if args.include_service else set())
    if args.overpass:
        stream = download_overpass(args.overpass, sorted(highways))
    elif args.input:
        stream = open_input(args.input)
    else:
        ap.error('вкажіть вхідний файл або --overpass')

    coords, ways = parse_osm(stream, highways)
    graph = build(coords, ways, args.name, args.bbox or args.overpass, args.simplify)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(graph, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Готово: {len(graph["nodes"]) // 2} вузлів, {len(graph["ways"])} доріг, '
          f'{len(graph["names"])} назв → {args.output}', file=sys.stderr)


if __name__ == '__main__':
    main()
