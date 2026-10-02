// Дорожній граф та пошук маршруту (A*) повністю офлайн.
//
// Формат файлу карти (див. tools/build_graph.py):
// {
//   "name": "Назва регіону",
//   "nodes": [lat0, lon0, lat1, lon1, ...],
//   "names": ["вулиця Шевченка", ...],
//   "classes": ["primary", "residential", ...],
//   "ways": [[nameIdx | -1, classIdx, flags, node0, node1, ...], ...]
// }

import { distance, bearing } from './geo.js';

export const FLAG_ONEWAY = 1; // рух лише в напрямку node0 -> nodeN
export const FLAG_ONEWAY_REVERSE = 2; // рух лише в напрямку nodeN -> node0
export const FLAG_ROUNDABOUT = 4; // кільцева розв'язка

/** Типова швидкість, км/год, за класом дороги OSM. */
const SPEED_KMH = {
  motorway: 90, motorway_link: 50,
  trunk: 80, trunk_link: 40,
  primary: 60, primary_link: 40,
  secondary: 50, secondary_link: 35,
  tertiary: 40, tertiary_link: 30,
  unclassified: 30, residential: 30,
  living_street: 10, service: 15,
};
const MAX_SPEED_MS = 90 / 3.6;
/** Класи, з'їзди на які не рахуються як «перехрестя» в підказках. */
const MINOR_CLASSES = new Set(['service']);

export class Graph {
  constructor(data) {
    this.name = data.name || 'Карта';
    this.names = data.names || [];
    this.classes = data.classes || [];
    const n = data.nodes.length / 2;
    this.size = n;
    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.lat[i] = data.nodes[2 * i];
      this.lon[i] = data.nodes[2 * i + 1];
    }

    this.ways = data.ways.map((w) => ({
      name: w[0],
      cls: this.classes[w[1]] || 'unclassified',
      flags: w[2],
      nodes: w.slice(3),
    }));

    /** adj[i] — напрямлені ребра, якими можна виїхати з вузла i. */
    this.adj = Array.from({ length: n }, () => []);
    /** Неорієнтовані сусіди (для виявлення перехресть). */
    const neighbours = Array.from({ length: n }, () => new Set());
    const majorNeighbours = Array.from({ length: n }, () => new Set());
    /** Індекси доріг, що проходять через вузол. */
    this.nodeWays = Array.from({ length: n }, () => []);

    this.ways.forEach((w, wi) => {
      const speed = (SPEED_KMH[w.cls] || 30) / 3.6;
      const major = !MINOR_CLASSES.has(w.cls);
      for (const id of new Set(w.nodes)) this.nodeWays[id].push(wi);
      for (let i = 0; i + 1 < w.nodes.length; i++) {
        const a = w.nodes[i];
        const b = w.nodes[i + 1];
        const len = this.dist(a, b);
        const cost = len / speed;
        if (!(w.flags & FLAG_ONEWAY_REVERSE)) this.adj[a].push({ to: b, way: wi, len, cost });
        if (!(w.flags & FLAG_ONEWAY)) this.adj[b].push({ to: a, way: wi, len, cost });
        neighbours[a].add(b);
        neighbours[b].add(a);
        if (major) {
          majorNeighbours[a].add(b);
          majorNeighbours[b].add(a);
        }
      }
    });

    this.degree = Uint8Array.from(neighbours, (s) => Math.min(255, s.size));
    this.majorDegree = Uint8Array.from(majorNeighbours, (s) => Math.min(255, s.size));

    /** Назва вулиці -> множина вузлів. */
    this.streetNodes = new Map();
    this.ways.forEach((w) => {
      if (w.name < 0) return;
      let set = this.streetNodes.get(w.name);
      if (!set) this.streetNodes.set(w.name, (set = new Set()));
      w.nodes.forEach((id) => set.add(id));
    });
  }

  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Не вдалося завантажити карту: ${res.status}`);
    return new Graph(await res.json());
  }

  dist(a, b) {
    return distance(this.lat[a], this.lon[a], this.lat[b], this.lon[b]);
  }

  bearing(a, b) {
    return bearing(this.lat[a], this.lon[a], this.lat[b], this.lon[b]);
  }

  /** Чи є вузол «справжнім» перехрестям (без урахування внутрішньодворових проїздів). */
  isJunction(id) {
    return this.majorDegree[id] >= 3;
  }

  streetName(nameIdx) {
    return nameIdx >= 0 ? this.names[nameIdx] : null;
  }

  /** Назви вулиць, що проходять через вузол. */
  namesAt(id) {
    const out = new Set();
    for (const wi of this.nodeWays[id]) {
      const w = this.ways[wi];
      if (w.name >= 0 && !MINOR_CLASSES.has(w.cls)) out.add(w.name);
    }
    return [...out];
  }

  /** Відсортований список вулиць (індекс, назва) для пошуку. */
  streetList() {
    return [...this.streetNodes.keys()]
      .map((idx) => ({ idx, name: this.names[idx] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }

  /** Вулиці, що перетинаються з даною, разом із вузлом перетину. */
  crossStreets(nameIdx) {
    const nodes = this.streetNodes.get(nameIdx);
    if (!nodes) return [];
    const found = new Map();
    for (const id of nodes) {
      for (const other of this.namesAt(id)) {
        if (other !== nameIdx && !found.has(other)) found.set(other, id);
      }
    }
    return [...found.entries()]
      .map(([idx, node]) => ({ idx, name: this.names[idx], node }))
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  }

  /** Вузол вулиці, найближчий до її геометричного центру. */
  streetCenter(nameIdx) {
    const nodes = [...(this.streetNodes.get(nameIdx) || [])];
    if (!nodes.length) return -1;
    let lat = 0;
    let lon = 0;
    nodes.forEach((id) => { lat += this.lat[id]; lon += this.lon[id]; });
    return this.nearestNode(lat / nodes.length, lon / nodes.length, nodes);
  }

  nearestNode(lat, lon, candidates = null) {
    let best = -1;
    let bestD = Infinity;
    const check = (i) => {
      if (!candidates && this.adj[i].length === 0 && this.degree[i] === 0) return;
      const d = distance(lat, lon, this.lat[i], this.lon[i]);
      if (d < bestD) { bestD = d; best = i; }
    };
    if (candidates) candidates.forEach(check);
    else for (let i = 0; i < this.size; i++) check(i);
    return best;
  }

  /**
   * Найшвидший маршрут A*.
   * opts.firstEdge — фільтр ребер, якими дозволено виїхати зі старту
   * (наприклад, щоб після пропущеного повороту не пропонувати одразу розворот).
   * Повертає { nodes, ways, length, time } або null.
   */
  route(start, goal, opts = {}) {
    if (start === goal) return { nodes: [start], ways: [], length: 0, time: 0 };
    const n = this.size;
    const g = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevWay = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const h = (i) => this.dist(i, goal) / MAX_SPEED_MS;
    const heap = new MinHeap();
    g[start] = 0;
    heap.push(start, h(start));

    let startEdges = this.adj[start];
    if (opts.firstEdge) {
      const allowed = startEdges.filter(opts.firstEdge);
      if (allowed.length) startEdges = allowed;
    }

    while (heap.size) {
      const u = heap.pop();
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === goal) break;
      for (const e of u === start ? startEdges : this.adj[u]) {
        const cost = g[u] + e.cost + this.turnPenalty(prev[u], u, e.to);
        if (cost < g[e.to]) {
          g[e.to] = cost;
          prev[e.to] = u;
          prevWay[e.to] = e.way;
          heap.push(e.to, cost + h(e.to));
        }
      }
    }
    if (!closed[goal]) return null;

    const nodes = [];
    const ways = [];
    let length = 0;
    for (let v = goal; v !== start; v = prev[v]) {
      nodes.push(v);
      ways.push(prevWay[v]);
      length += this.dist(prev[v], v);
    }
    nodes.push(start);
    nodes.reverse();
    ways.reverse();
    return { nodes, ways, length, time: g[goal] };
  }

  /** Штраф (с) за маневр: розвороти дуже небажані, ліві повороти трохи дорожчі. */
  turnPenalty(from, via, to) {
    if (from < 0) return 0;
    if (from === to) return 120;
    if (this.majorDegree[via] < 3) return 0;
    const d = ((this.bearing(via, to) - this.bearing(from, via) + 540) % 360) - 180;
    if (Math.abs(d) < 30) return 0;
    return d < 0 ? 8 : 4;
  }

  /**
   * Куди приїде водій, якщо проґавив маневр у вузлі `via` (приїхавши з `from`)
   * і поїхав якомога прямо до наступного перехрестя.
   * Повертає { node, prevNode }.
   */
  continueStraight(from, via) {
    let prevNode = from;
    let cur = via;
    for (let guard = 0; guard < 10000; guard++) {
      const inBearing = this.bearing(prevNode, cur);
      let best = null;
      let bestDelta = Infinity;
      for (const e of this.adj[cur]) {
        if (e.to === prevNode) continue;
        const d = Math.abs(((this.bearing(cur, e.to) - inBearing + 540) % 360) - 180);
        if (d < bestDelta) { bestDelta = d; best = e; }
      }
      if (!best) return { node: cur, prevNode };
      prevNode = cur;
      cur = best.to;
      if (this.isJunction(cur)) return { node: cur, prevNode };
    }
    return { node: cur, prevNode };
  }
}

class MinHeap {
  constructor() {
    this.ids = [];
    this.keys = [];
  }

  get size() {
    return this.ids.length;
  }

  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop();
    const lastKey = keys.pop();
    const n = ids.length;
    if (n === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const c = l + 1 < n && keys[l + 1] < keys[l] ? l + 1 : l;
      if (keys[c] >= lastKey) break;
      ids[i] = ids[c];
      keys[i] = keys[c];
      i = c;
    }
    ids[i] = lastId;
    keys[i] = lastKey;
    return top;
  }
}
