// Проста векторна карта на canvas, що малюється з дорожнього графа (тайли не потрібні).

const STYLE = {
  motorway: [5, '--road-major'], trunk: [5, '--road-major'], primary: [4, '--road-major'],
  secondary: [3.5, '--road-mid'], tertiary: [3, '--road-mid'],
};
const DEFAULT_STYLE = [2, '--road'];

export class MapView {
  constructor(canvas, graph, { onTap } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onTap = onTap;
    this.route = null;
    this.highlight = null; // [startIdx, endIdx] поточного кроку
    this.markers = {};
    this.pointers = new Map();
    this.setGraph(graph);
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setGraph(graph) {
    this.graph = graph;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (let i = 0; i < graph.size; i++) {
      minLat = Math.min(minLat, graph.lat[i]); maxLat = Math.max(maxLat, graph.lat[i]);
      minLon = Math.min(minLon, graph.lon[i]); maxLon = Math.max(maxLon, graph.lon[i]);
    }
    this.lat0 = (minLat + maxLat) / 2;
    this.lon0 = (minLon + maxLon) / 2;
    this.kx = 111320 * Math.cos((this.lat0 * Math.PI) / 180);
    this.ky = 110540;
    this.bounds = [minLat, minLon, maxLat, maxLon];
    this.pendingFit = this.bounds;
    this.resize();
  }

  /** Координати в метрах відносно центру карти. */
  project(lat, lon) {
    return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.ky];
  }

  unproject(x, y) {
    return [this.lat0 - y / this.ky, this.lon0 + x / this.kx];
  }

  toScreen(lat, lon) {
    const [x, y] = this.project(lat, lon);
    return [x * this.scale + this.tx, y * this.scale + this.ty];
  }

  fromScreen(sx, sy) {
    return this.unproject((sx - this.tx) / this.scale, (sy - this.ty) / this.scale);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.pendingFit && this.w > 10 && this.h > 10) {
      this.fit(this.pendingFit); // canvas щойно став видимим — застосовуємо відкладене вписування
    } else if (this.scale !== undefined) {
      this.draw();
    }
  }

  fit(bounds, pad = 30) {
    if (!(this.w > 10 && this.h > 10)) {
      this.pendingFit = bounds; // canvas поки прихований
      return;
    }
    this.pendingFit = null;
    const [minLat, minLon, maxLat, maxLon] = bounds;
    const [x1, y1] = this.project(maxLat, minLon);
    const [x2, y2] = this.project(minLat, maxLon);
    const w = Math.max(this.w - 2 * pad, 50);
    const h = Math.max(this.h - 2 * pad, 50);
    this.scale = Math.min(w / Math.max(x2 - x1, 50), h / Math.max(y2 - y1, 50));
    this.tx = this.w / 2 - ((x1 + x2) / 2) * this.scale;
    this.ty = this.h / 2 - ((y1 + y2) / 2) * this.scale;
    this.draw();
  }

  fitNodes(ids) {
    if (!ids.length) return;
    const g = this.graph;
    const lats = ids.map((i) => g.lat[i]);
    const lons = ids.map((i) => g.lon[i]);
    this.fit([Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)], 50);
  }

  setRoute(route) {
    this.route = route;
    this.highlight = null;
    this.draw();
  }

  setHighlight(range) {
    this.highlight = range;
    if (range && this.route) this.fitNodes(this.route.nodes.slice(range[0], range[1] + 1));
    else this.draw();
  }

  setMarker(key, nodeId) {
    if (nodeId == null || nodeId < 0) delete this.markers[key];
    else this.markers[key] = nodeId;
    this.draw();
  }

  draw() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.render();
    });
  }

  render() {
    const { ctx, graph: g } = this;
    const css = getComputedStyle(this.canvas);
    const color = (v) => css.getPropertyValue(v).trim();
    ctx.fillStyle = color('--map-bg');
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const zoom = Math.min(1.6, Math.max(0.5, this.scale * 2));
    for (const w of g.ways) {
      const [width, col] = STYLE[w.cls] || DEFAULT_STYLE;
      ctx.strokeStyle = color(col);
      ctx.lineWidth = width * zoom;
      this.pathOf(w.nodes);
      ctx.stroke();
    }

    if (this.route) {
      ctx.strokeStyle = color('--route');
      ctx.lineWidth = 6 * zoom;
      this.pathOf(this.route.nodes);
      ctx.stroke();
      if (this.highlight) {
        ctx.strokeStyle = color('--route-active');
        ctx.lineWidth = 8 * zoom;
        this.pathOf(this.route.nodes.slice(this.highlight[0], this.highlight[1] + 1));
        ctx.stroke();
      }
    }

    // Підписи вулиць при достатньому масштабі.
    if (this.scale > 0.6) {
      ctx.fillStyle = color('--map-label');
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const seen = new Set();
      for (const w of g.ways) {
        if (w.name < 0 || seen.has(w.name) || w.nodes.length < 2) continue;
        seen.add(w.name);
        const mid = Math.floor((w.nodes.length - 1) / 2);
        const [x1, y1] = this.toScreen(g.lat[w.nodes[mid]], g.lon[w.nodes[mid]]);
        const [x2, y2] = this.toScreen(g.lat[w.nodes[mid + 1]], g.lon[w.nodes[mid + 1]]);
        let a = Math.atan2(y2 - y1, x2 - x1);
        if (a > Math.PI / 2) a -= Math.PI;
        if (a < -Math.PI / 2) a += Math.PI;
        ctx.save();
        ctx.translate((x1 + x2) / 2, (y1 + y2) / 2);
        ctx.rotate(a);
        ctx.fillText(g.names[w.name], 0, -6);
        ctx.restore();
      }
    }

    const MARKER_COLORS = { from: '--marker-from', to: '--marker-to', step: '--marker-step' };
    for (const [key, id] of Object.entries(this.markers)) {
      const [x, y] = this.toScreen(g.lat[id], g.lon[id]);
      ctx.beginPath();
      ctx.arc(x, y, key === 'step' ? 10 : 8, 0, 2 * Math.PI);
      ctx.fillStyle = color(MARKER_COLORS[key] || '--marker-step');
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color('--map-bg');
      ctx.stroke();
    }
  }

  pathOf(ids) {
    const { ctx, graph: g } = this;
    ctx.beginPath();
    ids.forEach((id, i) => {
      const [x, y] = this.toScreen(g.lat[id], g.lon[id]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }

  zoomAt(factor, sx, sy) {
    const s = Math.min(50, Math.max(0.005, this.scale * factor));
    const f = s / this.scale;
    this.tx = sx - (sx - this.tx) * f;
    this.ty = sy - (sy - this.ty) * f;
    this.scale = s;
    this.draw();
  }

  bindEvents() {
    const c = this.canvas;
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, local(e));
      this.moved = 0;
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const [x, y] = local(e);
      const [px, py] = this.pointers.get(e.pointerId);
      if (this.pointers.size === 1) {
        this.tx += x - px;
        this.ty += y - py;
        this.moved += Math.abs(x - px) + Math.abs(y - py);
        this.pointers.set(e.pointerId, [x, y]);
        this.draw();
      } else if (this.pointers.size === 2) {
        const [other] = [...this.pointers.entries()].filter(([id]) => id !== e.pointerId);
        const [ox, oy] = other[1];
        const before = Math.hypot(px - ox, py - oy);
        const after = Math.hypot(x - ox, y - oy);
        this.pointers.set(e.pointerId, [x, y]);
        this.moved += 100;
        if (before > 0) this.zoomAt(after / before, (x + ox) / 2, (y + oy) / 2);
      }
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const wasSingle = this.pointers.size === 1;
      this.pointers.delete(e.pointerId);
      if (wasSingle && this.moved < 8 && e.type === 'pointerup' && this.onTap) {
        const [x, y] = local(e);
        this.onTap(...this.fromScreen(x, y));
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
}
