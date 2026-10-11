const screens = [...document.querySelectorAll(".screen")];
const dockButtons = [...document.querySelectorAll(".site-nav button")];
const form = document.querySelector("#form");
const photoInput = document.querySelector("#photo");
const preview = document.querySelector("#preview");
const photoLabel = document.querySelector("#photo-label");
const locationText = document.querySelector("#location");
const profileLocation = document.querySelector("#profile-location");
const message = document.querySelector("#message");
const submit = document.querySelector("#submit");
const homeList = document.querySelector("#home-list");
const list = document.querySelector("#list");
const nearby = document.querySelector("#nearby");
const empty = document.querySelector("#empty");
const sheetToggle = document.querySelector("#sheet-toggle");

let position = null;
let reports = [];
let bins = [];
let filter = "all";
let nearbyMode = "reports";
let showReports = true;
let showHotspots = false;
let showBins = true;
let map;
let tourLayer = null;
let tourTimer = 0;
let tourFrame = 0;
let touring = false;
let reportMarkers;
let hotspotMarkers;
let binMarkers;
let meMarker;
let query = "";
let placeHit = null;
let placeMarker = null;
let placeTimer = 0;
const places = [
  { name: "Library", lat: 31.7071, lng: 76.5284 },
  { name: "Parvati hostel", lat: 31.7039508, lng: 76.5256693 },
  { name: "Satpura hostel", lat: 31.7135017, lng: 76.5254695 },
  { name: "Hostel block", lat: 31.7086, lng: 76.5279 },
  { name: "Mess", lat: 31.7074, lng: 76.5264 },
  { name: "Main gate", lat: 31.7064, lng: 76.5259 },
  { name: "Market", lat: 31.6906, lng: 76.5406 },
];
const PLACE_METRES = 400;
let mapStatus = "all";
let streets;
let satellite;

document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => show(button.dataset.go));
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((chip) => chip.classList.remove("active"));
    button.classList.add("active");
    renderLists();
  });
});

photoInput.addEventListener("change", () => {
  const file = photoInput.files[0];
  if (!file) return;
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  photoLabel.hidden = true;
});

if (sheetToggle) sheetToggle.addEventListener("click", () => nearby.classList.toggle("open"));
document.querySelector("#show-me").addEventListener("click", centerOnMe);
document.querySelector("#locate").addEventListener("click", centerOnMe);
document.querySelectorAll("[data-map-status]").forEach((button) => {
  button.addEventListener("click", () => {
    mapStatus = button.dataset.mapStatus;
    document.querySelectorAll("[data-map-status]").forEach((chip) => {
      chip.classList.toggle("on", chip === button);
    });
    renderNearby();
    drawMarkers();
  });
});
document.querySelector("#chip-reports").addEventListener("click", () => pickLayer("reports"));
document.querySelector("#chip-hotspots").addEventListener("click", () => pickLayer("hotspots"));
document.querySelector("#chip-bins").addEventListener("click", () => pickLayer("bins"));
document.querySelector("#open-nearest-bin").addEventListener("click", () => {
  const bin = nearestBin();
  if (bin) focusBin(bin.id);
});
const layersBtn = document.querySelector("#layers-btn");
if (layersBtn) layersBtn.addEventListener("click", () => {
  document.querySelector("#layers").hidden = false;
});
document.querySelector("#layers-close").addEventListener("click", () => {
  document.querySelector("#layers").hidden = true;
});
document.querySelector("#layers").addEventListener("click", (event) => {
  if (event.target.id === "layers") document.querySelector("#layers").hidden = true;
});
document.querySelector("#layer-reports").addEventListener("change", (event) => {
  showReports = event.target.checked;
  syncLayerChips();
  drawMarkers();
});
document.querySelector("#layer-hotspots").addEventListener("change", (event) => {
  showHotspots = event.target.checked;
  syncLayerChips();
  drawMarkers();
});
document.querySelector("#layer-bins").addEventListener("change", (event) => {
  showBins = event.target.checked;
  syncLayerChips();
  drawMarkers();
});

function show(name) {
  const target = name === "map" ? "home" : name;
  screens.forEach((screen) => screen.classList.toggle("active", screen.id === target));
  dockButtons.forEach((button) => button.classList.toggle("active", button.dataset.go === target));
  const guidePopup = document.querySelector("#guide-popup");
  const guideVideo = document.querySelector("#guide-video");
  if (guidePopup && guideVideo) {
    if (target === "chat") {
      guidePopup.hidden = false;
      guideVideo.currentTime = 0;
      guideVideo.play().catch(() => {});
    } else {
      guideVideo.pause();
      guidePopup.hidden = true;
    }
  }
  if (target === "home") showMap();
}

document.querySelector("#guide-gotit").addEventListener("click", () => {
  document.querySelector("#guide-video").pause();
  document.querySelector("#guide-popup").hidden = true;
});

function askLocation() {
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      position = pos.coords;
      const text = `Location ready: ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`;
      locationText.textContent = text;
      profileLocation.textContent = text;
      if (meMarker) meMarker.setLatLng([position.latitude, position.longitude]);
      renderNearby();
      renderNearestBin();
      if (map) drawMarkers();
    },
    () => {
      const text = "Location is off. Allow it in the browser, then reload.";
      locationText.textContent = text;
      profileLocation.textContent = text;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.classList.remove("error");
  if (!position) {
    message.textContent = "Location is still missing.";
    message.classList.add("error");
    return;
  }
  const body = new FormData(form);
  body.set("lat", String(position.latitude));
  body.set("lng", String(position.longitude));
  submit.disabled = true;
  message.textContent = "Saving…";
  try {
    const response = await fetch("/api/reports", { method: "POST", body });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not save");
    form.reset();
    preview.hidden = true;
    photoLabel.hidden = false;
    message.textContent = "";
    await loadReports();
    show("map");
    focusReport(payload.id);
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  } finally {
    submit.disabled = false;
  }
});

async function loadReports() {
  const response = await fetch("/api/reports");
  const payload = await response.json();
  reports = payload.reports || [];
  renderStats();
  renderLists();
  if (map) drawMarkers();
}

function visibleReports() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return reports.filter((report) => {
    if (filter === "noted") return Boolean(report.note);
    if (filter === "cleaned") return report.status === "cleaned";
    if (filter === "today") return new Date(report.createdAt) >= start;
    return true;
  });
}

function renderStats() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const values = {
    count: reports.length,
    noted: reports.filter((report) => report.note).length,
    today: reports.filter((report) => new Date(report.createdAt) >= start).length,
    cleaned: reports.filter((report) => isCleaned(report)).length,
    hotspots: clusterReports().length,
  };
  document.querySelectorAll("[data-stat]").forEach((node) => {
    node.textContent = values[node.dataset.stat];
  });
}

function matchesQuery(item) {
  if (!query) return true;
  return `${item.note || ""} ${item.name || ""}`.toLowerCase().includes(query);
}

function nearPlace(lat, lng) {
  if (!placeHit) return true;
  return distanceBetween(lat, lng, placeHit.lat, placeHit.lng) <= PLACE_METRES;
}

function bestPlace(text) {
  const hits = places.filter((place) => place.name.toLowerCase().includes(text));
  hits.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aRank = aName === text ? 0 : aName.startsWith(text) ? 1 : 2;
    const bRank = bName === text ? 0 : bName.startsWith(text) ? 1 : 2;
    return aRank - bRank || aName.length - bName.length;
  });
  return hits[0] || null;
}

function showPlaceResult(text) {
  const node = document.querySelector("#place-result");
  node.hidden = !text;
  node.textContent = text || "";
}

function choosePlace(place) {
  placeHit = place;
  const count = reports.filter((report) => nearPlace(report.lat, report.lng)).length;
  showPlaceResult(count
    ? `${place.name}. ${count} report${count === 1 ? "" : "s"} here.`
    : `${place.name}. No reports here.`);
  renderLists();
  if (!map) show("home");
  if (!map || touring) return;
  map.flyTo([place.lat, place.lng], 18, { duration: 0.45 });
  drawMarkers();
  if (placeMarker) placeMarker.openPopup();
}

async function lookupPlace(text) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(`${text} Hamirpur`)}`;
  try {
    const response = await fetch(url);
    const found = await response.json();
    const hit = found.find((item) => Math.abs(Number(item.lat) - 31.71) < 0.2 && Math.abs(Number(item.lon) - 76.53) < 0.2);
    if (!hit || document.querySelector("#place-search").value.trim().toLowerCase() !== text) return;
    choosePlace({ name: hit.display_name.split(",")[0], lat: Number(hit.lat), lng: Number(hit.lon) });
  } catch (error) {
    showPlaceResult("That place could not be found.");
  }
}

function matchesStatus(report) {
  if (mapStatus === "open") return !isCleaned(report);
  if (mapStatus === "cleaned") return isCleaned(report);
  return true;
}

function renderLists() {
  const shown = visibleReports();
  if (homeList) fillList(homeList, reports.filter(matchesQuery).slice(0, 6), true);
  fillList(list, shown, false);
  renderNearby();
  empty.hidden = shown.length > 0;
  list.hidden = shown.length === 0;
}

function fillList(target, items, compact) {
  target.innerHTML = "";
  if (!items.length && target === homeList) {
    target.innerHTML = '<li class="status">No reports yet. The camera button adds the first one.</li>';
    return;
  }
  for (const report of items) {
    const item = document.createElement("li");
    item.innerHTML = `
      <img src="${report.photoUrl}" alt="" />
      <div>
        <strong>${report.note || "Pile reported"}</strong>
        <p>${new Date(report.createdAt).toLocaleString()}</p>
        ${compact ? "" : `<p>${placeName(report.lat, report.lng)}</p>`}
        ${compact ? "" : cleanToggle(report)}
      </div>`;
    item.addEventListener("click", () => focusReport(report.id));
    target.appendChild(item);
  }
}

function showMap() {
  if (!map) {
    map = L.map("leaflet", { zoomControl: true }).setView([20.5, 78.9], 5);
    streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri",
    });
    map.zoomControl.setPosition("topright");
    reportMarkers = L.layerGroup().addTo(map);
    hotspotMarkers = L.layerGroup().addTo(map);
    binMarkers = L.layerGroup().addTo(map);
    map.on("click", clearTour);
    map.on("zoomend", placeMarkerPhotos);
  }
  setTimeout(() => map.invalidateSize(), 60);
  drawMarkers();
  if (touring) return;
  if (placeHit) {
    map.setView([placeHit.lat, placeHit.lng], 18);
    return;
  }
  frameWaste();
}

function frameWaste() {
  const points = reports
    .filter((report) => matchesStatus(report))
    .map((report) => [report.lat, report.lng]);
  if (points.length && map) {
    const spots = points.map((point) => L.latLng(point[0], point[1]));
    const lats = spots.map((spot) => spot.lat).sort((a, b) => a - b);
    const lngs = spots.map((spot) => spot.lng).sort((a, b) => a - b);
    const middle = L.latLng(lats[Math.floor(lats.length / 2)], lngs[Math.floor(lngs.length / 2)]);
    const nearby = spots.filter((spot) => middle.distanceTo(spot) < 500);
    const focus = nearby.length > 1 ? nearby : spots;
    map.fitBounds(L.latLngBounds(focus), {
      paddingTopLeft: [24, 76],
      paddingBottomRight: [150, 24],
      maxZoom: 17,
    });
    return;
  }
  if (position) map.setView([position.latitude, position.longitude], 16);
}

function pickLayer(mode) {
  nearbyMode = mode;
  if (mode === "reports") showReports = true;
  if (mode === "hotspots") showHotspots = true;
  if (mode === "bins") showBins = true;
  document.querySelector("#layer-reports").checked = showReports;
  document.querySelector("#layer-hotspots").checked = showHotspots;
  document.querySelector("#layer-bins").checked = showBins;
  document.querySelector("#show-me").classList.remove("picked");
  syncLayerChips();
  renderNearby();
  drawMarkers();
  if (mode === "reports") fitReports();
  else if (mode === "hotspots") fitHotspots();
  else fitBins();
}

function syncLayerChips() {
  document.querySelector("#chip-reports").classList.toggle("on", showReports);
  document.querySelector("#chip-hotspots").classList.toggle("on", showHotspots);
  document.querySelector("#chip-bins").classList.toggle("on", showBins);
  document.querySelector("#chip-reports").classList.toggle("picked", nearbyMode === "reports");
  document.querySelector("#chip-hotspots").classList.toggle("picked", nearbyMode === "hotspots");
  document.querySelector("#chip-bins").classList.toggle("picked", nearbyMode === "bins");
}

function priorityOf(report) {
  const note = (report.note || "").toLowerCase();
  if (/block|drain|flood|overflow|critical/.test(note)) return "critical";
  if (/pile|trash|dustbin|waste|garbage|overload|dump/.test(note)) return "high";
  return "normal";
}

function priorityLabel(level) {
  if (level === "critical") return "Critical";
  if (level === "high") return "High";
  return "Open";
}

function distanceMeters(lat, lng) {
  if (!position) return null;
  const earth = 6371000;
  const dLat = ((lat - position.latitude) * Math.PI) / 180;
  const dLng = ((lng - position.longitude) * Math.PI) / 180;
  const lat1 = (position.latitude * Math.PI) / 180;
  const lat2 = (lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(meters) {
  if (meters == null) return "";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function isCleaned(report) {
  return report.status === "cleaned";
}

function cleanToggle(report) {
  const on = isCleaned(report) ? "checked" : "";
  return `<label class="clean-toggle"><span>Cleaned</span><input type="checkbox" data-clean="${report.id}" ${on}></label>`;
}

async function markCleaned(id) {
  const response = await fetch(`/api/reports/${id}/clean`, { method: "POST" });
  const payload = await response.json();
  if (!response.ok) return;
  await loadReports();
  return payload;
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".clean-toggle")) event.stopPropagation();
}, true);

document.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.dataset.clean) return;
  markCleaned(input.dataset.clean);
});

function clusterReports() {
  const pending = reports.filter((report) => !isCleaned(report)).map((report) => ({ ...report }));
  const clusters = [];
  while (pending.length) {
    const seed = pending.shift();
    const group = [seed];
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const other = pending[index];
      const gap = distanceBetween(seed.lat, seed.lng, other.lat, other.lng);
      if (gap <= 400) group.push(pending.splice(index, 1)[0]);
    }
    if (group.length < 2) continue;
    const lat = group.reduce((sum, report) => sum + report.lat, 0) / group.length;
    const lng = group.reduce((sum, report) => sum + report.lng, 0) / group.length;
    const level = group.some((report) => priorityOf(report) === "critical") || group.length >= 4
      ? "critical"
      : "high";
    clusters.push({
      id: `hot-${seed.id}`,
      lat,
      lng,
      count: group.length,
      level,
      photoUrl: group[0].photoUrl,
      note: `${group.length} piles within 400 m`,
      createdAt: group.map((report) => report.createdAt).sort().at(-1),
    });
  }
  return clusters;
}

function distanceBetween(lat1, lng1, lat2, lng2) {
  const earth = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a1 = (lat1 * Math.PI) / 180;
  const a2 = (lat2 * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function placeName(lat, lng) {
  let best = places[0];
  let bestMetres = Infinity;
  for (const place of places) {
    const metres = distanceBetween(lat, lng, place.lat, place.lng);
    if (metres < bestMetres) {
      best = place;
      bestMetres = metres;
    }
  }
  return best ? best.name : "this area";
}

function nearestBin() {
  if (!bins.length) return null;
  return bins
    .map((bin) => ({ ...bin, meters: distanceMeters(bin.lat, bin.lng) }))
    .sort((a, b) => (a.meters ?? Infinity) - (b.meters ?? Infinity))[0];
}

function renderNearestBin() {
  const text = document.querySelector("#nearest-bin-text");
  const name = document.querySelector("#nearest-bin-name");
  const photo = document.querySelector("#nearest-bin-photo");
  const distanceNode = document.querySelector("#nearest-bin-distance");
  const bin = nearestBin();
  if (!bin) {
    name.textContent = "Nearest dustbin";
    text.textContent = "No dustbins on the map yet.";
    photo.removeAttribute("src");
    distanceNode.textContent = "";
    return;
  }
  photo.src = bin.photo;
  name.textContent = bin.name;
  text.textContent = "Throw trash here";
  distanceNode.textContent = formatDistance(bin.meters);
}

function renderNearby() {
  fillDistanceList(
    document.querySelector("#bin-list"),
    bins.filter((bin) => nearPlace(bin.lat, bin.lng)),
    (bin) => bin.name,
    (bin) => focusBin(bin.id),
    "No dustbins yet.",
    (bin) => bin.photo,
  );
  fillDistanceList(
    document.querySelector("#report-list"),
    reports.filter((report) => matchesStatus(report) && nearPlace(report.lat, report.lng)),
    (report) => report.note || "Pile reported",
    (report) => focusReport(report.id),
    "No reports yet.",
    (report) => report.photoUrl,
  );
}

function fillDistanceList(target, items, labelFor, onClick, emptyText, photoFor) {
  if (!target) return;
  target.innerHTML = "";
  const ranked = items
    .map((item) => ({ ...item, meters: distanceMeters(item.lat, item.lng) }))
    .sort((a, b) => (a.meters ?? Infinity) - (b.meters ?? Infinity));
  if (!ranked.length) {
    target.innerHTML = `<li class="status">${emptyText}</li>`;
    return;
  }
  for (const item of ranked) {
    const row = document.createElement("li");
    const distance = formatDistance(item.meters);
    const photo = photoFor ? photoFor(item) : "";
    row.innerHTML = `${photo ? `<img src="${photo}" alt="">` : ""}<strong>${labelFor(item)}</strong><span class="distance">${distance}</span>`;
    row.addEventListener("click", () => onClick(item));
    target.appendChild(row);
  }
}

const binGlyph = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h5v2H3V5h5l1-2zm-1 6h2v10H8V9zm4 0h2v10h-2V9zm4 0h2v10h-2V9z"/></svg>';

function markerIcon(kind, photo, cleaned) {
  const mark = cleaned ? '<i class="cleaned-mark">✓</i>' : "";
  const image = photo ? `<img src="${photo}" alt="">` : "";
  return L.divIcon({
    className: "pin-wrap",
    html: `<span class="pin ${kind}${cleaned ? " cleaned" : ""}"><i class="bin-pin">${binGlyph}</i>${image}${mark}</span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
  });
}

function iconForReport(report) {
  return markerIcon("report", report.photoUrl, isCleaned(report));
}

function iconForHotspot(spot) {
  return markerIcon("hot", spot.photoUrl, false);
}

function iconForBin(bin) {
  return markerIcon("bin", bin.photo, false);
}

function placeMarkerPhotos() {
  if (!map) return;
  for (const group of [reportMarkers, hotspotMarkers, binMarkers]) {
    if (!group) continue;
    group.eachLayer((layer) => {
      const element = layer.getElement();
      if (!element) return;
      element.style.overflow = "visible";
      const image = element.querySelector("img");
      if (image) image.style.transform = "";
      const pin = element.querySelector(".pin");
      if (pin) pin.style.transform = "";
    });
  }
}

function drawMarkers() {
  if (!reportMarkers || !hotspotMarkers || !binMarkers) return;
  reportMarkers.clearLayers();
  hotspotMarkers.clearLayers();
  binMarkers.clearLayers();
  if (showReports) {
    for (const report of reports.filter((report) => matchesStatus(report) && nearPlace(report.lat, report.lng))) {
      const marker = L.marker([report.lat, report.lng], { icon: iconForReport(report) })
        .bindPopup(`<strong>${report.note || "Reported pile"}</strong><br>${cleanToggle(report)}`);
      marker.reportId = report.id;
      marker.addTo(reportMarkers);
    }
  }
  if (showHotspots) {
    for (const spot of clusterReports().filter((spot) => nearPlace(spot.lat, spot.lng))) {
      const marker = L.marker([spot.lat, spot.lng], { icon: iconForHotspot(spot) })
        .bindPopup(`<strong>${spot.note}</strong><br>${priorityLabel(spot.level)} priority`);
      marker.hotspotId = spot.id;
      marker.addTo(hotspotMarkers);
    }
  }
  if (showBins) {
    for (const bin of bins.filter((bin) => nearPlace(bin.lat, bin.lng))) {
      const marker = L.marker([bin.lat, bin.lng], { icon: iconForBin(bin) })
        .bindPopup(`<strong>${bin.name}</strong><br>Throw trash here`);
      marker.binId = bin.id;
      marker.addTo(binMarkers);
    }
  }
  placeMarkerPhotos();
  if (placeHit) {
    const count = reports.filter((report) => nearPlace(report.lat, report.lng)).length;
    const label = `${placeHit.name}<br>${count ? `${count} report${count === 1 ? "" : "s"} here` : "No reports here"}`;
    if (!placeMarker) {
      placeMarker = L.marker([placeHit.lat, placeHit.lng], {
        icon: markerIcon("bin", "", false),
      }).bindPopup(label).addTo(map);
    } else {
      placeMarker.setLatLng([placeHit.lat, placeHit.lng]);
      placeMarker.setPopupContent(label);
      if (!map.hasLayer(placeMarker)) placeMarker.addTo(map);
    }
    placeMarker.openPopup();
  } else if (placeMarker) {
    map.removeLayer(placeMarker);
  }
  if (position) {
    if (!meMarker) {
      meMarker = L.circleMarker([position.latitude, position.longitude], {
        radius: 8,
        color: "#14804a",
        fillColor: "#7dffa8",
        fillOpacity: 0.9,
      }).addTo(map);
    } else {
      meMarker.setLatLng([position.latitude, position.longitude]);
    }
  }
}

function focusReport(id) {
  const report = reports.find((item) => item.id === id);
  if (!report) return;
  showReports = true;
  document.querySelector("#layer-reports").checked = true;
  nearbyMode = "reports";
  syncLayerChips();
  show("map");
  setTimeout(() => {
    drawMarkers();
    map.setView([report.lat, report.lng], 16);
    reportMarkers.eachLayer((layer) => {
      if (layer.reportId === id) layer.openPopup();
    });
  }, 80);
}

function focusHotspot(id) {
  const spot = clusterReports().find((item) => item.id === id);
  if (!spot) return;
  showHotspots = true;
  document.querySelector("#layer-hotspots").checked = true;
  nearbyMode = "hotspots";
  syncLayerChips();
  show("map");
  setTimeout(() => {
    drawMarkers();
    map.setView([spot.lat, spot.lng], 16);
    hotspotMarkers.eachLayer((layer) => {
      if (layer.hotspotId === id) layer.openPopup();
    });
  }, 80);
}

function focusBin(id) {
  const bin = bins.find((item) => item.id === id);
  if (!bin) return;
  showBins = true;
  document.querySelector("#layer-bins").checked = true;
  nearbyMode = "bins";
  syncLayerChips();
  show("map");
  setTimeout(() => {
    drawMarkers();
    map.setView([bin.lat, bin.lng], 17);
    binMarkers.eachLayer((layer) => {
      if (layer.binId === id) layer.openPopup();
    });
    renderNearby();
  }, 80);
}

function fitBins() {
  if (!map || !bins.length) return;
  const bounds = L.latLngBounds(bins.map((bin) => [bin.lat, bin.lng]));
  map.fitBounds(bounds.pad(0.4));
}

function centerOnMe() {
  document.querySelector("#show-me").classList.add("picked");
  if (!position) {
    askLocation();
    return;
  }
  show("map");
  setTimeout(() => map.setView([position.latitude, position.longitude], 16), 80);
}

function fitHotspots() {
  const spots = clusterReports();
  if (!map || !spots.length) return;
  const bounds = L.latLngBounds(spots.map((spot) => [spot.lat, spot.lng]));
  map.fitBounds(bounds.pad(0.4));
}

function fitReports() {
  if (!map || !reports.length) return;
  const bounds = L.latLngBounds(reports.map((report) => [report.lat, report.lng]));
  map.fitBounds(bounds.pad(0.3));
}

const thread = document.querySelector("#thread");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatFile = document.querySelector("#chat-file");
const chatPreview = document.querySelector("#chat-preview");
const chatPreviewImg = document.querySelector("#chat-preview-img");
let chatPhoto = null;

document.querySelector("#chat-photo").addEventListener("click", () => chatFile.click());
chatFile.addEventListener("change", () => {
  const file = chatFile.files && chatFile.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 4_000_000) {
    addBubble("assistant", "Choose a photo under 4 MB.");
    chatFile.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    chatPhoto = { mime: file.type || "image/jpeg", data: url.slice(url.indexOf(",") + 1), url };
    chatPreviewImg.src = url;
    chatPreview.hidden = false;
  };
  reader.readAsDataURL(file);
});
document.querySelector("#chat-photo-clear").addEventListener("click", () => {
  chatPhoto = null;
  chatFile.value = "";
  chatPreview.hidden = true;
  chatPreviewImg.removeAttribute("src");
});

function clearTour() {
  window.clearTimeout(tourTimer);
  cancelAnimationFrame(tourFrame);
  const showing = touring || tourLayer;
  touring = false;
  if (tourLayer && map) {
    map.removeLayer(tourLayer);
    tourLayer = null;
  }
  const card = document.querySelector("#tour-card");
  if (card) card.hidden = true;
  if (showing && map) {
    map.closePopup();
    drawMarkers();
  }
}

function playTour(tour) {
  window.clearTimeout(tourTimer);
  cancelAnimationFrame(tourFrame);
  if (tourLayer && map) {
    map.removeLayer(tourLayer);
    tourLayer = null;
  }
  touring = true;
  show("home");
  setTimeout(() => runTourStep(tour, 0), 200);
}

function runTourStep(tour, index) {
  if (!touring) return;
  const step = tour[index];
  if (!map || !step) {
    touring = false;
    return;
  }
  map.invalidateSize();
  const card = document.querySelector("#tour-card");
  document.querySelector("#tour-label").textContent = step.label;
  document.querySelector("#tour-detail").textContent = step.detail;
  card.hidden = false;
  if (!tourLayer) tourLayer = L.layerGroup().addTo(map);
  if (step.kind === "route") {
    drawRoute(step.stops || [], () => {
      if (!touring || index + 1 >= tour.length) return;
      tourTimer = window.setTimeout(() => runTourStep(tour, index + 1), 800);
    });
    return;
  }
  if (step.kind === "pile") showTourPile(step.id);
  if (index + 1 < tour.length) tourTimer = window.setTimeout(() => runTourStep(tour, index + 1), 5000);
}

function addRouteStop(item, number) {
  L.marker([item.lat, item.lng], {
    icon: L.divIcon({
      className: "pin-wrap",
      html: `<span class="route-stop">${number}</span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
    zIndexOffset: 1200,
    interactive: false,
  }).addTo(tourLayer);
}

function drawRoute(stops, done) {
  if (stops.length < 2) {
    stops.forEach((item, index) => addRouteStop(item, index + 1));
    if (done) done();
    return;
  }
  const latlngs = stops.map((item) => [item.lat, item.lng]);
  map.fitBounds(L.latLngBounds(latlngs).pad(0.4), {
    paddingTopLeft: [24, 90],
    paddingBottomRight: [24, 24],
  });
  if (!map.getPane("route")) {
    const pane = map.createPane("route");
    pane.style.zIndex = "450";
  }
  const routeLine = { pane: "route", lineCap: "round", lineJoin: "round" };
  const casing = L.polyline([latlngs[0]], { ...routeLine, color: "#ffffff", weight: 12 }).addTo(tourLayer);
  const line = L.polyline([latlngs[0]], { ...routeLine, color: "#e10600", weight: 7 }).addTo(tourLayer);
  addRouteStop(stops[0], 1);
  let segment = 0;

  function drawSegment() {
    if (!touring) return;
    if (segment >= latlngs.length - 1) {
      if (done) done();
      return;
    }
    const from = latlngs[segment];
    const to = latlngs[segment + 1];
    const fromName = stops[segment].name || `Stop ${segment + 1}`;
    const toName = stops[segment + 1].name || `Stop ${segment + 2}`;
    document.querySelector("#tour-detail").textContent = `${fromName} to ${toName}`;
    const started = performance.now();
    function frame(now) {
      if (!touring) return;
      const t = Math.min(1, (now - started) / 1200);
      const point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      const drawn = latlngs.slice(0, segment + 1).concat([point]);
      casing.setLatLngs(drawn);
      line.setLatLngs(drawn);
      if (t < 1) {
        tourFrame = requestAnimationFrame(frame);
        return;
      }
      addRouteStop(stops[segment + 1], segment + 2);
      segment += 1;
      tourTimer = window.setTimeout(drawSegment, 350);
    }
    tourFrame = requestAnimationFrame(frame);
  }

  drawSegment();
}

function showTourPile(id) {
  const report = reports.find((item) => item.id === id);
  if (!report) return;
  L.circle([report.lat, report.lng], {
    radius: 28,
    color: "#e10600",
    weight: 3,
    fillColor: "#ffb4b4",
    fillOpacity: 0.35,
  }).addTo(tourLayer);
  reportMarkers.eachLayer((layer) => {
    if (layer.reportId !== id) return;
    layer.setPopupContent(`<strong>This is the pile</strong><br>${report.note || "Reported pile"}<br>Send it to biogas.`);
    layer.openPopup();
  });
}

function addBubble(role, text, imageUrl) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = "Added photo";
    bubble.appendChild(image);
  }
  if (text) bubble.appendChild(document.createTextNode(text));
  const empty = document.querySelector("#chat-empty");
  if (empty) empty.hidden = true;
  thread.appendChild(bubble);
  thread.scrollTop = thread.scrollHeight;
}

function askedText(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function wantsGuide(text) {
  return askedText(text).includes("guide my way");
}

function namedEnds(text) {
  const match = askedText(text).match(/\bfrom\s+(.+?)\s+to\s+(.+)$/);
  if (!match) return null;
  return { from: match[1].trim(), to: match[2].trim() };
}

function guideTour() {
  const order = ["waste-roadside", "waste-wet", "waste-wall", "waste-overflow"];
  const known = order.filter((id) => reports.some((item) => item.id === id));
  const rest = reports.filter((item) => !known.includes(item.id)).map((item) => item.id);
  const ids = known.concat(rest);
  const stops = ids.map((id, index) => {
    const report = reports.find((item) => item.id === id);
    return { lat: report.lat, lng: report.lng, name: `Pile ${index + 1}` };
  }).filter((stop) => Number.isFinite(stop.lat));
  if (stops.length < 2) return null;
  return [{
    kind: "route",
    label: "This is the way",
    detail: "Pile 1 to pile 2 to pile 3.",
    stops,
  }];
}

function routeStops(start, end) {
  return [
    { lat: start.lat, lng: start.lng, name: start.name },
    { lat: end.lat, lng: end.lng, name: end.name },
  ];
}

async function resolvePlace(raw) {
  const text = raw.replace(/^(the|a)\s+/, "").trim();
  if (!text) return null;
  const local = bestPlace(text);
  if (local) return local;
  const bin = bins.find((item) => {
    const name = item.name.toLowerCase().replace(" dustbin", "");
    return name.includes(text) || text.includes(name);
  });
  if (bin) return { name: bin.name.replace(/ dustbin$/i, ""), lat: bin.lat, lng: bin.lng };
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(`${text} Hamirpur`)}`;
  const response = await fetch(url);
  const found = await response.json();
  const hit = found.find((item) => Math.abs(Number(item.lat) - 31.71) < 0.25 && Math.abs(Number(item.lon) - 76.53) < 0.25);
  if (!hit) return null;
  return { name: hit.display_name.split(",")[0], lat: Number(hit.lat), lng: Number(hit.lon) };
}

document.addEventListener("click", () => {
  if (touring || tourLayer) clearTour();
}, true);

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  const photo = chatPhoto;
  if (!text && !photo) return;
  const message = text || "How much biogas can this pile generate?";
  addBubble("user", message, photo && photo.url);
  chatInput.value = "";
  if (photo) {
    chatPhoto = null;
    chatFile.value = "";
    chatPreview.hidden = true;
    chatPreviewImg.removeAttribute("src");
  }
  const ends = text ? namedEnds(text) : null;
  if (ends && !photo) {
    chatForm.querySelector("button[type=submit]").disabled = true;
    try {
      const start = await resolvePlace(ends.from);
      const end = await resolvePlace(ends.to);
      if (!start || !end) {
        addBubble("assistant", `I could not find ${!start ? ends.from : ends.to} on the map.`);
        return;
      }
      const stops = routeStops(start, end);
      addBubble("assistant", `The red line starts at ${start.name} and ends at ${end.name}. Click anywhere else and it goes away.`);
      playTour([{
        kind: "route",
        label: "This is the way",
        detail: `${start.name} to ${end.name}`,
        stops,
      }]);
    } catch (error) {
      addBubble("assistant", "That place could not be found.");
    } finally {
      chatForm.querySelector("button[type=submit]").disabled = false;
    }
    return;
  }
  if (!photo && wantsGuide(text)) {
    const tour = guideTour();
    if (!tour) {
      addBubble("assistant", "There are not enough piles yet to draw a way.");
      return;
    }
    const path = tour[0].stops.map((stop) => stop.name.toLowerCase()).join(" to ");
    addBubble("assistant", `The map is open. Follow the red line from ${path}. Click anywhere else and the line goes away.`);
    playTour(tour);
    return;
  }
  chatForm.querySelector("button[type=submit]").disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        image: photo ? { mime: photo.mime, data: photo.data } : undefined,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Chat failed");
    addBubble("assistant", payload.reply);
  } catch (error) {
    addBubble("assistant", error.message);
  } finally {
    chatForm.querySelector("button[type=submit]").disabled = false;
  }
});

async function loadBins() {
  const response = await fetch("/bins.json");
  bins = await response.json();
  renderNearestBin();
  renderNearby();
  if (map) drawMarkers();
}

document.querySelector("#place-search").addEventListener("input", (event) => {
  query = event.target.value.trim().toLowerCase();
  window.clearTimeout(placeTimer);
  if (!query) {
    placeHit = null;
    showPlaceResult("");
    renderLists();
    if (map) drawMarkers();
    return;
  }
  const local = bestPlace(query);
  if (local) {
    choosePlace(local);
    return;
  }
  showPlaceResult("Looking for that place…");
  placeTimer = window.setTimeout(() => lookupPlace(query), 400);
});
document.querySelector("#view-map").addEventListener("click", () => {
  if (!map) return;
  map.removeLayer(satellite);
  streets.addTo(map);
  document.querySelector("#view-map").classList.add("on");
  document.querySelector("#view-sat").classList.remove("on");
});
document.querySelector("#view-sat").addEventListener("click", () => {
  if (!map) return;
  map.removeLayer(streets);
  satellite.addTo(map);
  document.querySelector("#view-sat").classList.add("on");
  document.querySelector("#view-map").classList.remove("on");
});

const zoom = document.createElement("img");
zoom.className = "img-zoom";
zoom.alt = "";
zoom.hidden = true;
document.body.appendChild(zoom);

function zoomTarget(node) {
  return node instanceof Element ? node.closest(".pin img, .sheet img, .rows img, .side-list img") : null;
}

function placeZoom(event) {
  const pad = 12;
  const box = zoom.getBoundingClientRect();
  const width = box.width || 340;
  const height = box.height || 340;
  let x = event.clientX + 20;
  let y = event.clientY - height / 2;
  if (x + width > window.innerWidth - pad) x = event.clientX - width - 20;
  if (y < pad) y = pad;
  if (y + height > window.innerHeight - pad) y = window.innerHeight - height - pad;
  zoom.style.left = `${x}px`;
  zoom.style.top = `${y}px`;
}

document.addEventListener("mouseover", (event) => {
  const img = zoomTarget(event.target);
  if (!img || !img.getAttribute("src")) return;
  zoom.src = img.currentSrc || img.src;
  zoom.hidden = false;
  placeZoom(event);
});
document.addEventListener("mousemove", (event) => {
  if (zoom.hidden) return;
  if (!zoomTarget(event.target)) {
    zoom.hidden = true;
    return;
  }
  placeZoom(event);
});
document.addEventListener("mouseout", (event) => {
  const img = zoomTarget(event.target);
  if (!img) return;
  const next = event.relatedTarget;
  if (next instanceof Element && next.closest && zoomTarget(next) === img) return;
  zoom.hidden = true;
});

syncLayerChips();
askLocation();
loadReports().then(() => show("home"));
loadBins();
