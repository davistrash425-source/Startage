// The "artifacts" skill: turns the model's structured data into a standalone
// HTML page (charts drawn with Chart.js). The web app shows it in a frame,
// and it is also saved to output/researcher/visuals/ to open in any browser.

export type VisualType = "bar_chart" | "line_chart" | "table" | "customer_profile";

export interface VisualSpec {
  filename?: string;
  title: string;
  key_takeaway?: string;
  visual_type: VisualType;
  chart?: {
    labels: string[];
    y_axis_label?: string;
    series: Array<{ name: string; values: Array<number | null>; estimated?: boolean }>;
  };
  table?: { columns: string[]; rows: string[][]; estimated_row_indexes?: number[] };
  profile?: { name?: string; summary?: string; fields: Array<{ label: string; value: string; estimated?: boolean }> };
  contains_estimates?: boolean;
  notes?: string[];
  sources?: Array<{ title: string; url?: string }>;
}

const PALETTE = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2"];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const safeUrl = (url: unknown) => (/^https?:\/\//i.test(String(url ?? "")) ? String(url) : null);

// Safe to drop inside a <script> tag.
const toScriptJson = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");

function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function validateVisual(input: Record<string, unknown>): VisualSpec {
  const spec = input as unknown as VisualSpec;
  if (!spec.title) throw new Error("title is required.");
  const type = spec.visual_type;
  if (type === "bar_chart" || type === "line_chart") {
    const labels = spec.chart?.labels;
    const series = spec.chart?.series;
    if (!Array.isArray(labels) || labels.length === 0) throw new Error("chart.labels is required for charts.");
    if (!Array.isArray(series) || series.length === 0) throw new Error("chart.series is required for charts.");
    series.forEach((s, i) => {
      if (!Array.isArray(s.values) || s.values.length !== labels.length) {
        throw new Error(`chart.series[${i}].values must have one value per label (${labels.length}).`);
      }
    });
  } else if (type === "table") {
    if (!spec.table?.columns?.length || !Array.isArray(spec.table.rows)) throw new Error("table.columns and table.rows are required.");
  } else if (type === "customer_profile") {
    if (!spec.profile?.fields?.length) throw new Error("profile.fields is required.");
  } else {
    throw new Error(`Unknown visual_type "${String(type)}".`);
  }
  return spec;
}

function chartBody(spec: VisualSpec) {
  const { labels, series, y_axis_label } = spec.chart!;
  const isLine = spec.visual_type === "line_chart";
  const datasets = series.map((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    return {
      label: s.estimated ? `${s.name} (est.)` : s.name,
      data: s.values.map((v) => (v === null || v === undefined ? null : Number(v))),
      borderColor: color,
      backgroundColor: s.estimated ? withAlpha(color, 0.3) : withAlpha(color, isLine ? 0.15 : 0.85),
      borderWidth: 2,
      borderDash: s.estimated ? [6, 4] : [],
      fill: false,
      tension: 0.25,
      spanGaps: true,
    };
  });
  const config = {
    type: isLine ? "line" : "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } },
      scales: { y: { beginAtZero: !isLine, title: { display: Boolean(y_axis_label), text: y_axis_label ?? "" } } },
    },
  };
  // If Chart.js can't load (offline or blocked), show the same numbers as a table instead.
  const fallback = tableBody({
    ...spec,
    table: {
      columns: ["", ...series.map((s) => (s.estimated ? `${s.name} (est.)` : s.name))],
      rows: labels.map((label, r) => [label, ...series.map((s) => (s.values[r] === null || s.values[r] === undefined ? "-" : String(s.values[r])))]),
    },
  }).html;
  return {
    html: `<div class="chart" id="chart-box"><canvas id="chart"></canvas></div><div id="chart-fallback" hidden><p class="legend-note">The chart could not load, so here are the numbers.</p>${fallback}</div>`,
    script: `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
  if (window.Chart) {
    const cfg = ${toScriptJson(config)};
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    Chart.defaults.color = dark ? "#cbd5e1" : "#334155";
    Chart.defaults.borderColor = dark ? "rgba(148,163,184,0.2)" : "rgba(15,23,42,0.08)";
    new Chart(document.getElementById("chart"), cfg);
  } else {
    document.getElementById("chart-box").hidden = true;
    document.getElementById("chart-fallback").hidden = false;
  }
</script>`,
  };
}

function tableBody(spec: VisualSpec) {
  const { columns, rows, estimated_row_indexes = [] } = spec.table!;
  const est = new Set(estimated_row_indexes);
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .map((row, i) => `<tr class="${est.has(i) ? "est" : ""}">${(row ?? []).map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`)
    .join("");
  return { html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`, script: "" };
}

function profileBody(spec: VisualSpec) {
  const { name, summary, fields } = spec.profile!;
  const items = fields
    .map(
      (f) =>
        `<div class="field${f.estimated ? " est" : ""}"><dt>${esc(f.label)}${f.estimated ? ' <span class="tag">est.</span>' : ""}</dt><dd>${esc(f.value)}</dd></div>`
    )
    .join("");
  return {
    html: `<div class="profile">${name ? `<h2>${esc(name)}</h2>` : ""}${summary ? `<p class="summary">${esc(summary)}</p>` : ""}<dl>${items}</dl></div>`,
    script: "",
  };
}

/** Render a validated visual as a complete HTML page. */
export function renderVisualHtml(spec: VisualSpec, createdAt: string): string {
  const body =
    spec.visual_type === "table" ? tableBody(spec) : spec.visual_type === "customer_profile" ? profileBody(spec) : chartBody(spec);

  const notes = (spec.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("");
  const sources = (spec.sources ?? [])
    .map((s) => {
      const url = safeUrl(s.url);
      return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.title || url)}</a>` : esc(s.title)}</li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title)}</title>
<style>
  :root { --bg:#f8fafc; --card:#ffffff; --text:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#2563eb; --est:#fef3c7; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b1120; --card:#111827; --text:#e2e8f0; --muted:#94a3b8; --line:#1f2937; --accent:#60a5fa; --est:#3a2f12; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 900px; margin: 0 auto; padding: 24px 16px 32px; }
  h1 { font-size: 24px; line-height:1.2; margin: 0 0 8px; }
  .takeaway { font-size:17px; color:var(--muted); margin:0 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }
  .chart { position:relative; height:340px; }
  [hidden] { display:none !important; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:15px; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:14px; color:var(--muted); font-weight:600; }
  tr.est td { background:var(--est); }
  .profile h2 { margin:0 0 4px; }
  .profile .summary { color:var(--muted); margin:0 0 16px; }
  .profile dl { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px; margin:0; }
  .field { border:1px solid var(--line); border-radius:10px; padding:12px; }
  .field.est { background:var(--est); border-style:dashed; }
  dt { font-size:13px; color:var(--muted); font-weight:600; }
  dd { margin:4px 0 0; }
  .tag { font-size:11px; padding:1px 6px; border-radius:999px; background:var(--est); border:1px dashed var(--muted); }
  .legend-note { font-size:13px; color:var(--muted); margin:12px 0 0; }
  section { margin-top:20px; }
  section h3 { font-size:15px; color:var(--muted); margin:0 0 8px; }
  ul { margin:0; padding-left:20px; }
  a { color:var(--accent); }
  footer { margin-top:24px; font-size:12px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>${esc(spec.title)}</h1>
  ${spec.key_takeaway ? `<p class="takeaway">${esc(spec.key_takeaway)}</p>` : ""}
  <div class="card">
    ${body.html}
    ${spec.contains_estimates ? `<p class="legend-note">Dashed lines, lighter bars and highlighted items are <strong>estimates</strong>, not verified figures.</p>` : ""}
  </div>
  ${notes ? `<section><h3>Notes</h3><ul>${notes}</ul></section>` : ""}
  ${sources ? `<section><h3>Sources</h3><ul>${sources}</ul></section>` : ""}
  <footer>Created ${esc(createdAt)} by the Startage Researcher.</footer>
</main>
${body.script}
<script>
  // Tell the app how tall this page is so its frame can fit it (no effect when opened directly).
  function reportHeight() {
    if (window.parent !== window) window.parent.postMessage({ type: "visual-height", height: Math.ceil(document.querySelector("main").getBoundingClientRect().bottom) }, "*");
  }
  window.addEventListener("load", reportHeight);
  window.addEventListener("message", (e) => { if (e.data && e.data.type === "visual-ping") reportHeight(); });
  new ResizeObserver(reportHeight).observe(document.body);
</script>
</body>
</html>`;
}
