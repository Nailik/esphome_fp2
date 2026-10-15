/*
 * fp-floorplan-card
 * Shows people detected by Aqara FP2 (and FP300) presence sensors on a floor
 * plan drawn to real dimensions. Display only: no zones, no editing.
 *
 * Plan coordinates are meters, origin at the top-left corner of the plan,
 * x to the right, y downwards.
 */

const FPF_VERSION = "0.1.0";

// Sensor types. Each knows its coverage shape and how to read people from HA.
const FPF_TYPES = {
  fp2: {
    fov: 120,
    range: 8,
    // FP2 wall mode: 14 x 14 cells of 0.5 m, sensor at the top centre.
    grid: { cols: 14, rows: 14, cell: 0.5 },
    unitsPerMeter: 100, // radar FW 100: 1 unit = 1 cm
    readTargets(hass, s) {
      const st = s.targets && hass.states[s.targets];
      if (!st) return [];
      return fpfDecodeFp2Targets(st.state);
    },
  },
  fp300: {
    fov: 120,
    range: 6,
    grid: null,
    unitsPerMeter: 100,
    readTargets() {
      return []; // presence only, no positions
    },
  },
};

const FPF_PALETTE = ["#3D6BE0", "#D99A1E", "#1E9C8A", "#C2417F", "#7A5AD6", "#7C9A2E"];

const FPF_FACING = { down: 0, left: 90, up: 180, right: 270 };

function fpfDecodeFp2Targets(b64) {
  if (!b64 || b64 === "unknown" || b64 === "unavailable") return [];
  let bin;
  try {
    bin = atob(b64);
  } catch (e) {
    return [];
  }
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const i16 = (o) => {
    const v = (b[o] << 8) | b[o + 1];
    return v > 32767 ? v - 65536 : v;
  };
  const out = [];
  const count = b.length ? b[0] : 0;
  for (let i = 0; i < count; i++) {
    const o = 1 + i * 14;
    if (o + 14 > b.length) break;
    out.push({ id: b[o], x: i16(o + 1), y: i16(o + 3) });
  }
  return out;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG_NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const fmt = (m) => `${m.toFixed(2)} m`;
const fpfEsc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

class FpFloorplanCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: "Floor plan",
      width: 10,
      height: 8,
      sensors: [{ type: "fp2", name: "Living room", targets: "sensor.test_fp2_targets", x: 5, y: 0.1, facing: "down" }],
    };
  }

  setConfig(config) {
    if (!(config.width > 0) || !(config.height > 0)) {
      throw new Error("Set width and height to the real size of the plan in meters, e.g. width: 11.3");
    }
    if (!Array.isArray(config.sensors) || config.sensors.length === 0) {
      throw new Error("Add at least one sensor under sensors:");
    }
    const sensors = config.sensors.map((s, i) => {
      const type = FPF_TYPES[(s.type || "fp2").toLowerCase()];
      if (!type) throw new Error(`Sensor ${i + 1}: unknown type "${s.type}". Use fp2 or fp300.`);
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) {
        throw new Error(`Sensor ${i + 1}: set x and y (meters from the top-left corner of the plan).`);
      }
      let rot = 0;
      if (typeof s.facing === "string") {
        if (!(s.facing in FPF_FACING)) throw new Error(`Sensor ${i + 1}: facing must be down, left, up, right or degrees.`);
        rot = FPF_FACING[s.facing];
      } else if (Number.isFinite(s.facing)) rot = s.facing;
      return {
        ...s,
        kind: (s.type || "fp2").toLowerCase(),
        type,
        name: s.name || `Sensor ${i + 1}`,
        rot,
        color: s.color || FPF_PALETTE[i % FPF_PALETTE.length],
        upm: s.units_per_meter || type.unitsPerMeter,
        mirror: s.mirror === true,
        range: s.range || type.range,
        fov: s.fov || type.fov,
      };
    });
    this._config = {
      grid: 0.5,
      trail: 4,
      show_sensor_grid: true,
      show_distance: true,
      ...config,
      sensors,
    };
    this._trails = sensors.map(() => []);
    this._lastState = sensors.map(() => null);
    if (this._built) this._buildStatic();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  // Sensor-local position (meters) -> plan position (meters)
  _toPlan(s, lx, ly) {
    const a = (s.rot * Math.PI) / 180;
    return {
      x: s.x + lx * Math.cos(a) - ly * Math.sin(a),
      y: s.y + lx * Math.sin(a) + ly * Math.cos(a),
    };
  }

  // Radar target -> sensor-local meters. Radar +X points to the viewer's left
  // when looking at the sensor from the room, i.e. the sensor's right.
  _targetLocal(s, t) {
    const lat = (-t.x / s.upm) * (s.mirror ? -1 : 1);
    return { lx: lat, ly: t.y / s.upm };
  }

  _build() {
    this._built = true;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ha-card { padding: 12px 12px 10px; }
        .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin: 0 4px 10px; }
        .title { font-size: 1.15rem; font-weight: 500; margin-right: auto; }
        .legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 0.85rem; color: var(--secondary-text-color); }
        .legend span { display: inline-flex; align-items: center; gap: 6px; }
        .legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
        .plan { position: relative; width: 100%; }
        svg { display: block; width: 100%; height: auto; touch-action: none; color: var(--primary-text-color);
              border-radius: 6px; background: var(--secondary-background-color, transparent); }
        .readout { min-height: 1.3em; margin: 8px 4px 0; font-size: 0.85rem; color: var(--secondary-text-color);
                   font-variant-numeric: tabular-nums; }
        .readout b { color: var(--primary-text-color); font-weight: 500; }
        .gl { stroke: currentColor; vector-effect: non-scaling-stroke; }
        text { fill: currentColor; }
      </style>
      <ha-card>
        <div class="head"><div class="title"></div><div class="legend"></div></div>
        <div class="plan"><svg></svg></div>
        <div class="readout">Point at the plan to measure.</div>
      </ha-card>`;
    this._svg = root.querySelector("svg");
    this._legend = root.querySelector(".legend");
    this._readout = root.querySelector(".readout");
    root.querySelector(".title").textContent = this._config.title || "";

    this._svg.addEventListener("pointermove", (e) => this._measure(e));
    this._svg.addEventListener("pointerdown", (e) => this._measure(e));
    this._svg.addEventListener("pointerleave", () => this._clearMeasure());

    this._ro = new ResizeObserver(() => {
      const w = this._svg.clientWidth;
      if (!w) return;
      const ppm = w / this._config.width;
      if (Math.abs(ppm - (this._ppm || 0)) > 0.01) {
        this._ppm = ppm;
        this._svg.style.fontSize = `${11 / ppm}px`; // 11 screen px, in plan units
        this._buildStatic();
        this._update(true);
      }
    });
    this._ro.observe(this._svg);
    this._ppm = 30;
    this._buildStatic();
  }

  _px(n) {
    return n / (this._ppm || 30); // screen pixels -> meters
  }

  _buildStatic() {
    const c = this._config;
    const svg = this._svg;
    if (!svg) return;
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${c.width} ${c.height}`);

    if (c.image) {
      el("image", { href: c.image, x: 0, y: 0, width: c.width, height: c.height, preserveAspectRatio: "none",
                    opacity: c.image_opacity ?? 0.85 }, svg);
    }

    // Measuring grid: minor every `grid` m, major every 1 m with labels.
    const g = el("g", {}, svg);
    const step = c.grid > 0 ? c.grid : 0.5;
    for (let x = 0; x <= c.width + 1e-9; x += step) {
      const major = Math.abs(x - Math.round(x)) < 1e-6;
      el("line", { class: "gl", x1: x, y1: 0, x2: x, y2: c.height, "stroke-opacity": major ? 0.28 : 0.1, "stroke-width": 1 }, g);
      if (major && x > 0 && x < c.width) el("text", { x: x + this._px(3), y: this._px(12), "font-size": "0.85em", opacity: 0.6 }, g).textContent = `${Math.round(x)}`;
    }
    for (let y = 0; y <= c.height + 1e-9; y += step) {
      const major = Math.abs(y - Math.round(y)) < 1e-6;
      el("line", { class: "gl", x1: 0, y1: y, x2: c.width, y2: y, "stroke-opacity": major ? 0.28 : 0.1, "stroke-width": 1 }, g);
      if (major && y > 0 && y < c.height) el("text", { x: this._px(3), y: y - this._px(3), "font-size": "0.85em", opacity: 0.6 }, g).textContent = `${Math.round(y)}`;
    }

    // Sensors: coverage fan, optional radar grid, marker and name.
    this._fans = [];
    c.sensors.forEach((s) => {
      const sg = el("g", { transform: `translate(${s.x} ${s.y}) rotate(${s.rot})` }, svg);
      const half = (s.fov / 2) * (Math.PI / 180);
      const p = (a) => `${(s.range * Math.sin(a)).toFixed(3)} ${(s.range * Math.cos(a)).toFixed(3)}`;
      const fan = el("path", {
        d: `M0 0 L${p(-half)} A${s.range} ${s.range} 0 0 0 ${p(half)} Z`,
        fill: s.color, "fill-opacity": 0.05, stroke: s.color, "stroke-opacity": 0.45, "stroke-width": 1,
        "vector-effect": "non-scaling-stroke", "stroke-dasharray": "4 4",
      }, sg);
      this._fans.push(fan);

      const gr = s.type.grid;
      if (gr && c.show_sensor_grid) {
        const w = (gr.cols * gr.cell) / 2;
        const h = gr.rows * gr.cell;
        const gg = el("g", { stroke: s.color, "stroke-opacity": 0.35, "stroke-width": 1 }, sg);
        for (let i = 0; i <= gr.cols; i++) {
          const x = -w + i * gr.cell;
          el("line", { x1: x, y1: 0, x2: x, y2: h, "vector-effect": "non-scaling-stroke" }, gg);
        }
        for (let j = 0; j <= gr.rows; j++) {
          el("line", { x1: -w, y1: j * gr.cell, x2: w, y2: j * gr.cell, "vector-effect": "non-scaling-stroke" }, gg);
        }
      }

      const r = this._px(6);
      el("circle", { r, fill: s.color, stroke: "var(--card-background-color, #fff)", "stroke-width": 2, "vector-effect": "non-scaling-stroke" }, sg);
      el("line", { x1: 0, y1: 0, x2: 0, y2: r * 2.6, stroke: s.color, "stroke-width": 2, "vector-effect": "non-scaling-stroke" }, sg);
      // Name goes behind the sensor (wall side), kept inside the plan.
      const behind = this._toPlan(s, 0, -this._px(16));
      const lx = Math.min(Math.max(behind.x, this._px(30)), c.width - this._px(30));
      const ly = Math.min(Math.max(behind.y, this._px(12)), c.height - this._px(4));
      const label = el("text", { x: lx, y: ly, "text-anchor": "middle", "font-weight": 500, fill: s.color }, svg);
      label.textContent = s.name;
    });

    this._targetLayer = el("g", {}, svg);
    this._cursorLayer = el("g", {}, svg);
  }

  _update(force) {
    if (!this._hass || !this._targetLayer) return;
    const c = this._config;
    const now = Date.now();
    const layer = this._targetLayer;
    layer.innerHTML = "";
    this._current = [];
    const legend = [];

    c.sensors.forEach((s, i) => {
      const pres = s.presence ? this._hass.states[s.presence] : null;
      const present = pres ? pres.state === "on" : null;
      let targets = present === false ? [] : s.type.readTargets(this._hass, s);

      const people = targets.map((t) => {
        const { lx, ly } = this._targetLocal(s, t);
        const p = this._toPlan(s, lx, ly);
        return { ...p, id: t.id, dist: Math.hypot(lx, ly) };
      });

      // Trail: remember positions for a few seconds to judge jitter.
      const key = JSON.stringify(people.map((p) => [p.x.toFixed(2), p.y.toFixed(2)]));
      if (key !== this._lastState[i]) {
        this._lastState[i] = key;
        people.forEach((p) => this._trails[i].push({ t: now, x: p.x, y: p.y }));
      }
      const keepMs = (c.trail || 0) * 1000;
      this._trails[i] = this._trails[i].filter((q) => now - q.t <= keepMs);
      this._trails[i].forEach((q) => {
        const age = (now - q.t) / (keepMs || 1);
        el("circle", { cx: q.x, cy: q.y, r: this._px(3), fill: s.color, "fill-opacity": 0.5 * (1 - age) }, layer);
      });

      const active = people.length > 0 || present === true;
      if (this._fans[i]) this._fans[i].setAttribute("fill-opacity", active ? 0.14 : 0.05);

      people.forEach((p) => {
        el("circle", { cx: p.x, cy: p.y, r: this._px(9), fill: s.color, stroke: "var(--card-background-color, #fff)",
                       "stroke-width": 2, "vector-effect": "non-scaling-stroke" }, layer);
        if (c.show_distance) {
          el("text", { x: p.x + this._px(13), y: p.y + this._px(4), "font-weight": 500 }, layer).textContent = fmt(p.dist);
        }
        this._current.push({ ...p, sensor: s });
      });

      let status;
      if (s.kind === "fp300" || (!s.targets && pres)) status = present ? "someone present" : "clear";
      else status = people.length === 1 ? "1 person" : `${people.length} people`;
      legend.push(`<span><i style="background:${fpfEsc(s.color)}"></i>${fpfEsc(s.name)}: ${status}</span>`);
    });

    const html = legend.join("");
    if (force || html !== this._legendHtml) {
      this._legendHtml = html;
      this._legend.innerHTML = html;
    }
  }

  _measure(e) {
    const ctm = this._svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const c = this._config;
    if (pt.x < 0 || pt.y < 0 || pt.x > c.width || pt.y > c.height) return this._clearMeasure();

    const L = this._cursorLayer;
    L.innerHTML = "";
    const line = { class: "gl", "stroke-opacity": 0.55, "stroke-width": 1, "stroke-dasharray": "3 3" };
    el("line", { ...line, x1: pt.x, y1: 0, x2: pt.x, y2: c.height }, L);
    el("line", { ...line, x1: 0, y1: pt.y, x2: c.width, y2: pt.y }, L);

    const dists = c.sensors
      .map((s) => `${fpfEsc(s.name)} <b>${fmt(Math.hypot(pt.x - s.x, pt.y - s.y))}</b>`)
      .join(", ");
    this._readout.innerHTML = `Point <b>${fmt(pt.x)}</b> from left, <b>${fmt(pt.y)}</b> from top. Distance to ${dists}`;
  }

  _clearMeasure() {
    if (this._cursorLayer) this._cursorLayer.innerHTML = "";
    if (this._readout) this._readout.textContent = "Point at the plan to measure.";
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
  }

  getCardSize() {
    return Math.ceil((this.offsetHeight || 400) / 50);
  }

  getGridOptions() {
    return { rows: "auto", columns: 12, min_columns: 6 };
  }
}

customElements.define("fp-floorplan-card", FpFloorplanCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "fp-floorplan-card",
  name: "FP floor plan",
  description: "People detected by Aqara FP2 and FP300 sensors on a floor plan in real dimensions.",
});
console.info(`fp-floorplan-card ${FPF_VERSION}`);
