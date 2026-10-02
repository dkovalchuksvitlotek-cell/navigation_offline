#!/usr/bin/env python3
"""Генерує вигадане «Демо-місто» (data/demo.json) для перевірки застосунку без даних OSM.

Містить: сітку вулиць, односторонні вулиці, кільце, дорогу без назви з вигинами.
"""

import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
from build_graph import FLAG_ONEWAY, FLAG_ROUNDABOUT, build  # noqa: E402

LAT0, LON0 = 49.40, 32.05
STEP_M = 220
DLAT = STEP_M / 111320
DLON = STEP_M / (111320 * math.cos(math.radians(LAT0)))

# Вулиці зі сходу на захід (рядки y, з півдня на північ) і з півночі на південь (стовпці x).
ROWS = [
    ('набережна Дніпровська', 'secondary', 0),
    ('вулиця Шевченка', 'residential', 0),
    ('проспект Незалежності', 'primary', 0),
    ('вулиця Соборна', 'secondary', 0),
    ('вулиця Івана Франка', 'residential', FLAG_ONEWAY),  # лише на схід
    ('бульвар Лесі Українки', 'tertiary', 0),
    ('вулиця Садова', 'residential', 0),
]
COLS = [
    ('вулиця Січових Стрільців', 'residential', 0),
    ('провулок Тихий', 'residential', 0),
    ('вулиця Грушевського', 'tertiary', 0),
    ('вулиця Героїв України', 'primary', 0),
    ('вулиця Мазепи', 'residential', FLAG_ONEWAY),  # лише на північ
    ('вулиця Сковороди', 'residential', 0),
    ('вулиця Вишнева', 'residential', 0),
    ('вулиця Київська', 'secondary', 0),
]
RING = (3, 2)  # кільце на перетині Героїв України × проспект Незалежності
RING_NAME = 'площа Свободи'
RING_R = 40  # м


def main(out_path):
    rnd = random.Random(42)
    coords = {}
    next_id = [1]

    def node(lat, lon):
        nid = next_id[0]
        next_id[0] += 1
        coords[nid] = (lat, lon)
        return nid

    grid = {}
    for x in range(len(COLS)):
        for y in range(len(ROWS)):
            if (x, y) == RING:
                continue
            jitter = (rnd.uniform(-0.12, 0.12) * DLAT, rnd.uniform(-0.12, 0.12) * DLON)
            grid[x, y] = node(LAT0 + y * DLAT + jitter[0], LON0 + x * DLON + jitter[1])

    # Кільце: 8 вузлів проти годинникової стрілки, починаючи зі сходу.
    cx, cy = LON0 + RING[0] * DLON, LAT0 + RING[1] * DLAT
    ring = []
    for k in range(8):
        a = math.radians(45 * k)
        ring.append(node(cy + RING_R * math.sin(a) / 111320,
                         cx + RING_R * math.cos(a) / (111320 * math.cos(math.radians(LAT0)))))
    ring_e, ring_n, ring_w, ring_s = ring[0], ring[2], ring[4], ring[6]

    ways = []

    def way(name, cls, flags, refs):
        ways.append({'name': name, 'cls': cls, 'flags': flags, 'refs': refs})

    for y, (name, cls, flags) in enumerate(ROWS):
        refs = [grid.get((x, y)) for x in range(len(COLS))]
        if y == RING[1]:
            i = RING[0]
            way(name, cls, flags, refs[:i] + [ring_w])
            way(name, cls, flags, [ring_e] + refs[i + 1:])
        else:
            way(name, cls, flags, refs)
    for x, (name, cls, flags) in enumerate(COLS):
        refs = [grid.get((x, y)) for y in range(len(ROWS))]
        if x == RING[0]:
            i = RING[1]
            way(name, cls, flags, refs[:i] + [ring_s])
            way(name, cls, flags, [ring_n] + refs[i + 1:])
        else:
            way(name, cls, flags, refs)
    way(RING_NAME, 'primary', FLAG_ONEWAY | FLAG_ROUNDABOUT, ring + [ring[0]])

    # Заміська дорога без назви з вигинами від північно-східного кута до села.
    start = grid[len(COLS) - 1, len(ROWS) - 1]
    lat, lon = coords[start]
    road = [start]
    for i, (dy, dx) in enumerate([(0.6, 0.5), (1.2, 0.7), (1.7, 1.4), (2.0, 2.2), (2.6, 2.6)]):
        road.append(node(lat + dy * DLAT, lon + dx * DLON))
    way('', 'tertiary', 0, road)
    village = road[-1]
    vlat, vlon = coords[village]
    way('вулиця Польова', 'residential', 0,
        [node(vlat - 0.8 * DLAT, vlon - 0.3 * DLON), village, node(vlat + 0.7 * DLAT, vlon + 0.4 * DLON)])
    way('вулиця Лісова', 'residential', 0, [village, node(vlat + 0.1 * DLAT, vlon + 0.9 * DLON)])

    graph = build(coords, ways, 'Демо-місто (вигадане)', simplify=0)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(graph, f, ensure_ascii=False, separators=(',', ':'))
    print(f'Записано {out_path}: {len(graph["nodes"]) // 2} вузлів, {len(graph["ways"])} доріг')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'data', 'demo.json'))
