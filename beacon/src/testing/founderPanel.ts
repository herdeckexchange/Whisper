import type { BeaconDataPackage, DataPackageSection } from "../types/dataPackage.js";
import { DATA_PACKAGE_SECTIONS } from "../types/dataPackage.js";

/**
 * Founder-only testing panel.
 *
 * A development utility for inspecting what the Brain actually retrieved —
 * deliberately a single self-contained page with no build step, no framework,
 * and no styling opinions, so it can be dropped into the host app without
 * touching the existing UI, navigation, or any completed Phase 1 screen.
 *
 * Serve it only behind the same founder check the API routes use. It is a
 * debugging surface, not a product screen.
 */

export interface FounderPanelOptions {
  /** Base path the Brain routes are mounted at. */
  basePath?: string;
  /** Query parameter the host app's founder check reads, if any. */
  authQueryParam?: string;
}

export function renderFounderPanelHtml(opts: FounderPanelOptions = {}): string {
  const basePath = opts.basePath ?? "/api/brain";
  const authParam = opts.authQueryParam ?? "";

  // Values are embedded as JSON so a stray quote cannot break out of the script.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beacon Brain — Data Package Inspector</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  .sub { opacity: .7; margin: 0 0 1.25rem; font-size: .85rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-bottom: 1.25rem; }
  input, button { font: inherit; padding: .45rem .6rem; border-radius: 6px; border: 1px solid #8884; }
  button { cursor: pointer; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.25rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-weight: 600; opacity: .8; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .78rem; border: 1px solid #8886; }
  .fresh { background: #16a34a22; } .stale { background: #f59e0b22; }
  .delayed { background: #3b82f622; } .estimated { background: #a855f722; }
  .missing { background: #6b728022; } .failed { background: #dc262622; }
  .warn { padding: .5rem .75rem; border-left: 3px solid #f59e0b; margin-bottom: .4rem; font-size: .88rem; }
  .err { border-left-color: #dc2626; }
  pre { background: #8881; padding: .75rem; border-radius: 8px; overflow: auto; max-height: 28rem; font-size: .8rem; }
  .muted { opacity: .6; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .5rem; margin-bottom: 1.25rem; }
  .card { border: 1px solid #8883; border-radius: 8px; padding: .6rem .7rem; }
  .card .k { font-size: .75rem; opacity: .7; }
  .card .v { font-size: 1.05rem; font-weight: 600; }
</style>
</head>
<body>
<h1>Beacon Brain — Data Package Inspector</h1>
<p class="sub">Founder/development tool. Shows the normalized package, its providers, timestamps, freshness, missing fields, and provider errors.</p>

<form id="f">
  <input id="symbol" value="NVDA" size="10" aria-label="Symbol" placeholder="Symbol">
  <label><input type="checkbox" id="refresh"> force refresh (bypass cache)</label>
  <button type="submit">Fetch package</button>
  <button type="button" id="job">Run refresh job</button>
  <span id="status" class="muted"></span>
</form>

<div id="out"></div>

<script>
const BASE = ${JSON.stringify(basePath)};
const AUTH = ${JSON.stringify(authParam)};
const SECTIONS = ${JSON.stringify(DATA_PACKAGE_SECTIONS)};

function q(extra) {
  const p = new URLSearchParams(extra || {});
  // Carry whatever auth token the host app put in this page's own URL.
  if (AUTH) {
    const mine = new URLSearchParams(location.search).get(AUTH);
    if (mine) p.set(AUTH, mine);
  }
  const s = p.toString();
  return s ? "?" + s : "";
}

function esc(v) {
  return String(v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function fmt(v) {
  if (v === null || v === undefined) return '<span class="muted">null</span>';
  if (typeof v === "number") return esc(v.toLocaleString());
  return esc(v);
}

function render(pkg) {
  const s = pkg.marketSnapshot || {};
  const cards = [
    ["Price", s.price], ["Prev close", s.previousClose], ["Change", s.change],
    ["Change %", s.changePercent], ["Open", s.open], ["High", s.high], ["Low", s.low],
    ["Volume", s.volume], ["Avg volume", s.averageVolume],
    ["52w high", s.fiftyTwoWeekHigh], ["52w low", s.fiftyTwoWeekLow],
    ["Market cap", pkg.asset ? pkg.asset.marketCap : null],
  ].map(([k, v]) => '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + fmt(v) + '</div></div>').join("");

  const rows = SECTIONS.map(name => {
    const sec = pkg.sections[name] || {};
    return "<tr>"
      + "<td>" + esc(name) + "</td>"
      + "<td>" + (sec.ok ? "yes" : '<strong>no</strong>') + "</td>"
      + "<td>" + fmt(sec.providerName) + "</td>"
      + '<td><span class="pill ' + esc(sec.freshness || "missing") + '">' + esc(sec.freshness || "-") + "</span></td>"
      + "<td>" + fmt(sec.dataTimestamp) + "</td>"
      + "<td>" + fmt(sec.retrievedAt) + "</td>"
      + '<td class="muted">' + esc((sec.missingFields || []).join(", ") || "-") + "</td>"
      + "<td>" + (sec.error ? esc(sec.error) : '<span class="muted">-</span>') + "</td>"
      + "</tr>";
  }).join("");

  const warnings = (pkg.warnings || []).map(w =>
    '<div class="warn' + (w.code.includes("fail") ? " err" : "") + '"><strong>' + esc(w.section) + "</strong> ["
    + esc(w.code) + "] " + esc(w.message) + "</div>").join("") || '<p class="muted">No warnings.</p>';

  const sources = (pkg.sources || []).map(src =>
    "<tr><td>" + esc(src.providerName) + "</td><td>" + esc(src.healthStatus) + "</td><td>tier "
    + esc(src.reliabilityTier) + "</td><td>" + fmt(src.lastSuccessfulRefresh) + "</td><td>"
    + fmt(src.lastFailedRefresh) + "</td><td class=\"muted\">" + fmt(src.lastFailureReason) + "</td></tr>").join("");

  document.getElementById("out").innerHTML =
      "<h2>" + esc(pkg.symbol) + " " + (pkg.asset && pkg.asset.name ? "— " + esc(pkg.asset.name) : "")
    + ' <span class="pill">' + (pkg.complete ? "complete" : "partial") + "</span></h2>"
    + '<p class="muted">Generated ' + esc(pkg.generatedAt) + " · last successful refresh " + fmt(pkg.lastSuccessfulRefresh)
    + " · " + (pkg.historicalPrices || []).length + " bars · " + (pkg.news || []).length + " articles</p>"
    + '<div class="grid">' + cards + "</div>"
    + "<h3>Sections</h3><table><tr><th>Section</th><th>OK</th><th>Provider</th><th>Freshness</th>"
    + "<th>Data timestamp</th><th>Retrieved</th><th>Missing fields</th><th>Error</th></tr>" + rows + "</table>"
    + "<h3>Warnings</h3>" + warnings
    + "<h3>Sources</h3><table><tr><th>Provider</th><th>Health</th><th>Reliability</th><th>Last success</th>"
    + "<th>Last failure</th><th>Reason</th></tr>" + sources + "</table>"
    + "<h3>Raw normalized response</h3><pre>" + esc(JSON.stringify(pkg, null, 2)) + "</pre>";
}

async function load(e) {
  if (e) e.preventDefault();
  const status = document.getElementById("status");
  const symbol = document.getElementById("symbol").value.trim();
  status.textContent = "loading…";
  try {
    const extra = document.getElementById("refresh").checked ? { refresh: "true" } : {};
    const res = await fetch(BASE + "/assets/" + encodeURIComponent(symbol) + "/data-package" + q(extra));
    const body = await res.json();
    if (!res.ok) {
      document.getElementById("out").innerHTML = '<div class="warn err">' + esc(body.error || res.status) + "</div>";
      status.textContent = "";
      return;
    }
    render(body);
    status.textContent = "";
  } catch (err) {
    document.getElementById("out").innerHTML = '<div class="warn err">' + esc(err.message) + "</div>";
    status.textContent = "";
  }
}

document.getElementById("f").addEventListener("submit", load);
document.getElementById("job").addEventListener("click", async () => {
  const status = document.getElementById("status");
  status.textContent = "running job…";
  const res = await fetch(BASE + "/dev/refresh" + q(), { method: "POST" });
  const body = await res.json();
  status.textContent = res.ok ? "job done" : ("job failed: " + (body.error || res.status));
});

load();
</script>
</body>
</html>`;
}
