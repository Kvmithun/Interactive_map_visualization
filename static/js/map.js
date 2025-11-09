// static/js/map.js — Enhanced Data-viz version
// Implements: color/size encoding, custom clusters, heatmap toggle, time slider, filters, search, legend, bookmarking, accessibility.
// NOTE: Optional libs: Chart.js, leaflet.heat, noUiSlider, Fuse.js — graceful degradation if absent.

// -------------------- Basic globals & helpers --------------------
const map = L.map("map", { zoomControl: false }).setView([40.7128, -74.0060], 12);
window.map = map;

const STORAGE_KEY = "leaflet_dataviz_markers_v2";
const uid = () => "m" + Math.random().toString(36).slice(2, 9);

// Base layers
const baseLayers = {
  osm: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map),
  carto: L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", { attribution: "&copy; CARTO", maxZoom: 19 }),
  sat: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution: "Tiles &copy; Esri", maxZoom: 19 }),
};
let currentBase = "osm";

// clustering (customized)
const markersCluster = L.markerClusterGroup({
  iconCreateFunction: (cluster) => {
    // compute aggregated metrics for cluster
    const children = cluster.getAllChildMarkers();
    // sum of "value" property
    const sum = children.reduce((s, c) => s + (Number(c.options._meta?.value || 0)), 0);
    const count = children.length;
    // choose color by avg value
    const avg = count ? sum / count : 0;
    const color = getColorByValue(avg);
    // size scales with count (bounded)
    const size = Math.min(60, 30 + Math.round(Math.log(count + 1) * 8));
    return L.divIcon({
      html: `<div class="cluster-bubble" aria-label="Cluster: ${count} items, sum ${sum}"><span>${count}</span></div>`,
      className: "cluster-icon",
      iconSize: [size, size]
    });
  },
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
});
map.addLayer(markersCluster);

// heat layer placeholder
let heatLayer = null;

// in-memory dataset (normalized)
let markers = []; // {id, lat, lng, label, color, category, value, timestamp, extra...}

// spatial index hook (use rbush if available — optional)
let spatialIndex = null;
if (typeof rbush !== "undefined") {
  spatialIndex = rbush();
}

// -------------------- Styling helpers --------------------
function getColorByValue(v) {
  // simple quantize palette (ColorBrewer-ish)
  if (v >= 1000) return "#800026";
  if (v >= 500) return "#BD0026";
  if (v >= 200) return "#E31A1C";
  if (v >= 100) return "#FC4E2A";
  if (v >= 50) return "#FD8D3C";
  if (v >= 20) return "#FEB24C";
  if (v >= 5) return "#FED976";
  return "#FFEDA0";
}
function getCategoryColor(cat) {
  // categories -> color map (extend as needed)
  const map = {
    "restaurant": "#1E88E5",
    "park": "#43A047",
    "shop": "#8E24AA",
    "transit": "#F4511E",
    "default": "#607D8B"
  };
  return map[cat] || map.default;
}
function sizedIconForValue(color, value, minSize = 28, maxSize = 72) {
  // linear scale on value (clamp)
  const maxValue = 1000; // adjust to your domain
  const v = Math.min(maxValue, Math.max(0, Number(value || 0)));
  const size = Math.round(minSize + (v / maxValue) * (maxSize - minSize));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><circle cx="12" cy="10" r="8" fill="${color}" stroke="#222" stroke-opacity="0.08"/><text x="12" y="15" font-size="${Math.round(size/4)}" fill="#fff" font-family="sans-serif" text-anchor="middle">${Math.round(Math.min(v,999))}</text></svg>`;
  return L.divIcon({ html: svg, className: "custom-marker", iconSize: [size, size], iconAnchor: [size/2, size] });
}

// html-escaping
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
}

// -------------------- Create / update markers --------------------
function createMapMarker(obj, addToStore = true) {
  // normalize
  const o = {
    id: String(obj.id || uid()),
    lat: Number(obj.lat),
    lng: Number(obj.lng),
    label: obj.label || "",
    color: obj.color || getCategoryColor(obj.category),
    category: obj.category || "default",
    value: Number(obj.value || 0),
    timestamp: Number(obj.timestamp || Date.now()),
    extra: obj.extra || {}
  };

  const icon = sizedIconForValue(o.color, o.value);
  // attach meta properties to marker options for cluster aggregation
  const marker = L.marker([o.lat, o.lng], { icon, title: o.label, keyboard: true, _meta: { id: o.id, value: o.value, category: o.category } });
  marker.meta = { id: o.id, color: o.color };
  marker.bindTooltip(escapeHtml(o.label || "(no label)"), { direction: "top", offset: [0,-8], permanent: false });
  marker.bindPopup(popupContent(o), { minWidth: 240 });

  marker.on("popupopen", (e) => {
    attachPopupHandlers(e.popup, o.id);
    // draw mini charts if Chart.js is available
    if (typeof Chart !== "undefined") {
      const ctx = document.getElementById(`popup-chart-${o.id}`);
      if (ctx && ctx.getContext) {
        // (example) generate sparkline from extra.timeseries or random placeholder
        const ts = o.extra.timeseries || generateSampleSeries();
        new Chart(ctx, { type: 'line', data: { labels: ts.map((_,i)=>i), datasets:[{ data: ts, fill: false, borderWidth: 1, pointRadius: 0 }] }, options: { responsive: false, plugins: { legend: { display: false }}, scales:{ x:{ display:false }, y:{ display:false } } } });
      }
    }
  });

  markersCluster.addLayer(marker);

  if (addToStore) {
    markers.push(o);
    saveToStorage();
    indexInsert(o);
    redrawList();
  }
  return marker;
}

function updateMarkerOnMap(obj) {
  const sid = String(obj.id);
  let found = null;
  markersCluster.eachLayer(l => { if (l.meta && String(l.meta.id) === sid) found = l; });
  if (!found) return;
  // update stored object
  const store = markers.find(m => String(m.id) === sid);
  if (store) {
    Object.assign(store, { label: obj.label || store.label, color: obj.color || store.color, value: Number(obj.value || store.value), category: obj.category || store.category, timestamp: Number(obj.timestamp || store.timestamp) });
    saveToStorage();
    indexUpdate(store);
  }
  // update icon and popup
  found.setIcon(sizedIconForValue(obj.color || found.meta.color || "#1E88E5", obj.value));
  found.setPopupContent(popupContent(obj));
  found.meta.color = obj.color;
}

// -------------------- Popup content & handlers --------------------
function popupContent(obj) {
  // include a small canvas placeholder for Chart.js
  return `
    <div style="font-size:14px">
      <strong>${escapeHtml(obj.label || "(no label)")}</strong>
      <div style="margin-top:6px;font-size:12px;color:#666">Category: ${escapeHtml(obj.category || "N/A")} • Value: ${escapeHtml(String(obj.value || 0))}</div>
      <div style="margin-top:8px;"><label style="font-size:12px">Edit label</label><input id="popup-label-${obj.id}" value="${escapeHtml(obj.label||"")}" style="width:100%;padding:6px;margin-top:4px;border:1px solid #ddd;border-radius:4px" /></div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <input id="popup-value-${obj.id}" type="number" value="${escapeHtml(String(obj.value||0))}" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:4px" />
        <input id="popup-cat-${obj.id}" value="${escapeHtml(obj.category || "")}" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:4px" />
      </div>
      <div style="margin-top:8px;"><canvas id="popup-chart-${obj.id}" width="200" height="60" aria-label="mini chart for ${escapeHtml(obj.label)}"></canvas></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="popup-save-${obj.id}" style="flex:1;padding:8px;border-radius:6px;background:#1E88E5;color:#fff">Save</button>
        <button id="popup-delete-${obj.id}" style="flex:1;padding:8px;border-radius:6px;background:#EF4444;color:#fff">Delete</button>
      </div>
    </div>
  `;
}

function attachPopupHandlers(popup, id) {
  const sid = String(id);
  const saveBtn = document.getElementById(`popup-save-${sid}`);
  const deleteBtn = document.getElementById(`popup-delete-${sid}`);
  const labelInput = document.getElementById(`popup-label-${sid}`);
  const valueInput = document.getElementById(`popup-value-${sid}`);
  const catInput = document.getElementById(`popup-cat-${sid}`);
  if (!saveBtn) return;

  saveBtn.onclick = () => {
    const m = markers.find(x => String(x.id) === sid);
    if (!m) return;
    m.label = labelInput.value;
    m.value = Number(valueInput.value || 0);
    m.category = catInput.value || m.category;
    m.color = getCategoryColor(m.category) || m.color;
    updateMarkerOnMap(m);
    try { popup._close(); } catch(e) {}
    redrawList();
    showToast("Marker updated.");
  };

  deleteBtn.onclick = () => {
    if (!confirm("Delete this marker?")) return;
    removeMarkerById(sid);
    try { popup._close(); } catch(e) {}
  };
}

// -------------------- Removal, storage, index --------------------
function removeMarkerById(id) {
  const sid = String(id);
  // remove layer
  let toRemove = null;
  markersCluster.eachLayer(l => { if (l.meta && String(l.meta.id) === sid) toRemove = l; });
  if (toRemove) markersCluster.removeLayer(toRemove);
  // remove from array
  markers = markers.filter(m => String(m.id) !== sid);
  saveToStorage();
  indexRemove(sid);
  redrawList();
  showToast("Marker deleted.");
}

function saveToStorage() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(markers)); } catch(e) { console.error("Save failed", e); }
}
function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map(p => ({ id:String(p.id), lat:Number(p.lat), lng:Number(p.lng), label:p.label||"", color:p.color||getCategoryColor(p.category), category:p.category||"default", value:Number(p.value||0), timestamp:Number(p.timestamp||Date.now()), extra:p.extra||{} }));
  } catch(e) { console.error("Load failed", e); return []; }
}

// simple spatial index wrappers (optional)
function indexInsert(o) { if (spatialIndex) spatialIndex.insert({ minX:o.lng, minY:o.lat, maxX:o.lng, maxY:o.lat, id: o.id }); }
function indexRemove(id) { if (spatialIndex) { const items = spatialIndex.all().filter(x => x.id === id); items.forEach(i=> spatialIndex.remove(i)); } }
function indexUpdate(o) { indexRemove(o.id); indexInsert(o); }

// -------------------- List UI & controls --------------------
function redrawList() {
  const list = document.getElementById("markerList");
  const listSection = document.querySelector('.list-section');
  if (!list) return;
  list.innerHTML = "";
  if (!markers || markers.length === 0) {
    list.innerHTML = '<div style="padding:8px;color:#9CA3AF;font-style:italic;">No markers yet.</div>';
    if (listSection) listSection.style.display = 'block';
    return;
  }
  if (listSection) listSection.style.display = 'block';

  // show summary & top N
  const sorted = markers.slice().sort((a,b)=>b.value-a.value).slice(0,50);
  sorted.forEach(m => {
    const el = document.createElement("div");
    el.className = "marker-item";
    el.style.display = "flex";
    el.style.justifyContent = "space-between";
    el.style.alignItems = "center";
    el.style.padding = "8px 0";
    el.style.borderBottom = "1px solid #F1F5F9";
    el.innerHTML = `
      <div style="flex:1">
        <div style="font-weight:600;color:${escapeHtml(m.color)}">${escapeHtml(m.label || "(No address)")}</div>
        <div style="font-size:11px;color:#666"> ${escapeHtml(m.category)} • ${Number(m.value).toFixed(2)} • ${new Date(m.timestamp).toLocaleString()}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button data-id="${m.id}" class="btn-zoom small" title="Zoom to marker">Zoom</button>
        <button data-id="${m.id}" class="btn-edit small" title="Open popup">Edit</button>
        <button data-id="${m.id}" class="btn-delete small" title="Delete">Del</button>
      </div>
    `;
    list.appendChild(el);
  });

  // attach events
  list.querySelectorAll(".btn-zoom").forEach(b => {
    b.onclick = (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      const m = markers.find(x => String(x.id) === String(id));
      if (!m) return;
      map.setView([m.lat, m.lng], 15);
      let found = null;
      markersCluster.eachLayer(l => { if (l.meta && String(l.meta.id) === String(id)) found = l; });
      if (found) found.openPopup();
    };
  });
  list.querySelectorAll(".btn-edit").forEach(b => {
    b.onclick = (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      const m = markers.find(x => String(x.id) === String(id));
      if (!m) return;
      let found = null;
      markersCluster.eachLayer(l => { if (l.meta && String(l.meta.id) === String(id)) found = l; });
      if (found) { map.setView([m.lat, m.lng], 15); found.openPopup(); }
    };
  });
  list.querySelectorAll(".btn-delete").forEach(b => {
    b.onclick = (e) => {
      const id = e.currentTarget.getAttribute("data-id");
      if (!confirm("Delete marker?")) return;
      removeMarkerById(id);
    };
  });
}

// -------------------- Heat, Hexbin, Choropleth toggles --------------------
function toggleHeat(enabled) {
  if (enabled) {
    // lazy create if plugin available
    if (typeof L.heatLayer === "undefined") { showToast("Heatmap plugin missing."); return; }
    const heatPoints = markers.map(m => [m.lat, m.lng, Math.max(0.5, Math.log10((m.value||1)+1))]);
    heatLayer = L.heatLayer(heatPoints, { radius: 25, blur: 20, maxZoom: 17 }).addTo(map);
  } else {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  }
}

// -------------------- Filters, Time slider & search --------------------
let currentFilters = { category: null, minValue: null, maxValue: null, timeRange: null, query: "" };

// apply filters: rebuild cluster layer (efficient approach: clear and add visible markers)
function applyFilters() {
  // debounce-friendly wrapper
  window.requestAnimationFrame(() => {
    markersCluster.clearLayers();
    const visible = markers.filter(m => {
      if (currentFilters.category && String(m.category) !== String(currentFilters.category)) return false;
      if (currentFilters.minValue != null && m.value < currentFilters.minValue) return false;
      if (currentFilters.maxValue != null && m.value > currentFilters.maxValue) return false;
      if (currentFilters.timeRange && (m.timestamp < currentFilters.timeRange[0] || m.timestamp > currentFilters.timeRange[1])) return false;
      if (currentFilters.query && currentFilters.query.trim().length > 0) {
        // if Fuse available, use it (but we pre-filtered markers outside)
        if (typeof Fuse !== "undefined") {
          // Fuse instance expected to be set as window.fuse
          if (window.fuse) {
            const r = window.fuse.search(currentFilters.query).map(x=>x.item.id);
            return r.includes(m.id);
          } else {
            // fallback simple substring
            return (m.label||"").toLowerCase().includes(currentFilters.query.toLowerCase());
          }
        } else {
          return (m.label||"").toLowerCase().includes(currentFilters.query.toLowerCase());
        }
      }
      return true;
    });
    // re-add visible markers (createMapMarker with addToStore=false to avoid duplicating storage)
    visible.forEach(v => createMapMarker(v, false));
    redrawList();
  });
}

// time slider init (requires noUiSlider if you want the fancy control)
function initTimeSlider(minTs, maxTs) {
  const sliderEl = document.getElementById("timeSlider");
  if (!sliderEl) return;
  if (typeof noUiSlider === "undefined") {
    // fallback: two inputs
    const minInput = document.getElementById("timeMin");
    const maxInput = document.getElementById("timeMax");
    if (minInput) minInput.value = new Date(minTs).toISOString().slice(0,10);
    if (maxInput) maxInput.value = new Date(maxTs).toISOString().slice(0,10);
    // attach change events to update currentFilters.timeRange then applyFilters
    [minInput, maxInput].forEach(inp => { if (inp) inp.onchange = () => {
      const a = new Date(minInput.value).getTime();
      const b = new Date(maxInput.value).getTime();
      currentFilters.timeRange = [Math.min(a,b), Math.max(a,b)];
      applyFilters();
    }});
    return;
  }
  noUiSlider.create(sliderEl, { start:[minTs, maxTs], connect:true, range:{ min: minTs, max: maxTs }, tooltips:[true,true], format:{ to: v => new Date(+v).toLocaleDateString(), from: v => Date.parse(v) } });
  sliderEl.noUiSlider.on("update", function(values, handle) {
    const raw = sliderEl.noUiSlider.get(true); // numeric values
    currentFilters.timeRange = [Math.min(raw[0], raw[1]), Math.max(raw[0], raw[1])];
    // throttle applying filters
    debounce(applyFilters, 150)();
  });
}

// search init using Fuse
function initSearch() {
  const searchEl = document.getElementById("searchInput");
  if (!searchEl) return;
  if (typeof Fuse !== "undefined") {
    const options = { keys: ["label", "category"], includeScore: true, threshold: 0.4 };
    window.fuse = new Fuse(markers, options);
  }
  searchEl.oninput = (e) => {
    const q = e.target.value;
    currentFilters.query = q;
    debounce(applyFilters, 120)();
  };
}

// -------------------- Bookmark / share state --------------------
function getMapStateUrl() {
  const c = map.getCenter();
  const filters = { ...currentFilters };
  return `${location.origin}${location.pathname}?lat=${c.lat.toFixed(6)}&lng=${c.lng.toFixed(6)}&z=${map.getZoom()}&filters=${encodeURIComponent(JSON.stringify(filters))}`;
}
function restoreMapStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const lat = parseFloat(params.get("lat")), lng = parseFloat(params.get("lng")), z = parseInt(params.get("z"));
  const filtersJson = params.get("filters");
  if (!Number.isNaN(lat) && !Number.isNaN(lng) && !Number.isNaN(z)) map.setView([lat,lng], z);
  if (filtersJson) {
    try { currentFilters = Object.assign(currentFilters, JSON.parse(decodeURIComponent(filtersJson))); } catch(e) {}
  }
}

// -------------------- Utility: toast & debounce --------------------
function showToast(msg) {
  const t = document.getElementById("toastNotification");
  if (!t) { console.log("TOAST:", msg); return; }
  t.innerText = msg;
  t.classList.add("show");
  setTimeout(()=> t.classList.remove("show"), 3000);
}
function debounce(fn, wait) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(()=>fn.apply(this,args), wait); };
}

// -------------------- Reverse geocoding (Nominatim) --------------------
async function getPlaceName(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'GeoInterfacePro/1.0 (contact@example.com)' } });
    if (!res.ok) throw new Error("Geocode failed");
    const j = await res.json();
    return (j.address && (j.address.city || j.address.town || j.address.village)) || j.display_name || "Unknown Location";
  } catch(e) { console.error(e); return "Lookup failed"; }
}

// -------------------- Init from storage --------------------
function initFromSaved() {
  const saved = loadFromStorage();
  if (!saved || saved.length === 0) {
    markers = [];
    redrawList();
    return;
  }
  markers = saved.slice();
  markers.forEach(m => createMapMarker(m, false));
  // init heat if toggled (read from UI)
  const heatToggle = document.getElementById("toggleHeat");
  if (heatToggle && heatToggle.checked) toggleHeat(true);
  redrawList();
}

// -------------------- Event listeners (map click, add marker, center, clear) --------------------
map.on("click", async (e) => {
  const lat = e.latlng.lat, lng = e.latlng.lng;
  const label = await getPlaceName(lat,lng);
  document.getElementById("lat").value = lat.toFixed(6);
  document.getElementById("lng").value = lng.toFixed(6);
  document.getElementById("label").value = label;
  const obj = { id: uid(), lat, lng, label, color: getCategoryColor("default"), category: "default", value: 1, timestamp: Date.now() };
  createMapMarker(obj, true);
  showToast(`Marker added: ${label}`);
});

const addBtn = document.getElementById("btn-add");
if (addBtn) addBtn.onclick = async () => {
  const lat = Number(document.getElementById("lat").value);
  const lng = Number(document.getElementById("lng").value);
  let label = document.getElementById("label").value || (await getPlaceName(lat,lng));
  const category = document.getElementById("category")?.value || "default";
  const value = Number(document.getElementById("value")?.value || 1);
  if (!isFinite(lat) || !isFinite(lng)) { showToast("Enter valid coordinates"); return; }
  const obj = { id: uid(), lat, lng, label, color: getCategoryColor(category), category, value, timestamp: Date.now() };
  createMapMarker(obj, true);
  map.setView([lat,lng], 14);
  showToast(`Marker added: ${label}`);
};

document.getElementById("btn-center")?.addEventListener("click", () => {
  if (!markers.length) { showToast("No markers to fit."); return; }
  const latlngs = markers.map(m => [m.lat, m.lng]);
  map.fitBounds(latlngs, { padding: [50,50] });
  showToast("Map fitted to markers.");
});

// clear all with confirmation
document.getElementById("btn-clear-all")?.addEventListener("click", () => {
  if (!markers.length) { showToast("No markers to clear."); return; }
  if (!confirm("Clear all markers?")) return;
  markersCluster.clearLayers(); markers = []; saveToStorage(); if (heatLayer) { map.removeLayer(heatLayer); heatLayer=null; } redrawList();
  showToast("All markers cleared.");
});

// -------------------- UI wiring for toggles, filters, legend, search, share --------------------
function wireUI() {
  // basemap selector
  const basemapSelect = document.getElementById("basemapSelect");
  basemapSelect?.addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === currentBase) return;
    if (baseLayers[currentBase]) map.removeLayer(baseLayers[currentBase]);
    baseLayers[v].addTo(map); currentBase = v; showToast(`Basemap: ${v}`);
  });

  // heat toggle
  const heatToggle = document.getElementById("toggleHeat");
  heatToggle?.addEventListener("change", (e) => toggleHeat(e.target.checked));

  // filter controls (category/value)
  const catFilter = document.getElementById("filterCategory");
  catFilter?.addEventListener("change", (e) => { currentFilters.category = e.target.value || null; applyFilters(); });
  const minVal = document.getElementById("filterMinValue");
  minVal?.addEventListener("input", debounce((e) => { currentFilters.minValue = e.target.value ? Number(e.target.value) : null; applyFilters(); }, 200));

  // search
  initSearch();

  // time slider: determine min/max from dataset
  const now = Date.now();
  const minTs = markers.reduce((s,m)=>Math.min(s,m.timestamp||now), now);
  const maxTs = markers.reduce((s,m)=>Math.max(s,m.timestamp||now), now);
  initTimeSlider(minTs, maxTs);

  // share/bookmark button
  document.getElementById("btn-share")?.addEventListener("click", () => {
    const url = getMapStateUrl();
    navigator.clipboard?.writeText(url).then(()=> showToast("Link copied to clipboard"), ()=> { showToast("Failed to copy. Here: "+url); });
  });

  // legend build
  buildLegend();
}

// small legend control
function buildLegend() {
  const holder = document.getElementById("legend");
  if (!holder) return;
  holder.innerHTML = "";
  const grades = [0,5,20,50,100,200,500,1000];
  grades.forEach(g => {
    const div = document.createElement("div");
    div.style.display="flex"; div.style.alignItems="center"; div.style.gap="8px"; div.style.marginBottom="4px";
    const sw = document.createElement("div");
    sw.style.width="18px"; sw.style.height="12px"; sw.style.background=getColorByValue(g+(g===0?0.1:0));
    div.appendChild(sw);
    const lab = document.createElement("div"); lab.style.fontSize="12px"; lab.style.color="#333"; lab.innerText = g;
    div.appendChild(lab);
    holder.appendChild(div);
  });
}

// -------------------- Heatmap & aggregation toggles (hexbin/choropleth placeholders) --------------------
function showHexbin() {
  // This is a placeholder — implement with d3-hexbin/turf to compute hex polygons and render GeoJSON
  showToast("Hexbin layer requires d3-hexbin implementation (not included).");
}
function showChoropleth(geojson) {
  // Accepts GeoJSON with aggregated property 'value' per feature
  const choropleth = L.geoJSON(geojson, { style: f => ({ fillColor: getColorByValue(f.properties.value), fillOpacity:0.7, color:'#fff', weight:0.5 }) }).addTo(map);
  return choropleth;
}

// -------------------- Small utilities --------------------
function generateSampleSeries(len=20) { const a=[]; for(let i=0;i<len;i++) a.push(Math.round(Math.random()*50)); return a; }

// -------------------- Init run on DOM load --------------------
document.addEventListener("DOMContentLoaded", () => {
  // wire controls
  wireUI();
  // load saved and rehydrate
  initFromSaved();
  // restore url state
  restoreMapStateFromUrl();
  // initial placeholder values
  document.getElementById("lat") && (document.getElementById("lat").value = "40.7128");
  document.getElementById("lng") && (document.getElementById("lng").value = "-74.0060");
  document.getElementById("label") && (document.getElementById("label").value = "New York, NY");
  redrawList();
});

// -------------------- Search helper (Fuse) --------------------
// Optionally you can call buildFuse() whenever data changes to refresh index
function buildFuse() {
  if (typeof Fuse === "undefined") return;
  window.fuse = new Fuse(markers, { keys: ["label", "category"], threshold: 0.4 });
}
function rebuildIndexes() { if (spatialIndex) { spatialIndex.clear(); markers.forEach(m => indexInsert(m)); } buildFuse(); }

// ensure indexes update when markers change
(function watchMarkers() {
  const origPush = markers.push.bind(markers);
  markers.push = function(...args) { const r = origPush(...args); rebuildIndexes(); return r; };
})();

