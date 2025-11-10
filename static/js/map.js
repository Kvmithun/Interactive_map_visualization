// static/js/map.js — Enhanced Data-viz version (full file)
// Implements: color/size encoding, custom clusters, heatmap toggle, time slider, filters, search, legend, bookmarking, accessibility.

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
    const children = cluster.getAllChildMarkers();
    const sum = children.reduce((s, c) => s + (Number(c.options._meta?.value || 0)), 0);
    const count = children.length;
    const avg = count ? sum / count : 0;
    const color = getColorByValue(avg);
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
  const map = {
    "restaurant": "#1E88E5",
    "park": "#43A047",
    "shop": "#8E24AA",
    "transit": "#F4511E",
    "default": "#E53935" // default: red-ish to match user expectation
  };
  return map[cat] || map.default;
}

// sizedIconForValue uses an emoji pin (📍) with color tint and numeric badge
function sizedIconForValue(color, value, minSize = 28, maxSize = 72) {
  const maxValue = 1000; // adjust to your domain
  const v = Math.min(maxValue, Math.max(0, Number(value || 0)));
  const size = Math.round(minSize + (v / maxValue) * (maxSize - minSize));

  const badgeSize = Math.max(10, Math.round(size * 0.35));
  const emojiFontSize = Math.round(size * 0.6);

  const safeColor = String(color || "#E53935").replace(/"/g, "");

  const html = `
    <div class="emoji-marker-wrap" style="position:relative; width:${size}px; height:${size}px; display:flex; align-items:center; justify-content:center; transform:translateY(-10%);">
      <div style="position:absolute; width:${size}px; height:${size}px; border-radius:50%; background:${safeColor}; opacity:0.12; top:0; left:0; filter: blur(${Math.max(0, Math.round(size*0.06))}px)"></div>
      <div style="font-size:${emojiFontSize}px; line-height:1; transform:translateY(-6%);">
        📍
      </div>
      <div style="position:absolute; right:-6px; bottom:-6px; min-width:${badgeSize}px; height:${badgeSize}px; padding:2px ${Math.max(4, Math.round(badgeSize/3))}px; border-radius:${badgeSize}px; background:${safeColor}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:${Math.max(10, Math.round(badgeSize*0.6))}px; box-shadow:0 1px 2px rgba(0,0,0,0.2);">
        ${Math.round(Math.min(v,999))}
      </div>
    </div>
  `;

  return L.divIcon({
    html,
    className: "custom-emoji-marker",
    iconSize: [size, size],
    iconAnchor: [Math.round(size/2), size]
  });
}

// html-escaping
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
}

// -------------------- Create / update markers --------------------
function createMapMarker(obj, addToStore = true) {
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
  const marker = L.marker([o.lat, o.lng], { icon, title: o.label, keyboard: true, _meta: { id: o.id, value: o.value, category: o.category } });
  marker.meta = { id: o.id, color: o.color };
  marker.bindTooltip(escapeHtml(o.label || "(no label)"), { direction: "top", offset: [0,-8], permanent: false });
  marker.bindPopup(popupContent(o), { minWidth: 240 });

  marker.on("popupopen", (e) => {
    attachPopupHandlers(e.popup, o.id);
    if (typeof Chart !== "undefined") {
      const ctx = document.getElementById(`popup-chart-${o.id}`);
      if (ctx && ctx.getContext) {
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
  const store = markers.find(m => String(m.id) === sid);
  if (store) {
    Object.assign(store, { label: obj.label || store.label, color: obj.color || store.color, value: Number(obj.value || store.value), category: obj.category || store.category, timestamp: Number(obj.timestamp || store.timestamp) });
    saveToStorage();
    indexUpdate(store);
  }
  found.setIcon(sizedIconForValue(obj.color || found.meta.color || "#E53935", obj.value));
  found.setPopupContent(popupContent(obj));
  found.meta.color = obj.color;
}

// -------------------- Popup content & handlers --------------------
function popupContent(obj) {
  return `
    <div style="font-size:14px">
      <strong>${escapeHtml(obj.label || "(no label)")}</strong>
      <div style="margin-top:6px;font-size:12px;color:#666">Category: ${escapeHtml(obj.category || "N/A")} • Value: ${escapeHtml(String(obj.value || 0))}</div>
      <div style="margin-top:8px;"><label style="font-size:12px">Edit label</label><input id="popup-label-${obj.id}" value="${escapeHtml(obj.label||"")}" style="width:100%;padding:6px;margin-top:4px;border:1px solid #ddd;border-radius:4px" /></div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <input id="popup-value-${obj.id}" type="number" value="${escapeHtml(String(obj.value||0))}" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:4px" />
        <input id="popup-cat-${obj.id}" value="${escapeHtml(obj.category || "")}" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:4px" />
      </div>
      <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
        <label style="font-size:12px">Color</label>
        <input id="popup-color-${obj.id}" type="color" value="${escapeHtml(obj.color || '#E53935')}" style="width:44px;height:32px;border-radius:6px;border:1px solid #ddd;padding:2px" />
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
  const colorInput = document.getElementById(`popup-color-${sid}`);
  if (!saveBtn) return;

  saveBtn.onclick = () => {
    const m = markers.find(x => String(x.id) === sid);
    if (!m) return;
    m.label = labelInput.value;
    m.value = Number(valueInput.value || 0);
    m.category = catInput.value || m.category;
    m.color = (colorInput && colorInput.value) ? colorInput.value : getCategoryColor(m.category) || m.color;
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
  let toRemove = null;
  markersCluster.eachLayer(l => { if (l.meta && String(l.meta.id) === sid) toRemove = l; });
  if (toRemove) markersCluster.removeLayer(toRemove);
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
    if (typeof L.heatLayer === "undefined") { showToast("Heatmap plugin missing."); return; }
    const heatPoints = markers.map(m => [m.lat, m.lng, Math.max(0.5, Math.log10((m.value||1)+1))]);
    heatLayer = L.heatLayer(heatPoints, { radius: 25, blur: 20, maxZoom: 17 }).addTo(map);
  } else {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  }
}

// -------------------- Filters, Time slider & search --------------------
let currentFilters = { category: null, minValue: null, maxValue: null, timeRange: null, query: "" };

function applyFilters() {
  window.requestAnimationFrame(() => {
    // Clear cluster and re-add visible markers (we recreate temporary marker layers from stored marker objects)
    markersCluster.clearLayers();
    const visible = markers.filter(m => {
      if (currentFilters.category && String(m.category) !== String(currentFilters.category)) return false;
      if (currentFilters.minValue != null && m.value < currentFilters.minValue) return false;
      if (currentFilters.maxValue != null && m.value > currentFilters.maxValue) return false;
      if (currentFilters.timeRange && (m.timestamp < currentFilters.timeRange[0] || m.timestamp > currentFilters.timeRange[1])) return false;
      if (currentFilters.query && currentFilters.query.trim().length > 0) {
        if (typeof Fuse !== "undefined") {
          if (window.fuse) {
            const r = window.fuse.search(currentFilters.query).map(x=>x.item.id);
            return r.includes(m.id);
          } else {
            return (m.label||"").toLowerCase().includes(currentFilters.query.toLowerCase());
          }
        } else {
          return (m.label||"").toLowerCase().includes(currentFilters.query.toLowerCase());
        }
      }
      return true;
    });
    visible.forEach(v => createMapMarker(v, false));
    redrawList();
  });
}

// time slider init (requires noUiSlider if you want the fancy control)
function initTimeSlider(minTs, maxTs) {
  const sliderEl = document.getElementById("timeSlider");
  if (!sliderEl) return;
  if (typeof noUiSlider === "undefined") {
    const minInput = document.getElementById("timeMin");
    const maxInput = document.getElementById("timeMax");
    if (minInput) minInput.value = new Date(minTs).toISOString().slice(0,10);
    if (maxInput) maxInput.value = new Date(maxTs).toISOString().slice(0,10);
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
    const raw = sliderEl.noUiSlider.get(true);
    currentFilters.timeRange = [Math.min(raw[0], raw[1]), Math.max(raw[0], raw[1])];
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
  const colorInput = document.getElementById("markerColor");
  const selectedColor = (colorInput && colorInput.value) ? colorInput.value : getCategoryColor("default");
  const obj = { id: uid(), lat, lng, label, color: selectedColor, category: "default", value: 1, timestamp: Date.now() };
  createMapMarker(obj, true);
  showToast(`Marker added: ${label}`);
});

// Add button handler (reads color input)
(function wireAddButton() {
  const addBtn = document.getElementById("btn-add");
  if (!addBtn) return;
  addBtn.onclick = async () => {
    const latEl = document.getElementById("lat");
    const lngEl = document.getElementById("lng");
    const labelEl = document.getElementById("label");
    const catEl = document.getElementById("category");
    const valEl = document.getElementById("value");
    const lat = Number(latEl?.value);
    const lng = Number(lngEl?.value);
    let label = labelEl?.value || (await getPlaceName(lat,lng));
    const category = catEl?.value || "default";
    const value = Number(valEl?.value || 1);
    const colorInput = document.getElementById("markerColor");
    const selectedColor = (colorInput && colorInput.value) ? colorInput.value : getCategoryColor(category);
    if (!isFinite(lat) || !isFinite(lng)) { showToast("Enter valid coordinates"); return; }
    const obj = { id: uid(), lat, lng, label, color: selectedColor, category, value, timestamp: Date.now() };
    createMapMarker(obj, true);
    map.setView([lat,lng], 14);
    showToast(`Marker added: ${label}`);
  };
})();

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
  const basemapSelect = document.getElementById("basemapSelect");
  basemapSelect?.addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === currentBase) return;
    if (baseLayers[currentBase]) map.removeLayer(baseLayers[currentBase]);
    baseLayers[v].addTo(map); currentBase = v; showToast(`Basemap: ${v}`);
  });

  const heatToggle = document.getElementById("toggleHeat");
  heatToggle?.addEventListener("change", (e) => toggleHeat(e.target.checked));

  const catFilter = document.getElementById("filterCategory");
  catFilter?.addEventListener("change", (e) => { currentFilters.category = e.target.value || null; applyFilters(); });
  const minVal = document.getElementById("filterMinValue");
  minVal?.addEventListener("input", debounce((e) => { currentFilters.minValue = e.target.value ? Number(e.target.value) : null; applyFilters(); }, 200));

  initSearch();

  const now = Date.now();
  const minTs = markers.reduce((s,m)=>Math.min(s,m.timestamp||now), now);
  const maxTs = markers.reduce((s,m)=>Math.max(s,m.timestamp||now), now);
  initTimeSlider(minTs, maxTs);

  document.getElementById("btn-share")?.addEventListener("click", () => {
    const url = getMapStateUrl();
    navigator.clipboard?.writeText(url).then(()=> showToast("Link copied to clipboard"), ()=> { showToast("Failed to copy. Here: "+url); });
  });

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
  showToast("Hexbin layer requires d3-hexbin implementation (not included).");
}
function showChoropleth(geojson) {
  const choropleth = L.geoJSON(geojson, { style: f => ({ fillColor: getColorByValue(f.properties.value), fillOpacity:0.7, color:'#fff', weight:0.5 }) }).addTo(map);
  return choropleth;
}

// -------------------- Small utilities --------------------
function generateSampleSeries(len=20) { const a=[]; for(let i=0;i<len;i++) a.push(Math.round(Math.random()*50)); return a; }

// -------------------- DOMContentLoaded: wire UI, create search & color if missing, load saved --------------------
document.addEventListener("DOMContentLoaded", () => {
  wireUI();

  // create dynamic UI pieces if the HTML doesn't already include them:
  (function ensureSearchAndColorInputs() {
    const labelEl = document.getElementById("label");
    if (!labelEl) return;

    const parent = labelEl.parentElement || document.body;

    // create Search button under label (only if not present)
    if (!document.getElementById("btn-search")) {
      const searchBtn = document.createElement("button");
      searchBtn.id = "btn-search";
      searchBtn.type = "button";
      searchBtn.innerText = "Search";
      searchBtn.style.marginTop = "8px";
      searchBtn.style.padding = "8px 10px";
      searchBtn.style.borderRadius = "6px";
      searchBtn.style.background = "#10B981";
      searchBtn.style.color = "#fff";
      searchBtn.style.border = "none";
      searchBtn.style.cursor = "pointer";
      parent.appendChild(searchBtn);

      searchBtn.onclick = async () => {
        const q = (labelEl.value || "").trim();
        if (!q) { showToast("Enter address or place name to search."); return; }
        const found = markers.find(m => (m.label||"").toLowerCase() === q.toLowerCase()) || markers.find(m => (m.label||"").toLowerCase().includes(q.toLowerCase()));
        if (found) {
          map.setView([found.lat, found.lng], 15);
          let foundLayer = null;
          markersCluster.eachLayer(l => { if (l.meta && String(l.meta.id) === String(found.id)) foundLayer = l; });
          if (foundLayer) foundLayer.openPopup();
          showToast("Found existing marker & zoomed to it.");
          return;
        }
        try {
          const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=1`;
          const res = await fetch(url, { headers: { 'User-Agent': 'GeoInterfacePro/1.0 (contact@example.com)' }});
          if (!res.ok) throw new Error("Geocode failed");
          const arr = await res.json();
          if (!arr || arr.length === 0) { showToast("No results found."); return; }
          const r = arr[0];
          const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
          document.getElementById("lat").value = lat.toFixed(6);
          document.getElementById("lng").value = lng.toFixed(6);
          labelEl.value = r.display_name || q;
          map.setView([lat, lng], 14);
          showToast("Location found — coordinates filled. Press 'Add' to create marker.");
        } catch (e) {
          console.error(e);
          showToast("Search failed.");
        }
      };
    }

    // create color input if not present
    if (!document.getElementById("markerColor")) {
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.id = "markerColor";
      colorInput.value = "#E53935"; // default red
      colorInput.title = "Marker color";
      colorInput.style.marginLeft = "8px";
      const ref = document.getElementById("category") || labelEl;
      ref.parentElement?.appendChild(colorInput);
    }
  })();

  initFromSaved();
  restoreMapStateFromUrl();

  document.getElementById("lat") && (document.getElementById("lat").value = "40.7128");
  document.getElementById("lng") && (document.getElementById("lng").value = "-74.0060");
  document.getElementById("label") && (document.getElementById("label").value = "New York, NY");
  redrawList();
});

// -------------------- Search helper (Fuse) --------------------
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

