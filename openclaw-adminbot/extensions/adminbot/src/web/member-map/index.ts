// Standalone page for GET /lab_stats/member_map — the same member-map data the "Map" tab in the
// main console shows, but on its own URL and drawn on a real world map instead of the console's
// hand-rolled SVG projection.
//
// Uses Leaflet rather than a WebGL map (MapLibre/Mapbox GL): Leaflet draws with plain DOM/CSS and
// <img> raster tiles, so it renders for every visitor regardless of GPU/WebGL availability —
// unlike a WebGL map, which goes fully blank for anyone whose browser or environment doesn't
// expose hardware-accelerated WebGL (locked-down corporate machines, some VMs/remote desktops,
// browsers with acceleration turned off). That is not an edge case worth risking on a page other
// people in the lab will just click into.
//
// This page carries no session UI of its own; it just reflects whatever GET /member-map returns
// for the caller's cookie (or lack of one). That response comes in two shapes (see mock-service.ts
// for the actual gating): { mode: "summary", places: [...{ ...place, count }] } for anyone not
// signed in as an admin — headcounts per city, no names — and { mode: "full", places: [...{
// ...place, members }] } for an admin, with names. The page is public precisely because the
// summary shape has nothing identifying in it; showing names is the thing that stays gated.

export function renderMemberMapWebUi(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lab Member Map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #66717e;
      --line: #d8dee6;
      --accent: #176b87;
      --accent-strong: #0d4f66;
      --danger: #a83b38;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 18px 24px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    h1 { font-size: 18px; margin: 0; }
    .subtitle { color: var(--muted); font-size: 13px; }
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .button {
      appearance: none;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }
    .button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .button.primary:hover { background: var(--accent-strong); }
    .button:disabled { opacity: 0.6; cursor: default; }
    .status { font-size: 12px; color: var(--muted); }
    .status.error { color: var(--danger); }
    .status.ok { color: #1c7a4f; }
    #map { position: absolute; top: 61px; bottom: 0; left: 0; right: 0; background: #eef2f6; }
    /* Floats over the map rather than resizing it, since it's only ever open on demand — a
       click on a dot, or the "Places" toggle — not a permanent fixture of the page. */
    #sidebar {
      position: absolute;
      top: 61px;
      bottom: 0;
      right: 0;
      width: 340px;
      max-width: 88vw;
      overflow-y: auto;
      background: var(--panel);
      border-left: 1px solid var(--line);
      box-shadow: -6px 0 16px rgba(23, 32, 42, 0.12);
      padding: 16px;
      z-index: 400;
    }
    #sidebar .sidebar-head { display: flex; align-items: center; justify-content: space-between; margin: 0 0 10px; }
    #sidebar h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0; }
    #sidebar-close {
      appearance: none; border: 0; background: none; color: var(--muted); font-size: 18px;
      line-height: 1; cursor: pointer; padding: 2px 4px;
    }
    #sidebar-close:hover { color: var(--text); }
    .place-row {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    /* The row a marker click opened the sidebar to draw attention to. */
    .place-row.selected { border-color: var(--accent); background: #eaf3f6; }
    .place-row .head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .place-row strong { font-size: 14px; }
    .place-row .pill {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 8px;
      font-size: 12px;
      color: var(--muted);
    }
    .place-row .members { color: var(--muted); font-size: 12px; margin-top: 4px; }
    /* Recently-active faces per place. Overlapping like a classic avatar stack; a name only
       appears as a hover title on its circle, not as visible text next to the row. */
    .member-avatars { display: inline-flex; align-items: center; }
    .member-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      object-fit: cover;
      outline: 1.5px solid var(--panel);
      margin-left: -6px;
      font-size: 10px;
      font-weight: 600;
      color: var(--accent-strong);
      background: #dfeaee;
    }
    .member-avatar:first-child { margin-left: 0; }
    .member-avatar-more { margin-left: 4px; color: var(--muted); font-size: 12px; }
    .place-expand-btn {
      appearance: none;
      display: flex;
      align-items: center;
      gap: 4px;
      width: 100%;
      border: 0;
      background: none;
      color: var(--accent);
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      padding: 6px 0 0;
      margin-top: 4px;
      border-top: 1px solid var(--line);
      cursor: pointer;
    }
    .place-expand-btn:hover { color: var(--accent-strong); }
    .place-expand-caret { font-size: 15px; }
    .member-name-list {
      margin: 6px 0 0;
      padding: 0;
      list-style: none;
      color: var(--text);
      font-size: 12px;
    }
    .member-name-list li { padding: 1px 0; }
    .leaflet-popup-content { font-size: 13px; margin: 10px 12px; }
    .map-tooltip-title { font-weight: 600; font-size: 13.5px; margin-bottom: 4px; }
    .place-row sup, .map-tooltip-title sup { color: var(--muted); }
    .approx-footnote { font-size: 11px; color: var(--muted); margin: 4px 0 0; }
    .member-map-marker {
      border-radius: 50%;
      background: rgba(23, 107, 135, 0.75);
      border: 2px solid #176b87;
      cursor: pointer;
    }
    /* Country-level, from last-login geolocation rather than a real city — dashed and lighter
       so it never reads with the same confidence as an actual city-level dot. */
    .member-map-marker-approx {
      background: rgba(23, 107, 135, 0.35);
      border: 2px dashed #176b87;
    }
    #empty-state {
      position: absolute;
      top: 61px;
      left: 0;
      right: 0;
      bottom: 0;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px;
      /* Opaque: this sits on top of the map/sidebar and must fully block interaction with
         them while it's shown, not just visually hint that something's wrong underneath. */
      background: var(--bg);
      z-index: 500;
    }
    /* An ID selector otherwise outranks the UA stylesheet's [hidden]{display:none}, so without
       this the "display: flex" above would show this div even while the hidden attribute is
       set — permanently covering the map instead of only when there is something to say. */
    #empty-state:not([hidden]) {
      display: flex;
    }
    #empty-state p { max-width: 40ch; color: var(--muted); }
    @media (max-width: 760px) {
      /* A bottom sheet reads better than a narrow side strip once the sidebar is this close
         to full-width anyway. */
      #sidebar {
        top: auto; height: 55%; left: 0; width: auto; max-width: none;
        border-left: 0; border-top: 1px solid var(--line);
        box-shadow: 0 -6px 16px rgba(23, 32, 42, 0.12);
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Lab Member Map</h1>
      <div class="subtitle" id="map-count"></div>
    </div>
    <div class="toolbar">
      <span class="status" id="map-status"></span>
      <button class="button" id="map-places-toggle">Places</button>
      <button class="button" id="map-refresh">Refresh from Slack</button>
      <span class="status" id="directory-status"></span>
      <button class="button" id="directory-sync">Sync Slack IDs &amp; timezones</button>
      <a class="button primary" id="open-console" href="/adminbot" target="_top">Open console</a>
    </div>
  </header>
  <div id="map"></div>
  <div id="sidebar" hidden>
    <div class="sidebar-head">
      <h2>Places</h2>
      <button id="sidebar-close" type="button" aria-label="Close">&times;</button>
    </div>
    <div id="place-list"></div>
  </div>
  <div id="empty-state" hidden>
    <p>Nobody is placed yet. Members need a location on their profile, or a Slack profile to read one from.</p>
  </div>
  <script>
    // Redundant when this page is already the console's own Map tab (embedded by iframe) —
    // you'd be looking at a button to open the page you're looking at.
    if (window.self !== window.top) {
      document.getElementById("open-console").hidden = true;
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[ch]));
    }

    function setStatus(id, message, kind) {
      const el = document.getElementById(id);
      el.textContent = message || "";
      el.className = "status" + (kind ? " " + kind : "");
    }

    async function api(path, options) {
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        headers: options && options.body ? { "Content-Type": "application/json" } : undefined,
        ...options,
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(payload?.error?.message || payload?.error || "Request failed");
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    // The whole world, always — see renderPlaces, which deliberately never re-centers or
    // re-zooms the map to fit wherever members happen to be.
    const WORLD_VIEW = { center: [20, 0], zoom: 2 };

    // dragging (mouse hold-and-drag, or touch hold-and-drag) and wheel/pinch zoom are on by
    // default in Leaflet; left explicit here so a future edit does not silently drop them.
    const map = L.map("map", {
      center: WORLD_VIEW.center,
      zoom: WORLD_VIEW.zoom,
      dragging: true,
      scrollWheelZoom: true,
      touchZoom: true,
      doubleClickZoom: true,
    });
    // Esri's "National Geographic" basemap: free, no API key, single self-contained style (no
    // separate reference/labels layer needed, unlike the Canvas/Ocean sets tried earlier) —
    // labels consistently in English, same reasoning as those: pre-rendered image tiles with a
    // fixed style baked in, not something a CSS rule or request header can recolor or relabel.
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri, National Geographic, DeLorme, HERE, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA, iPC", maxZoom: 16 },
    ).addTo(map);

    let markers = [];
    let openPopup = null;
    let currentData = null;
    // Place keys whose sidebar row is showing every member instead of the capped 3, toggled by
    // that row's expand button. Kept outside buildSidebarHtml/avatarsHtml so both stay pure
    // functions of their arguments.
    const expandedPlaces = new Set();

    // The limit most recently logged-in members, most recent first. A member with no
    // last_login_at sorts after everyone who has one, rather than colliding at a fake epoch.
    function recentActiveMembers(members, limit) {
      return members.slice().sort(function (a, b) {
        if (!a.last_login_at && !b.last_login_at) return 0;
        if (!a.last_login_at) return 1;
        if (!b.last_login_at) return -1;
        return b.last_login_at.localeCompare(a.last_login_at);
      }).slice(0, limit || 3);
    }

    // Circular faces for a place's 3 most recently active members. Names live in each circle's
    // title tooltip (hover/focus) rather than as visible text, so the row/popup stays glanceable.
    // Always capped, even where a caller can also show the full name list (see nameListHtml) —
    // the point of the cap is the row staying scannable, not a shortage of space to fill.
    function avatarsHtml(members) {
      const shown = recentActiveMembers(members, 3);
      const circles = shown.map((m) => {
        const name = escapeHtml(m.name);
        return m.avatar_url
          ? '<img class="member-avatar" src="' + escapeHtml(m.avatar_url) + '" alt="" title="' + name + '">'
          : '<span class="member-avatar" title="' + name + '">' + escapeHtml((m.name || "?").slice(0, 1).toUpperCase()) + '</span>';
      }).join("");
      const more = members.length > shown.length ? '<span class="member-avatar-more">&hellip;</span>' : "";
      return '<span class="member-avatars">' + circles + more + '</span>';
    }

    // The readable list an expanded place row shows below its avatars — actual names, not more
    // circles someone would have to hover one at a time to read off. Alphabetical (the order the
    // service already sorts members in), since this is for finding a name, not for recency.
    function nameListHtml(members) {
      return '<ul class="member-name-list">' +
        members.map((m) => "<li>" + escapeHtml(m.name) + "</li>").join("") +
        "</ul>";
    }

    // Full mode has a "members" array per place (with names); summary mode has only a "count".
    // Every place-count read in this file goes through this rather than picking one field, so
    // there is exactly one place that knows how to read either shape.
    function placeCount(place) {
      return place.members ? place.members.length : place.count;
    }

    // Builds the sidebar's HTML without touching whether it's shown — the sidebar only opens on
    // demand (a marker click, or the "Places" toggle), not just because data loaded. Pure in
    // expandedKeys too, rather than reading the module-level expandedPlaces directly, so this
    // stays testable as a plain function of its inputs (see index.test.ts).
    function buildSidebarHtml(data, expandedKeys) {
      const isFull = data.mode === "full";
      const places = data.places || [];
      // A "country:"-keyed place came from last-login geolocation, which only ever gives a
      // country. Flagged with a single shared footnote rather than repeating the explanation
      // on every row/tooltip — a superscript asterisk is enough once the footnote defines it.
      let hasApprox = false;
      let html = places.map((place) => {
        const isApprox = place.key.startsWith("country:");
        if (isApprox) hasApprox = true;
        const expanded = isFull && expandedKeys.has(place.key);
        const canExpand = isFull && place.members.length > 3;
        // Its own row below the count, not squeezed inline with the avatars — a bigger target
        // that reads as "there's more here" rather than a stray mark next to the last face.
        const expandBtn = canExpand
          ? '<button type="button" class="place-expand-btn" data-key="' + escapeHtml(place.key) +
            '" aria-expanded="' + (expanded ? "true" : "false") + '">' +
            '<span class="place-expand-caret">' + (expanded ? "&#9652;" : "&#9662;") + '</span>' +
            (expanded ? "Show less" : "Show all " + place.members.length) +
            '</button>'
          : "";
        const detail = isFull ? escapeHtml(place.country) + ' · ' + avatarsHtml(place.members) : escapeHtml(place.country);
        return '<div class="place-row" data-key="' + escapeHtml(place.key) + '"><div class="head"><strong>' +
          escapeHtml(place.label) + (isApprox ? "<sup>*</sup>" : "") +
          '</strong><span class="pill">' + placeCount(place) + '</span></div>' +
          '<div class="members">' + detail + '</div>' +
          expandBtn +
          (expanded ? nameListHtml(place.members) : "") +
          '</div>';
      }).join("");
      // Names of the unplaced only ever come with full data; summary mode already covers this
      // with the counts in the header ("N not placed"), so there is nothing further to list.
      const unplaced = (isFull && data.unplaced) || [];
      if (unplaced.length) {
        html += '<div class="place-row"><div class="head"><strong>Not placed</strong>' +
          '<span class="pill">' + unplaced.length + '</span></div><div class="members">' +
          unplaced.map((entry) => escapeHtml(entry.name + (entry.raw ? " (" + entry.raw + ")" : " — no location"))).join(", ") +
          '</div></div>';
      }
      html += hasApprox
        ? '<p class="approx-footnote">* approximate (from last login, no city known)</p>'
        : "";
      return html;
    }

    // Opens the sidebar, optionally scrolling to and highlighting one place (a marker click);
    // omit highlightKey to just browse the full list (the "Places" toggle).
    function showSidebar(highlightKey) {
      if (!currentData) return;
      document.getElementById("place-list").innerHTML = buildSidebarHtml(currentData, expandedPlaces);
      document.getElementById("sidebar").hidden = false;
      if (highlightKey) {
        const row = document.querySelector('.place-row[data-key="' + CSS.escape(highlightKey) + '"]');
        if (row) {
          row.classList.add("selected");
          row.scrollIntoView({ block: "nearest" });
        }
      }
    }

    function hideSidebar() {
      document.getElementById("sidebar").hidden = true;
    }

    document.getElementById("sidebar-close").addEventListener("click", hideSidebar);
    document.getElementById("map-places-toggle").addEventListener("click", () => {
      if (document.getElementById("sidebar").hidden) {
        showSidebar();
      } else {
        hideSidebar();
      }
    });
    // Delegated: rows are rebuilt wholesale on every render, so a listener on each button would
    // be lost the moment its row re-renders.
    document.getElementById("place-list").addEventListener("click", (event) => {
      const button = event.target.closest(".place-expand-btn");
      if (!button || !currentData) return;
      const key = button.getAttribute("data-key");
      if (expandedPlaces.has(key)) {
        expandedPlaces.delete(key);
      } else {
        expandedPlaces.add(key);
      }
      document.getElementById("place-list").innerHTML = buildSidebarHtml(currentData, expandedPlaces);
    });

    function renderPlaces(data) {
      currentData = data;
      // Every load — first open and every "Refresh from Slack" alike — resets to the full
      // world view rather than drifting toward wherever members happen to cluster, or keeping
      // whatever pan/zoom was left over from before the refresh.
      map.setView(WORLD_VIEW.center, WORLD_VIEW.zoom);
      const places = data.places || [];
      const counts = data.counts || {};
      document.getElementById("map-count").textContent = places.length
        ? places.length + " place(s) · " + (counts.placed || 0) + " placed" +
          (counts.unplaced || counts.unknown
            ? " · " + ((counts.unplaced || 0) + (counts.unknown || 0)) + " not placed"
            : "")
        : "";
      hideSidebar();

      if (!places.length) {
        document.getElementById("empty-state").hidden = false;
        return;
      }
      document.getElementById("empty-state").hidden = true;

      const isFull = data.mode === "full";
      const biggest = places.reduce((max, place) => Math.max(max, placeCount(place)), 1);
      markers.forEach((marker) => marker.remove());
      markers = [];
      openPopup = null;
      places.forEach((place) => {
        const count = placeCount(place);
        // Area scales with headcount (not radius directly), so a city of nine does not read as
        // nine times the size of a city of one.
        const size = 14 + 26 * Math.sqrt(count / biggest);
        const isApprox = place.key.startsWith("country:");
        const icon = L.divIcon({
          className: "member-map-marker" + (isApprox ? " member-map-marker-approx" : ""),
          iconSize: [size, size],
          // Without this Leaflet anchors a divIcon at bottom-center, like a pin: a bigger
          // circle would then sit further above its real coordinate than a smaller one.
          iconAnchor: [size / 2, size / 2],
        });
        const tooltipHtml =
          '<div class="map-tooltip-title">' + escapeHtml(place.label) + (isApprox ? "<sup>*</sup>" : "") +
          " (" + count + ")</div>" +
          (isFull ? avatarsHtml(place.members) : "");
        const marker = L.marker([place.lat, place.lon], { icon }).addTo(map);
        marker.bindPopup(tooltipHtml, { closeButton: false, autoPan: false });
        // A mouse gets the tooltip on hover; a touchscreen has no hover, so Leaflet's default
        // tap-to-open/tap-elsewhere-to-close behavior (from the "click" event) covers that case.
        marker.on("mouseover", () => {
          if (openPopup && openPopup !== marker) {
            openPopup.closePopup();
          }
          marker.openPopup();
          openPopup = marker;
        });
        marker.on("mouseout", () => {
          marker.closePopup();
          if (openPopup === marker) {
            openPopup = null;
          }
        });
        // Selecting a dot opens the sidebar scrolled to and highlighting that place, rather
        // than the sidebar being a permanent fixture listing everything all the time.
        marker.on("click", () => showSidebar(place.key));
        markers.push(marker);
      });
    }

    async function load() {
      try {
        const data = await api("/member-map");
        // Reading and reacting to individual member locations by name is the privileged action;
        // triggering a real Slack lookup on their behalf is too, so both stay admin-only.
        document.getElementById("map-refresh").hidden = data.mode !== "full";
        document.getElementById("directory-sync").hidden = data.mode !== "full";
        renderPlaces(data);
      } catch (error) {
        setStatus("map-status", error.message, "error");
      }
    }

    document.getElementById("map-refresh").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus("map-status", "Reading Slack profiles…", "");
      try {
        const result = await api("/member-map/refresh", { method: "POST" });
        setStatus("map-status", "Checked " + result.checked + " Slack profile(s); " + result.updated + " location(s) changed.", "ok");
        await load();
      } catch (error) {
        setStatus("map-status", error.message, "error");
      } finally {
        button.disabled = false;
      }
    });

    // Distinct from "Refresh from Slack": that re-reads each already-linked member's profile for
    // a location, this links a member to their Slack account and timezone in the first place --
    // formerly console-only, moved in here so both Slack actions live in one place.
    document.getElementById("directory-sync").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus("directory-status", "Reading Slack directory…", "");
      try {
        const result = await api("/members/directory/refresh-slack", { method: "POST" });
        setStatus(
          "directory-status",
          "Linked " + result.idsResolved + " Slack id(s); " +
            result.timezonesUpdated + " of " + result.timezonesChecked + " timezone(s) changed.",
          "ok",
        );
        await load();
      } catch (error) {
        setStatus("directory-status", error.message, "error");
      } finally {
        button.disabled = false;
      }
    });

    load();
  </script>
</body>
</html>`;
}
