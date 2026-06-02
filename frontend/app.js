// ── Utilities ─────────────────────────────────────────────────────────────────

const api = async (method, path, body) => {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
};

const badge = (status) => `<span class="badge badge-${status}">${status}</span>`;

const setStatus = (elId, msg, type = "info") => {
  const el = document.getElementById(elId);
  if (!el) return;
  const colors = { info: "#555", error: "var(--danger)", success: "var(--success)" };
  el.style.color = colors[type] || "#555";
  el.textContent = msg;
};

// ── Navigation ────────────────────────────────────────────────────────────────

const views = ["datasets", "review", "training", "models"];

function switchView(name) {
  views.forEach(id => document.getElementById(`view-${id}`).classList.toggle("active", id === name));
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  localStorage.setItem("kraken_active_view", name);
  if (name === "review") populateReviewDatasetSelect();
  if (name === "training") { populateTrainingSelects(); loadJobs().then(jobs => {
    if (jobs && jobs.some(j => j.status === "running")) startJobPolling();
  }); }
  if (name === "models") loadModels();
}

document.querySelectorAll("nav button").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// Restore last active view on load
(function () {
  const saved = localStorage.getItem("kraken_active_view");
  if (saved && views.includes(saved)) switchView(saved);
})();

// ── DATASETS VIEW ─────────────────────────────────────────────────────────────

let activeDatasetId = null;

// CSV upload via drop zone
const dropZone = document.getElementById("csv-drop-zone");
const csvInput = document.getElementById("csv-file-input");

dropZone.addEventListener("click", () => csvInput.click());
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) uploadCSV(file);
});
csvInput.addEventListener("change", () => { if (csvInput.files[0]) uploadCSV(csvInput.files[0]); });

async function uploadCSV(file) {
  setStatus("csv-upload-status", "Uploading…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const data = await api("POST", "/datasets", fd);
    setStatus("csv-upload-status", `Created dataset "${data.name}" with ${data.folio_count} folios.`, "success");
    loadDatasets();
  } catch (err) {
    setStatus("csv-upload-status", `Error: ${err.message}`, "error");
  }
}

async function loadDatasets() {
  const datasets = await api("GET", "/datasets");
  const wrap = document.getElementById("datasets-table-wrap");
  if (!datasets.length) {
    wrap.innerHTML = '<div class="empty-state">No datasets yet. Upload a CSV above.</div>';
    return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th>Name</th><th>Folios</th>
        <th>Images</th><th>Uploaded</th><th></th>
      </tr></thead>
      <tbody>
        ${datasets.map(ds => `
          <tr id="dataset-row-${ds.id}">
            <td>${ds.name}</td>
            <td>${ds.folio_count}</td>
            <td>
              ${badge("done")} ${ds.image_status.done}
              &nbsp;${badge("failed")} ${ds.image_status.failed}
              &nbsp;${badge("pending")} ${ds.image_status.pending}
            </td>
            <td class="text-muted">${new Date(ds.uploaded_at).toLocaleString()}</td>
            <td class="row-actions">
              <button class="btn btn-secondary btn-sm" onclick="showFolios(${ds.id}, '${ds.name}')">View Folios</button>
              <label class="btn btn-secondary btn-sm" title="Re-upload CSV to refresh text pools without losing segmentation">
                ↺ Re-upload
                <input type="file" accept=".csv" style="display:none" onchange="reuploadDataset(${ds.id}, this)">
              </label>
              <button class="btn btn-danger btn-sm" id="ds-delete-${ds.id}" onclick="deleteDataset(${ds.id}, '${ds.name.replace(/'/g, "\\'")}', this)">🗑</button>
            </td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function reuploadDataset(id, input) {
  if (!input.files[0]) return;
  setStatus("csv-upload-status", "Re-uploading CSV…");
  const fd = new FormData();
  fd.append("file", input.files[0]);
  try {
    const data = await api("POST", `/datasets/${id}/reupload`, fd);
    setStatus("csv-upload-status", `Text pools refreshed: ${data.updated} folios updated, ${data.added} new folios added.`, "success");
    loadDatasets();
  } catch (err) {
    setStatus("csv-upload-status", `Re-upload failed: ${err.message}`, "error");
  }
  input.value = "";
}

async function deleteDataset(id, name, btn) {
  if (btn.dataset.confirming) {
    btn.textContent = "🗑";
    delete btn.dataset.confirming;
    clearTimeout(btn._confirmTimer);
    try {
      await api("DELETE", `/datasets/${id}`);
      document.getElementById(`dataset-row-${id}`)?.remove();
      if (activeDatasetId === id) {
        activeDatasetId = null;
        document.getElementById("folios-panel").style.display = "none";
      }
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
      loadDatasets();
    }
  } else {
    btn.textContent = "Sure?";
    btn.dataset.confirming = "1";
    btn._confirmTimer = setTimeout(() => {
      btn.textContent = "🗑";
      delete btn.dataset.confirming;
    }, 4000);
  }
}

async function showFolios(datasetId, name) {
  activeDatasetId = datasetId;
  document.getElementById("folios-panel").style.display = "";
  document.getElementById("folios-panel-title").textContent = `Folios — ${name}`;
  document.getElementById("btn-fetch-images").onclick = () => fetchImages(datasetId);
  document.getElementById("zip-upload-input").onchange = function() {
    if (this.files[0]) uploadZip(datasetId, this.files[0]);
  };
  loadFolios(datasetId);
}

// ── Folio pagination state ─────────────────────────────────────────────────────

let _cachedFolios = [];   // all folios for the active dataset
let _folioPage = 0;       // current page index (0-based)

function _getFolioPageSize() {
  return parseInt(localStorage.getItem("folioPageSize") || "20");
}
function _setFolioPageSize(n) {
  localStorage.setItem("folioPageSize", String(n));
}
function _getFolioPage(datasetId) {
  return parseInt(localStorage.getItem(`folioPage_${datasetId}`) || "0");
}
function _setFolioPage(datasetId, page) {
  localStorage.setItem(`folioPage_${datasetId}`, String(page));
}

async function loadFolios(datasetId) {
  _cachedFolios = await api("GET", `/datasets/${datasetId}/folios`);
  _folioPage = _getFolioPage(datasetId);

  // Sync page-size selector to stored value
  const sizeEl = document.getElementById("folio-page-size");
  sizeEl.value = String(_getFolioPageSize());
  sizeEl.onchange = () => {
    _setFolioPageSize(parseInt(sizeEl.value));
    _folioPage = 0;
    _setFolioPage(datasetId, 0);
    renderFolioPage(datasetId);
  };

  document.getElementById("btn-folio-prev").onclick = () => {
    if (_folioPage > 0) { _folioPage--; _setFolioPage(datasetId, _folioPage); renderFolioPage(datasetId); }
  };
  document.getElementById("btn-folio-next").onclick = () => {
    const pageSize = _getFolioPageSize();
    const maxPage = Math.ceil(_cachedFolios.length / pageSize) - 1;
    if (_folioPage < maxPage) { _folioPage++; _setFolioPage(datasetId, _folioPage); renderFolioPage(datasetId); }
  };

  renderFolioPage(datasetId);
}

function renderFolioPage(datasetId) {
  const wrap = document.getElementById("folios-table-wrap");
  const info = document.getElementById("folios-pagination-info");

  if (!_cachedFolios.length) {
    wrap.innerHTML = '<div class="empty-state">No folios found.</div>';
    info.textContent = "";
    return;
  }

  const pageSize = _getFolioPageSize();
  const totalPages = Math.ceil(_cachedFolios.length / pageSize);
  // Clamp page in case page size changed
  if (_folioPage >= totalPages) { _folioPage = totalPages - 1; _setFolioPage(datasetId, _folioPage); }

  const start = _folioPage * pageSize;
  const slice = _cachedFolios.slice(start, start + pageSize);

  info.textContent = `Showing ${start + 1}–${Math.min(start + pageSize, _cachedFolios.length)} of ${_cachedFolios.length} folios (page ${_folioPage + 1} of ${totalPages})`;
  document.getElementById("btn-folio-prev").disabled = _folioPage === 0;
  document.getElementById("btn-folio-next").disabled = _folioPage >= totalPages - 1;

  wrap.innerHTML = `
    <table id="folios-table">
      <thead><tr><th>Folio</th><th>Image</th><th>Segmented</th><th>Text entries</th><th></th></tr></thead>
      <tbody>
        ${slice.map(f => `
          <tr id="folio-row-${f.id}">
            <td>${f.folio_label}</td>
            <td>${badge(f.image_status)}</td>
            <td>${f.segmented ? badge("done") : "—"}</td>
            <td>${f.text_pool_count}</td>
            <td><button class="btn btn-secondary btn-sm" onclick="showFolioUpload(${f.id}, '${f.folio_label.replace(/'/g, "\\'")}', this)">Upload Image</button></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function fetchImages(datasetId) {
  setStatus("csv-upload-status", "Queueing image downloads…");
  try {
    const data = await api("POST", `/datasets/${datasetId}/fetch-images`);
    setStatus("csv-upload-status", `${data.queued} images queued for download.`, "success");
    // Poll until all done
    const poll = setInterval(async () => {
      const datasets = await api("GET", "/datasets");
      const ds = datasets.find(d => d.id === datasetId);
      if (ds && ds.image_status.pending === 0 && ds.image_status.downloading === 0) {
        clearInterval(poll);
        loadFolios(datasetId);
        loadDatasets();
      }
    }, 2500);
  } catch (err) {
    setStatus("csv-upload-status", `Error: ${err.message}`, "error");
  }
}

async function uploadZip(datasetId, file) {
  setStatus("csv-upload-status", "Uploading ZIP…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const data = await api("POST", `/datasets/${datasetId}/upload-images-zip`, fd);
    const msg = `Matched ${data.matched.length} images.${data.unmatched.length ? ` Unmatched: ${data.unmatched.join(", ")}` : ""}`;
    setStatus("csv-upload-status", msg, data.unmatched.length ? "info" : "success");
    loadFolios(datasetId);
  } catch (err) {
    setStatus("csv-upload-status", `Error: ${err.message}`, "error");
  }
}

function showFolioUpload(folioId, label, triggerBtn) {
  // Close any already-open upload row
  document.querySelectorAll(".folio-upload-row").forEach(r => r.remove());

  const parentRow = triggerBtn.closest("tr");
  const inputId = `folio-img-input-${folioId}`;

  const uploadRow = document.createElement("tr");
  uploadRow.className = "folio-upload-row";
  uploadRow.innerHTML = `
    <td colspan="5">
      <div class="folio-upload-inline">
        <span class="text-muted">Upload image for <strong>${label}</strong>:</span>
        <label class="btn btn-secondary btn-sm">
          Choose file
          <input type="file" id="${inputId}" accept="image/*" style="display:none">
        </label>
        <span id="folio-upload-inline-status-${folioId}" class="text-muted"></span>
        <button class="btn btn-secondary btn-sm" onclick="this.closest('.folio-upload-row').remove()">Cancel</button>
      </div>
    </td>`;

  parentRow.insertAdjacentElement("afterend", uploadRow);

  document.getElementById(inputId).onchange = async function() {
    if (!this.files[0]) return;
    const statusEl = document.getElementById(`folio-upload-inline-status-${folioId}`);
    statusEl.textContent = "Uploading…";
    const fd = new FormData();
    fd.append("file", this.files[0]);
    try {
      await api("POST", `/folios/${folioId}/upload-image`, fd);
      uploadRow.remove();
      // Update the cached folio and re-render without a full network fetch
      const cached = _cachedFolios.find(f => f.id === folioId);
      if (cached) cached.image_status = "done";
      renderFolioPage(activeDatasetId);
      setStatus("csv-upload-status", `Image uploaded for folio ${label}.`, "success");
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.style.color = "var(--danger)";
    }
  };
}

// ── REVIEW VIEW ───────────────────────────────────────────────────────────────

let currentFolioData = null;   // full response from /folios/{id}/lines
let selectedLineIds = new Set();
let _allFoliosForDataset = []; // folio list for current dataset (to find previous folio)
let addLineMode    = false;
let addLinePolygon = [];   // [[imgX, imgY], ...] points in image natural-pixel coords
let _addLineCursor = null; // {x, y} in SVG viewBox coords for live preview
const ADD_LINE_CLOSE_DIST = 15; // px screen distance to snap-close the polygon

// ── Overlay colour ────────────────────────────────────────────────────────────
const OVERLAY_COLORS = [
  { hex: "#5a4a3a", label: "Brown (default)" },
  { hex: "#e74c3c", label: "Red" },
  { hex: "#e67e22", label: "Orange" },
  { hex: "#f1c40f", label: "Yellow" },
  { hex: "#2ecc71", label: "Green" },
  { hex: "#00bcd4", label: "Cyan" },
  { hex: "#9b59b6", label: "Purple" },
  { hex: "#ffffff", label: "White" },
];

let _overlayColor = localStorage.getItem("kraken_overlay_color") || "#e74c3c";

function applyOverlayColor(hex) {
  _overlayColor = hex;
  localStorage.setItem("kraken_overlay_color", hex);
  document.documentElement.style.setProperty("--overlay-stroke", hex);
  document.getElementById("btn-overlay-color").style.background = hex;
  document.querySelectorAll(".color-swatch").forEach(s => {
    s.classList.toggle("active", s.dataset.color === hex);
  });
}

// Build and wire the color picker
(function () {
  const picker = document.getElementById("overlay-color-picker");
  picker.innerHTML = OVERLAY_COLORS.map(c =>
    `<div class="color-swatch${c.hex === _overlayColor ? " active" : ""}"
       data-color="${c.hex}" title="${c.label}"
       style="background:${c.hex}; ${c.hex === "#ffffff" ? "border:1px solid #ccc;" : ""}"></div>`
  ).join("");

  picker.querySelectorAll(".color-swatch").forEach(swatch => {
    swatch.addEventListener("click", (e) => {
      e.stopPropagation();
      applyOverlayColor(swatch.dataset.color);
      picker.classList.remove("open");
    });
  });

  document.getElementById("btn-overlay-color").addEventListener("click", (e) => {
    e.stopPropagation();
    picker.classList.toggle("open");
  });

  document.addEventListener("click", () => picker.classList.remove("open"));

  // Apply persisted color on load
  applyOverlayColor(_overlayColor);
})();

// ── Zoom / pan state ──────────────────────────────────────────────────────────
let _viewZoom  = 1.0;
let _viewPanX  = 0;
let _viewPanY  = 0;
let _panStart  = null;   // {bx, by} base pan minus pointer start
let _panMoved  = false;
let splitModeLineId = null;    // line being split via the page viewer
let mergeModeLineId = null;    // first line in a pending merge
const _collapsedLines = new Set();  // line IDs currently collapsed to image-only
let _lineSort = localStorage.getItem("kraken_line_sort") || "number";
let _focusedLineId = null;          // line whose textarea currently has focus

// ── Pending delete confirmation ───────────────────────────────────────────────

let _pendingDelete = null; // { ids: number[], btn: HTMLElement|null, cancelTimeout }

// ── Polygon edit state ────────────────────────────────────────────────────────

let editPolygonLineId    = null;  // line.id being edited, or null
let _editPolygonOriginal = null;  // copy of polygon pts before edits (for cancel/undo)
let _editDrag            = null;  // { idx: number } — vertex index being dragged
let _ctxMenuLineId       = null;  // line.id whose context menu is open

function _clearPendingDelete() {
  if (!_pendingDelete) return;
  clearTimeout(_pendingDelete.cancelTimeout);
  if (_pendingDelete.btn) {
    _pendingDelete.btn.textContent = "Delete";
    _pendingDelete.btn.classList.remove("confirming");
  }
  document.getElementById("delete-confirm-banner")?.remove();
  _pendingDelete = null;
}

function _requestDelete(ids, btn) {
  _clearPendingDelete();
  const cancelTimeout = setTimeout(_clearPendingDelete, 4000);
  _pendingDelete = { ids, btn, cancelTimeout };
  if (btn) {
    btn.textContent = "Confirm?";
    btn.classList.add("confirming");
    btn.focus();
  } else {
    const list = document.getElementById("line-list");
    const banner = document.createElement("div");
    banner.id = "delete-confirm-banner";
    banner.innerHTML = `
      <span>Delete ${ids.length} lines?</span>
      <button class="btn btn-danger btn-sm" id="delete-confirm-btn">Confirm</button>
      <span class="text-muted" style="font-size:0.78rem">press Enter · Esc to cancel</span>`;
    list.prepend(banner);
    document.getElementById("delete-confirm-btn").addEventListener("click", _executeDelete);
    document.getElementById("delete-confirm-btn").focus();
  }
}

async function _executeDelete() {
  if (!_pendingDelete) return;
  const { ids } = _pendingDelete;
  _clearPendingDelete();
  if (ids.length === 1) {
    const lineId = ids[0];
    const line = currentFolioData.lines.find(l => l.id === lineId);
    if (!line) return;
    const snap = snapshotLine(line);
    await api("DELETE", `/lines/${lineId}`);
    pushUndo(`delete line ${snap.line_index + 1}`, async () => {
      await api("POST", "/lines/restore", snap);
    });
    currentFolioData.lines = currentFolioData.lines.filter(l => l.id !== lineId);
    selectedLineIds.delete(lineId);
  } else {
    const snaps = ids.map(id => snapshotLine(currentFolioData.lines.find(l => l.id === id)));
    for (const id of ids) await api("DELETE", `/lines/${id}`);
    pushUndo(`delete ${ids.length} lines`, async () => {
      for (const snap of snaps) await api("POST", "/lines/restore", snap);
    });
    currentFolioData.lines = currentFolioData.lines.filter(l => !ids.includes(l.id));
    ids.forEach(id => selectedLineIds.delete(id));
  }
  renderLineList();
}

// ── Polygon editor ────────────────────────────────────────────────────────────

function enterEditPolygonMode(lineId) {
  if (addLineMode) exitAddLineMode();
  exitSplitMode();
  exitMergeMode();
  editPolygonLineId = lineId;
  const line = currentFolioData.lines.find(l => l.id === lineId);
  _editPolygonOriginal = line.polygon ? line.polygon.map(p => [...p]) : [];
  document.getElementById("btn-done-editing").style.display = "";
  setReviewHint("Drag vertices to reshape · right-click vertex to delete · Esc to cancel");
  renderOverlay();
}

function exitEditPolygonMode(save) {
  if (editPolygonLineId === null) return;
  const lineId = editPolygonLineId;
  editPolygonLineId = null;
  _editDrag = null;
  hidePolyContextMenu();

  const line = currentFolioData.lines.find(l => l.id === lineId);
  if (save && line) {
    const oldPoly = _editPolygonOriginal;
    const newPoly = line.polygon ? line.polygon.map(p => [...p]) : [];
    if (JSON.stringify(oldPoly) !== JSON.stringify(newPoly)) {
      const capturedId  = lineId;
      const capturedOld = oldPoly;
      api("PATCH", `/lines/${lineId}`, { polygon: newPoly })
        .catch(err => alert(`Save failed: ${err.message}`));
      pushUndo(`edit polygon line ${(line.line_index || 0) + 1}`, async () => {
        const l = currentFolioData.lines.find(x => x.id === capturedId);
        if (l) l.polygon = capturedOld;
        await api("PATCH", `/lines/${capturedId}`, { polygon: capturedOld });
        renderOverlay();
      });
    }
  } else if (!save && line) {
    line.polygon = _editPolygonOriginal;
  }

  _editPolygonOriginal = null;
  document.getElementById("btn-done-editing").style.display = "none";
  clearReviewHint();
  renderOverlay();
}

function updateEditHandles() {
  const grp = document.getElementById("edit-handles-group");
  if (!grp) return;
  if (editPolygonLineId === null) { grp.innerHTML = ""; return; }

  const line = currentFolioData?.lines.find(l => l.id === editPolygonLineId);
  if (!line?.polygon?.length) { grp.innerHTML = ""; return; }

  const img    = document.getElementById("page-canvas");
  const scaleX = img.clientWidth  / img.naturalWidth;
  const scaleY = img.clientHeight / img.naturalHeight;
  const pts    = line.polygon;

  let html = "";

  // Midpoint handles between consecutive vertices
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const mx = (ax + bx) / 2 * scaleX;
    const my = (ay + by) / 2 * scaleY;
    html += `<circle class="poly-mid-handle" data-midafter="${i}" cx="${mx}" cy="${my}" r="5"/>`;
  }
  // Vertex handles (drawn after midpoints so they appear on top)
  pts.forEach(([x, y], i) => {
    html += `<circle class="poly-vert-handle" data-vidx="${i}" cx="${x * scaleX}" cy="${y * scaleY}" r="7"/>`;
  });

  grp.innerHTML = html;

  const capturedLineId = editPolygonLineId;

  grp.querySelectorAll(".poly-vert-handle").forEach(c => {
    const vidx = parseInt(c.dataset.vidx);
    c.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      _editDrag = { idx: vidx };
    });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (line.polygon.length > 3) showVertexContextMenu(e, capturedLineId, vidx);
    });
  });

  grp.querySelectorAll(".poly-mid-handle").forEach(c => {
    const after = parseInt(c.dataset.midafter);
    c.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const [ax, ay] = pts[after];
      const [bx, by] = pts[(after + 1) % pts.length];
      line.polygon.splice(after + 1, 0, [Math.round((ax + bx) / 2), Math.round((ay + by) / 2)]);
      _editDrag = { idx: after + 1 };
      updateEditHandles();
    });
  });
}

function showPolyContextMenu(e, lineId) {
  hidePolyContextMenu();
  _ctxMenuLineId = lineId;
  const menu = document.getElementById("poly-context-menu");
  menu.style.display = "";
  menu.style.left = e.clientX + "px";
  menu.style.top  = e.clientY + "px";
  menu.innerHTML = `
    <button class="ctx-item" id="ctx-edit-polygon">Edit polygon</button>
    <button class="ctx-item ctx-danger" id="ctx-delete-line">Delete line</button>`;
  document.getElementById("ctx-edit-polygon").onclick = () => {
    const id = _ctxMenuLineId;
    hidePolyContextMenu();
    enterEditPolygonMode(id);
  };
  document.getElementById("ctx-delete-line").onclick = () => {
    const id = _ctxMenuLineId;
    hidePolyContextMenu();
    const btn = document.querySelector(`#line-item-${id} .btn-delete`);
    _requestDelete([id], btn || null);
  };
}

function showVertexContextMenu(e, lineId, vidx) {
  hidePolyContextMenu();
  _ctxMenuLineId = lineId;
  const menu = document.getElementById("poly-context-menu");
  menu.style.display = "";
  menu.style.left = e.clientX + "px";
  menu.style.top  = e.clientY + "px";
  menu.innerHTML = `<button class="ctx-item ctx-danger" id="ctx-del-vertex">Delete vertex</button>`;
  document.getElementById("ctx-del-vertex").onclick = () => {
    hidePolyContextMenu();
    const l = currentFolioData.lines.find(x => x.id === lineId);
    if (l && l.polygon.length > 3) {
      l.polygon.splice(vidx, 1);
      updateEditHandles();
    }
  };
}

function hidePolyContextMenu() {
  const menu = document.getElementById("poly-context-menu");
  if (menu) menu.style.display = "none";
  _ctxMenuLineId = null;
}

// ── Undo stack ────────────────────────────────────────────────────────────────

const _undoStack = [];
const MAX_UNDO = 30;

function snapshotLine(line) {
  return {
    folio_id: currentFolioData.folio_id,
    line_index: line.line_index,
    crop_path: line.crop_path || null,
    polygon: line.polygon || [],
    transcription: line.transcription || null,
    confirmed: !!line.confirmed,
  };
}

function pushUndo(label, undoFn) {
  _undoStack.push({ label, undo: undoFn });
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  _showUndoToast(label);
}

function _showUndoToast(label) {
  let toast = document.getElementById("undo-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "undo-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = `✓ ${label} — Ctrl+Z to undo`;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

async function performUndo() {
  const entry = _undoStack.pop();
  if (!entry) { _showUndoToast("Nothing to undo"); return; }
  try {
    await entry.undo();
    await loadReviewFolio(currentFolioData.folio_id);
  } catch (err) {
    alert(`Undo failed: ${err.message}`);
  }
}

async function populateReviewDatasetSelect() {
  const datasets = await api("GET", "/datasets");
  const sel = document.getElementById("review-dataset-select");
  sel.innerHTML = '<option value="">— Select dataset —</option>' +
    datasets.map(d => `<option value="${d.id}">${d.name}</option>`).join("");
}

document.getElementById("review-dataset-select").addEventListener("change", async function() {
  const dsId = this.value;
  const folioSel = document.getElementById("review-folio-select");
  folioSel.innerHTML = '<option value="">— Select folio —</option>';
  folioSel.disabled = !dsId;
  if (!dsId) { _allFoliosForDataset = []; return; }
  const folios = await api("GET", `/datasets/${dsId}/folios`);
  // Sort folios by label to ensure consistent ordering (for finding "previous" folio)
  _allFoliosForDataset = folios.sort((a, b) => {
    const aNum = parseInt(a.folio_label) || 0;
    const bNum = parseInt(b.folio_label) || 0;
    if (aNum !== bNum) return aNum - bNum;
    return a.folio_label.localeCompare(b.folio_label);
  });
  _allFoliosForDataset.forEach(f => {
    const opt = new Option(`${f.folio_label} ${f.segmented ? "✓" : ""}`, f.id);
    folioSel.appendChild(opt);
  });
  folioSel.disabled = false;
});

document.getElementById("review-folio-select").addEventListener("change", function() {
  const folioId = this.value;
  document.getElementById("btn-segment").disabled = !folioId;
  if (folioId) loadReviewFolio(folioId);
});

document.getElementById("btn-segment").addEventListener("click", async () => {
  const folioId = document.getElementById("review-folio-select").value;
  if (!folioId) return;
  document.getElementById("review-status").textContent = "Segmenting…";
  try {
    const data = await api("POST", `/folios/${folioId}/segment`);
    document.getElementById("review-status").textContent = `${data.lines_created} lines detected.`;
    await loadReviewFolio(folioId);
  } catch (err) {
    document.getElementById("review-status").textContent = `Error: ${err.message}`;
  }
});

document.getElementById("btn-confirm-all").addEventListener("click", async () => {
  if (!currentFolioData) return;
  for (const line of currentFolioData.lines) {
    if (!line.confirmed) {
      await api("PATCH", `/lines/${line.id}`, { confirmed: true });
      line.confirmed = true;
    }
  }
  renderLineList();
});

async function loadReviewFolio(folioId) {
  folioId = parseInt(folioId, 10);
  document.getElementById("review-empty").style.display = "none";
  document.getElementById("review-container").style.display = "";
  document.getElementById("btn-confirm-all").disabled = false;
  selectedLineIds.clear();
  splitModeLineId = null;
  mergeModeLineId = null;
  _focusedLineId = null;
  if (editPolygonLineId !== null) {
    editPolygonLineId = null;
    _editDrag = null;
    _editPolygonOriginal = null;
    document.getElementById("btn-done-editing").style.display = "none";
    hidePolyContextMenu();
  }
  clearReviewHint();

  const oldFolioId = currentFolioData?.folio_id;

  try {
    currentFolioData = await api("GET", `/folios/${folioId}/lines`);
  } catch (err) {
    document.getElementById("review-status").textContent = `Error: ${err.message}`;
    return;
  }

  // Prepend last chant from previous folio to text pool (for continuity)
  let currentFolioIndex = _allFoliosForDataset.findIndex(f => f.id === folioId);

  // If folio list not populated, try to fetch it from the current dataset
  if (_allFoliosForDataset.length === 0 && document.getElementById("review-dataset-select").value) {
    const dsId = document.getElementById("review-dataset-select").value;
    const folios = await api("GET", `/datasets/${dsId}/folios`).catch(() => []);
    if (folios.length > 0) {
      _allFoliosForDataset = folios.sort((a, b) => {
        const aNum = parseInt(a.folio_label) || 0;
        const bNum = parseInt(b.folio_label) || 0;
        if (aNum !== bNum) return aNum - bNum;
        return a.folio_label.localeCompare(b.folio_label);
      });
      currentFolioIndex = _allFoliosForDataset.findIndex(f => f.id === folioId);
    }
  }

  if (currentFolioIndex > 0 && _allFoliosForDataset.length > 0) {
    const prevFolio = _allFoliosForDataset[currentFolioIndex - 1];
    try {
      const prevData = await api("GET", `/folios/${prevFolio.id}/text-pool`);
      if (prevData && prevData.text_pool && prevData.text_pool.length > 0) {
        const lastChant = prevData.text_pool[prevData.text_pool.length - 1];
        if (currentFolioData.text_pool) {
          currentFolioData.text_pool.unshift(`← ${lastChant}`);
        }
      }
    } catch (err) {
      console.error("Failed to fetch previous folio's text pool:", err);
    }
  }

  document.getElementById("review-folio-heading").textContent = currentFolioData.folio_label;

  // Page image — set onload before src so cached loads are never missed
  const img = document.getElementById("page-canvas");
  if (oldFolioId !== folioId) resetView();  // only reset if switching to a different folio
  if (currentFolioData.page_image_url) {
    img.onload = () => {
      // Size the transform root to exactly the image so the SVG matches
      const root = document.getElementById("page-transform-root");
      if (root) { root.style.width = img.naturalWidth + "px"; root.style.height = img.naturalHeight + "px"; }
      renderOverlay();
    };
    img.src = currentFolioData.page_image_url;
    if (img.complete && img.naturalWidth) {
      const root = document.getElementById("page-transform-root");
      if (root) { root.style.width = img.naturalWidth + "px"; root.style.height = img.naturalHeight + "px"; }
      renderOverlay();
    }
  } else {
    img.src = "";
    renderOverlay();
  }

  // Text pool
  const pool = currentFolioData.text_pool || [];
  document.getElementById("pool-count").textContent = pool.length;
  document.getElementById("text-pool-list").innerHTML =
    pool.map((t, i) => `<div class="pool-item" title="Click to copy" onclick="copyToSelected('${t.replace(/'/g, "\\'")}')">
      <strong>${i}.</strong> ${t}
    </div>`).join("") || "<em>No text pool entries</em>";

  renderLineList();
}

function renderLineList() {
  _clearPendingDelete();
  const lines = currentFolioData?.lines || [];
  document.getElementById("line-count").textContent = lines.length;

  // Apply sort (never mutates currentFolioData.lines — just a display order)
  const sorted = [...lines].sort((a, b) => {
    if (_lineSort === "confirmed")   return (b.confirmed ? 1 : 0) - (a.confirmed ? 1 : 0) || a.line_index - b.line_index;
    if (_lineSort === "unconfirmed") return (a.confirmed ? 1 : 0) - (b.confirmed ? 1 : 0) || a.line_index - b.line_index;
    return a.line_index - b.line_index; // default: number
  });

  // Keep the select in sync (may be called before the element exists)
  const sortEl = document.getElementById("line-sort-select");
  if (sortEl) sortEl.value = _lineSort;

  const list = document.getElementById("line-list");
  list.innerHTML = sorted.length
    ? sorted.map(line => lineItemHTML(line)).join("")
    : '<div class="empty-state"><p>No lines. Click "Segment Page" to detect lines.</p></div>';

  // Attach events after render (iterate sorted so DOM order matches)
  sorted.forEach(line => {
    const item = document.getElementById(`line-item-${line.id}`);
    if (!item) return;

    item.querySelector(".line-transcription").addEventListener("focus", () => { _focusedLineId = line.id; });

    item.querySelector(".line-transcription").addEventListener("change", async (e) => {
      const oldText = line.transcription;
      const newText = e.target.value;
      await api("PATCH", `/lines/${line.id}`, { transcription: newText });
      const lineId = line.id;
      pushUndo(`text edit line ${line.line_index + 1}`, async () => {
        await api("PATCH", `/lines/${lineId}`, { transcription: oldText });
      });
      line.transcription = newText;
    });

    item.querySelector(".line-confirm-cb").addEventListener("change", async (e) => {
      const oldConfirmed = line.confirmed;
      const newConfirmed = e.target.checked;
      await api("PATCH", `/lines/${line.id}`, { confirmed: newConfirmed });
      const lineId = line.id;
      pushUndo(`${newConfirmed ? "confirm" : "unconfirm"} line ${line.line_index + 1}`, async () => {
        await api("PATCH", `/lines/${lineId}`, { confirmed: oldConfirmed });
      });
      line.confirmed = newConfirmed;
      item.classList.toggle("confirmed", newConfirmed);
    });

    item.querySelector(".line-num-input").addEventListener("change", async (e) => {
      const newNum = parseInt(e.target.value, 10);
      if (!Number.isFinite(newNum) || newNum < 1) { e.target.value = line.line_index + 1; return; }
      const oldIdx = line.line_index;
      const newIdx = newNum - 1;
      if (newIdx === oldIdx) return;
      await api("PATCH", `/lines/${line.id}`, { line_index: newIdx });
      const lineId = line.id;
      pushUndo(`renumber line ${oldIdx + 1} → ${newNum}`, async () => {
        await api("PATCH", `/lines/${lineId}`, { line_index: oldIdx });
        const l = currentFolioData.lines.find(x => x.id === lineId);
        if (l) l.line_index = oldIdx;
        renderLineList();
      });
      line.line_index = newIdx;
    });

    item.querySelector(".btn-split").addEventListener("click", () => toggleSplitMode(line.id));
    item.querySelector(".btn-merge").addEventListener("click", () => toggleMergeMode(line.id));
    item.querySelector(".btn-edit-polygon").addEventListener("click", () => enterEditPolygonMode(line.id));
    item.querySelector(".btn-delete").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      if (_pendingDelete?.ids.length === 1 && _pendingDelete.ids[0] === line.id) {
        _executeDelete();
      } else {
        _requestDelete([line.id], btn);
      }
    });

    item.querySelector(".btn-collapse").addEventListener("click", (e) => {
      e.stopPropagation();
      const collapsed = _collapsedLines.has(line.id);
      if (collapsed) {
        _collapsedLines.delete(line.id);
        item.classList.remove("collapsed");
        e.currentTarget.title = "Collapse";
      } else {
        _collapsedLines.add(line.id);
        item.classList.add("collapsed");
        e.currentTarget.title = "Expand";
      }
    });

    item.addEventListener("click", (e) => {
      if (e.target.closest("button, textarea, input")) return;
      toggleLineSelection(line.id, item);
    });
  });

  renderOverlay();
  updateMergeButton();
}

function lineItemHTML(line) {
  const isSplitting = splitModeLineId === line.id;
  const isMerging   = mergeModeLineId === line.id;
  const isCollapsed = _collapsedLines.has(line.id);
  const classes = [
    "line-item",
    line.confirmed    ? "confirmed"  : "",
    selectedLineIds.has(line.id) ? "selected" : "",
    isCollapsed       ? "collapsed"  : "",
  ].filter(Boolean).join(" ");

  return `
    <div class="${classes}" id="line-item-${line.id}">
      <div class="line-item-header">
        <input type="number" class="line-num-input" value="${line.line_index + 1}" min="1" title="Line number (edit to renumber; duplicates allowed for two chants on one line)">
        ${line.confirmed ? '<span class="line-confirmed-pip" title="Confirmed">&#10003;</span>' : '<span class="line-confirmed-pip"></span>'}
        <button class="btn-collapse" title="${isCollapsed ? "Expand" : "Collapse"}" aria-label="Toggle line details"></button>
      </div>
      ${line.crop_url
        ? `<img class="line-crop-img" src="${line.crop_url}?v=${line.id}" alt="Line ${line.line_index + 1}" loading="lazy">`
        : `<div class="line-crop-placeholder">No crop</div>`}
      <div class="line-collapsible">
        <textarea class="line-transcription" rows="2">${line.transcription || ""}</textarea>
        <div class="line-item-controls">
          <label class="confirm-cb">
            <input type="checkbox" class="line-confirm-cb" ${line.confirmed ? "checked" : ""}>
            Confirmed
          </label>
          <button class="btn btn-secondary btn-sm btn-split${isSplitting ? " active-mode" : ""}"
            title="Enter split mode, then click the split point on the page viewer">
            ${isSplitting ? "Cancel Split" : "Split"}
          </button>
          <button class="btn btn-secondary btn-sm btn-merge${isMerging ? " active-mode" : ""}"
            title="Enter merge mode, then click the line to merge with on the page viewer">
            ${isMerging ? "Cancel Merge" : "Merge"}
          </button>
          <button class="btn btn-secondary btn-sm btn-edit-polygon" title="Edit polygon shape">Edit</button>
          <button class="btn btn-danger btn-sm btn-delete" title="Delete line (or press Delete key)">Delete</button>
        </div>
      </div>
    </div>`;
}

function toggleLineSelection(lineId, item) {
  if (selectedLineIds.has(lineId)) {
    selectedLineIds.delete(lineId);
    item?.classList.remove("selected");
  } else {
    selectedLineIds.add(lineId);
    item?.classList.add("selected");
  }
  updateMergeButton();
  renderOverlay();
}

function updateMergeButton() {
  document.getElementById("btn-merge-selected").disabled = selectedLineIds.size !== 2;
}

document.getElementById("line-sort-select").addEventListener("change", (e) => {
  _lineSort = e.target.value;
  localStorage.setItem("kraken_line_sort", _lineSort);
  renderLineList();
});

document.getElementById("btn-collapse-all").addEventListener("click", () => {
  const lines = currentFolioData?.lines || [];
  const allCollapsed = lines.every(l => _collapsedLines.has(l.id));
  if (allCollapsed) {
    lines.forEach(l => _collapsedLines.delete(l.id));
    document.getElementById("btn-collapse-all").textContent = "Collapse All";
  } else {
    lines.forEach(l => _collapsedLines.add(l.id));
    document.getElementById("btn-collapse-all").textContent = "Expand All";
  }
  renderLineList();
});

document.getElementById("btn-renumber").addEventListener("click", renumberLines);

async function renumberLines() {
  const lines = currentFolioData?.lines;
  if (!lines || !lines.length) return;

  // Sort by current line_index, then assign 0-based sequential indices
  // Lines that share the same number stay grouped together (preserve sub-order by current index)
  const sorted = [...lines].sort((a, b) => a.line_index - b.line_index);

  // Build the new assignments, preserving ties (same old index → same new index)
  const oldIndices = sorted.map(l => l.line_index);
  const newIndices = [];
  let counter = 0;
  let lastOld = null;
  for (let i = 0; i < sorted.length; i++) {
    if (lastOld !== null && sorted[i].line_index !== lastOld) counter++;
    newIndices.push(counter);
    lastOld = sorted[i].line_index;
  }

  // Check if anything would actually change
  const changes = sorted.filter((l, i) => l.line_index !== newIndices[i]);
  if (!changes.length) return;

  // Capture undo snapshots (old index for each line that changes)
  const undoMap = changes.map(l => ({ id: l.id, oldIdx: l.line_index }));

  // Apply all changes in parallel
  await Promise.all(sorted.map((l, i) => {
    if (l.line_index === newIndices[i]) return Promise.resolve();
    return api("PATCH", `/lines/${l.id}`, { line_index: newIndices[i] }).then(() => {
      l.line_index = newIndices[i];
    });
  }));

  // Re-sort currentFolioData.lines to match new order
  currentFolioData.lines.sort((a, b) => a.line_index - b.line_index);

  pushUndo("renumber lines from 1", async () => {
    await Promise.all(undoMap.map(({ id, oldIdx }) => {
      const l = currentFolioData.lines.find(x => x.id === id);
      if (l) l.line_index = oldIdx;
      return api("PATCH", `/lines/${id}`, { line_index: oldIdx });
    }));
    currentFolioData.lines.sort((a, b) => a.line_index - b.line_index);
    renderLineList();
  });

  renderLineList();
}

document.getElementById("btn-merge-selected").addEventListener("click", async () => {
  const ids = [...selectedLineIds];
  if (ids.length !== 2) return;
  const snapA = snapshotLine(currentFolioData.lines.find(l => l.id === ids[0]));
  const snapB = snapshotLine(currentFolioData.lines.find(l => l.id === ids[1]));
  try {
    const result = await api("POST", "/lines/merge", { line_ids: ids });
    pushUndo(`merge lines ${snapA.line_index + 1} & ${snapB.line_index + 1}`, async () => {
      await api("DELETE", `/lines/${result.id}`);
      await api("POST", "/lines/restore", snapA);
      await api("POST", "/lines/restore", snapB);
    });
    selectedLineIds.clear();
    await loadReviewFolio(currentFolioData.folio_id);
  } catch (err) {
    alert(`Merge failed: ${err.message}`);
  }
});


// ── Split mode ────────────────────────────────────────────────────────────────

function toggleSplitMode(lineId) {
  if (splitModeLineId === lineId) {
    exitSplitMode();
  } else {
    exitMergeMode();
    splitModeLineId = lineId;
    setReviewHint("Click the split point on the page image →");
    renderOverlay();
    renderLineList();
  }
}

function exitSplitMode() {
  if (splitModeLineId === null) return;
  splitModeLineId = null;
  clearReviewHint();
  renderOverlay();
  renderLineList();
}

// ── Merge mode ────────────────────────────────────────────────────────────────

function toggleMergeMode(lineId) {
  if (mergeModeLineId === lineId) {
    exitMergeMode();
  } else {
    exitSplitMode();
    mergeModeLineId = lineId;
    setReviewHint("Click the line to merge with on the page image →");
    renderOverlay();
    renderLineList();
  }
}

function exitMergeMode() {
  if (mergeModeLineId === null) return;
  mergeModeLineId = null;
  clearReviewHint();
  renderOverlay();
  renderLineList();
}

function setReviewHint(msg) {
  document.getElementById("review-status").textContent = msg;
  document.getElementById("review-status").style.color = "var(--warning)";
}
function clearReviewHint() {
  document.getElementById("review-status").textContent = "";
  document.getElementById("review-status").style.color = "";
}

// ── Keyboard: Delete key removes selected lines ───────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (_pendingDelete) { _clearPendingDelete(); return; }
    if (editPolygonLineId !== null) { exitEditPolygonMode(false); return; }
    if (addLineMode) { exitAddLineMode(); return; }
    exitSplitMode(); exitMergeMode();
    return;
  }
  const tag = document.activeElement?.tagName;
  // Ctrl/Cmd+Z — while drawing a polygon, pop the last point instead of global undo
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
    if (addLineMode && addLinePolygon.length > 0) {
      e.preventDefault();
      addLinePolygon.pop();
      updateAddLineOverlay();
      return;
    }
    if (tag !== "TEXTAREA" && tag !== "INPUT") {
      e.preventDefault();
      performUndo();
    }
    return;
  }
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  // Hotkey: A for add line
  if ((e.key === "a" || e.key === "A") && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (!addLineMode) {
      document.getElementById("btn-add-line").click();
    }
    return;
  }

  // Hotkey: S for split (when line selected)
  if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const lineId = [...selectedLineIds][0];
    if (lineId) {
      const line = currentFolioData?.lines.find(l => l.id === lineId);
      if (line) toggleSplitMode(lineId);
    }
    return;
  }

  // Hotkey: M for merge (when line selected)
  if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    const lineId = [...selectedLineIds][0];
    if (lineId) {
      const line = currentFolioData?.lines.find(l => l.id === lineId);
      if (line) toggleMergeMode(lineId);
    }
    return;
  }

  if ((e.key === "Delete" || e.key === "Backspace") && selectedLineIds.size > 0) {
    e.preventDefault();
    if (_pendingDelete) { _executeDelete(); return; }
    const ids = [...selectedLineIds];
    if (ids.length === 1) {
      const btn = document.querySelector(`#line-item-${ids[0]} .btn-delete`);
      _requestDelete(ids, btn || null);
    } else {
      _requestDelete(ids, null);
    }
  }
});

function copyToSelected(text) {
  // Prefer the textarea that last had focus; fall back to the last selected line
  const targetId = _focusedLineId ?? ([...selectedLineIds].at(-1) ?? null);
  if (targetId !== null) {
    const ta = document.querySelector(`#line-item-${targetId} .line-transcription`);
    if (ta) {
      ta.value = text;
      ta.dispatchEvent(new Event("change"));
      ta.focus();
      return;
    }
  }
  navigator.clipboard?.writeText(text);
}

// ── SVG overlay ───────────────────────────────────────────────────────────────

function renderOverlay() {
  const img = document.getElementById("page-canvas");
  const svg = document.getElementById("seg-overlay");

  // Always apply interaction state — must happen before any early return so
  // that add-line mode works even if the image hasn't finished loading yet.
  svg.style.pointerEvents = addLineMode ? "all" : "";
  const wrap = document.getElementById("page-canvas-wrap");
  if      (editPolygonLineId !== null)  wrap.style.cursor = "default";
  else if (addLineMode)                 wrap.style.cursor = "crosshair";
  else if (splitModeLineId !== null)    wrap.style.cursor = "col-resize";
  else if (mergeModeLineId !== null)    wrap.style.cursor = "crosshair";
  else                                  wrap.style.cursor = "";

  if (!currentFolioData || !img.naturalWidth) { svg.innerHTML = ""; return; }

  // SVG covers the full natural image size; scale factors map image→display coords
  const scaleX = img.clientWidth / img.naturalWidth;
  const scaleY = img.clientHeight / img.naturalHeight;
  svg.style.width  = img.clientWidth  + "px";
  svg.style.height = img.clientHeight + "px";
  svg.setAttribute("viewBox", `0 0 ${img.clientWidth} ${img.clientHeight}`);
  svg.style.top  = "0";
  svg.style.left = "0";

  svg.innerHTML = currentFolioData.lines.map(line => {
    const pts = line.polygon;
    if (!pts || !pts.length) return "";
    const points = pts.map(([x, y]) => `${x * scaleX},${y * scaleY}`).join(" ");
    const isSelected  = selectedLineIds.has(line.id);
    const isSplitting = splitModeLineId === line.id;
    const isMerging   = mergeModeLineId === line.id;
    const isEditing   = editPolygonLineId === line.id;
    const extraClass  = isEditing ? " editing" : isSplitting ? " splitting" : isMerging ? " merging" : isSelected ? " selected" : "";
    return `<polygon class="line-polygon${extraClass}"
      data-id="${line.id}" points="${points}"
      title="Line ${line.line_index + 1}" style="pointer-events:all"/>`;
  }).join("")
  // Split vertical guide
  + `<line id="split-guide" x1="0" y1="0" x2="0" y2="0"
      stroke="#e67e22" stroke-width="2" stroke-dasharray="5,3"
      pointer-events="none" style="display:none"/>`
  // Polygon drawing overlay (filled by updateAddLineOverlay)
  + `<g id="add-line-group"></g>`
  // Polygon edit handles (filled by updateEditHandles)
  + `<g id="edit-handles-group"></g>`;

  updateAddLineOverlay();
  updateEditHandles();

  // ── Per-polygon click handling ───────────────────────────────────────────
  svg.querySelectorAll(".line-polygon").forEach(poly => {
    const id = parseInt(poly.dataset.id);
    poly.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (editPolygonLineId === null) showPolyContextMenu(e, id);
    });
    poly.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (addLineMode) return; // clicks belong to the draw gesture
      if (editPolygonLineId !== null) return; // in edit mode, clicks are for handles

      if (splitModeLineId !== null) {
        if (id !== splitModeLineId) return;
        const svgRect = svg.getBoundingClientRect();
        // ÷ zoom to get viewBox coords, consistent with polygon point coords
        const clickXsvg = (e.clientX - svgRect.left) / _viewZoom;
        const line = currentFolioData.lines.find(l => l.id === splitModeLineId);
        if (!line?.polygon?.length) return;
        const xs = line.polygon.map(([x]) => x * scaleX);
        const polyXmin = Math.min(...xs), polyXmax = Math.max(...xs);
        const ratio = Math.max(0.01, Math.min(0.99, (clickXsvg - polyXmin) / (polyXmax - polyXmin)));
        const capturedId = splitModeLineId;
        const snap = snapshotLine(line);
        exitSplitMode();
        try {
          const result = await api("POST", `/lines/${capturedId}/split`, { x_ratio: ratio });
          pushUndo(`split line ${snap.line_index + 1}`, async () => {
            await api("DELETE", `/lines/${result.line_a.id}`);
            await api("DELETE", `/lines/${result.line_b.id}`);
            await api("POST", "/lines/restore", snap);
          });
          await loadReviewFolio(currentFolioData.folio_id);
        } catch (err) { alert(`Split failed: ${err.message}`); }
        return;
      }

      if (mergeModeLineId !== null) {
        if (id === mergeModeLineId) { exitMergeMode(); return; }
        const firstId = mergeModeLineId;
        const snapA = snapshotLine(currentFolioData.lines.find(l => l.id === firstId));
        const snapB = snapshotLine(currentFolioData.lines.find(l => l.id === id));
        exitMergeMode();
        try {
          const result = await api("POST", "/lines/merge", { line_ids: [firstId, id] });
          pushUndo(`merge lines ${snapA.line_index + 1} & ${snapB.line_index + 1}`, async () => {
            await api("DELETE", `/lines/${result.id}`);
            await api("POST", "/lines/restore", snapA);
            await api("POST", "/lines/restore", snapB);
          });
          await loadReviewFolio(currentFolioData.folio_id);
        } catch (err) { alert(`Merge failed: ${err.message}`); }
        return;
      }

      const item = document.getElementById(`line-item-${id}`);
      if (item) {
        // Scroll the selected item to the top of the line list
        const list = document.getElementById("line-list");
        list.scrollTo({ top: item.offsetTop - list.offsetTop, behavior: "smooth" });
      }
      toggleLineSelection(id, item);
    });
  });
}

// ── Zoom / pan ────────────────────────────────────────────────────────────────

function applyViewTransform() {
  const root = document.getElementById("page-transform-root");
  if (root) root.style.transform = `translate(${_viewPanX}px, ${_viewPanY}px) scale(${_viewZoom})`;
  const lbl = document.getElementById("zoom-level");
  if (lbl) lbl.textContent = `${Math.round(_viewZoom * 100)}%`;
}

function resetView() {
  _viewZoom = 1; _viewPanX = 0; _viewPanY = 0;
  applyViewTransform();
}

function stepZoom(factor) {
  const wrap = document.getElementById("page-canvas-wrap");
  const r    = wrap.getBoundingClientRect();
  const cx   = r.width  / 2;
  const cy   = r.height / 2;
  const nz   = Math.max(0.25, Math.min(8, _viewZoom * factor));
  _viewPanX  = cx - (cx - _viewPanX) * (nz / _viewZoom);
  _viewPanY  = cy - (cy - _viewPanY) * (nz / _viewZoom);
  _viewZoom  = nz;
  applyViewTransform();
}

document.getElementById("btn-zoom-in").addEventListener("click",    () => stepZoom(1.25));
document.getElementById("btn-zoom-out").addEventListener("click",   () => stepZoom(1 / 1.25));
document.getElementById("btn-zoom-reset").addEventListener("click", resetView);

const _wrap = document.getElementById("page-canvas-wrap");

// Scroll-wheel zoom centred on the cursor
_wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r  = _wrap.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const nz = Math.max(0.25, Math.min(8, _viewZoom * factor));
  _viewPanX = cx - (cx - _viewPanX) * (nz / _viewZoom);
  _viewPanY = cy - (cy - _viewPanY) * (nz / _viewZoom);
  _viewZoom = nz;
  applyViewTransform();
}, { passive: false });

// Click-drag pan (only when no drawing mode is active)
_wrap.addEventListener("mousedown", (e) => {
  if (addLineMode || splitModeLineId !== null || mergeModeLineId !== null || editPolygonLineId !== null) return;
  if (e.button !== 0) return;
  _panStart = { bx: e.clientX - _viewPanX, by: e.clientY - _viewPanY };
  _panMoved = false;
  _wrap.classList.add("panning");
});

document.addEventListener("mousemove", (e) => {
  // Polygon vertex drag — handled before pan
  if (_editDrag !== null && editPolygonLineId !== null) {
    const line = currentFolioData?.lines.find(l => l.id === editPolygonLineId);
    if (line?.polygon) {
      const svg    = document.getElementById("seg-overlay");
      const img    = document.getElementById("page-canvas");
      const r      = svg.getBoundingClientRect();
      const scaleX = img.naturalWidth  / img.clientWidth;
      const scaleY = img.naturalHeight / img.clientHeight;
      const svgX   = (e.clientX - r.left) / _viewZoom;
      const svgY   = (e.clientY - r.top)  / _viewZoom;
      line.polygon[_editDrag.idx] = [Math.round(svgX * scaleX), Math.round(svgY * scaleY)];
      updateEditHandles();
    }
    return;
  }
  if (!_panStart) return;
  const dx = e.clientX - (_panStart.bx + _viewPanX);
  const dy = e.clientY - (_panStart.by + _viewPanY);
  if (!_panMoved && Math.abs(dx) + Math.abs(dy) < 4) return;
  _panMoved = true;
  _viewPanX = e.clientX - _panStart.bx;
  _viewPanY = e.clientY - _panStart.by;
  applyViewTransform();
});

document.addEventListener("mouseup", () => {
  _editDrag = null;
  if (!_panStart) return;
  _panStart = null;
  _wrap.classList.remove("panning");
});

// Reset view whenever a new folio image is loaded
function resetViewOnLoad() { resetView(); }

// ── Text pool panel resize ────────────────────────────────────────────────────
(function () {
  const panel        = document.getElementById("text-pool-panel");
  const wHandle      = document.getElementById("pool-resize-handle");
  const hHandle      = document.getElementById("pool-resize-height-handle");
  if (!panel || !wHandle || !hHandle) return;

  // Restore persisted dimensions
  const savedW = localStorage.getItem("kraken_pool_width");
  const savedH = localStorage.getItem("kraken_pool_height");
  if (savedW) panel.style.width  = savedW + "px";
  if (savedH) panel.style.height = savedH + "px";

  let mode = null;   // "width" | "height" | null
  let startX, startY, startW, startH;

  function beginResize(e, m) {
    e.preventDefault();
    mode   = m;
    startX = e.clientX;
    startY = e.clientY;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;
    document.body.style.userSelect = "none";
    if (m === "width")  { wHandle.classList.add("dragging"); document.body.style.cursor = "col-resize"; }
    if (m === "height") { hHandle.classList.add("dragging"); document.body.style.cursor = "row-resize"; }
  }

  wHandle.addEventListener("mousedown", (e) => beginResize(e, "width"));
  hHandle.addEventListener("mousedown", (e) => beginResize(e, "height"));

  document.addEventListener("mousemove", (e) => {
    if (!mode) return;
    if (mode === "width") {
      // Dragging left widens the panel (panel is on the right edge)
      const newW = Math.max(140, Math.min(560, startW + (startX - e.clientX)));
      panel.style.width = newW + "px";
    } else {
      const newH = Math.max(80, Math.min(window.innerHeight - 160, startH + (e.clientY - startY)));
      panel.style.height = newH + "px";
    }
  });

  document.addEventListener("mouseup", () => {
    if (!mode) return;
    if (mode === "width")  { wHandle.classList.remove("dragging"); localStorage.setItem("kraken_pool_width",  panel.offsetWidth);  }
    if (mode === "height") { hHandle.classList.remove("dragging"); localStorage.setItem("kraken_pool_height", panel.offsetHeight); }
    mode = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
})();

// ── Add-line: polygon drawing on the SVG surface ─────────────────────────────

function exitAddLineMode() {
  addLineMode    = false;
  addLinePolygon = [];
  _addLineCursor = null;
  document.getElementById("btn-add-line").textContent = "+ Add Line";
  document.getElementById("btn-add-line").classList.remove("active-mode");
  document.getElementById("add-line-hint").style.display = "none";
  renderOverlay();
}

document.getElementById("btn-done-editing").addEventListener("click", () => exitEditPolygonMode(true));

// ── Help modal ────────────────────────────────────────────────────────────────

function openHelpModal() {
  document.getElementById("help-modal").style.display = "";
  document.getElementById("help-modal-backdrop").style.display = "";
}

function closeHelpModal() {
  document.getElementById("help-modal").style.display = "none";
  document.getElementById("help-modal-backdrop").style.display = "none";
}

document.getElementById("btn-help").addEventListener("click", openHelpModal);
document.getElementById("help-close-btn").addEventListener("click", closeHelpModal);
document.getElementById("help-modal-backdrop").addEventListener("click", closeHelpModal);
document.getElementById("help-modal").addEventListener("click", e => e.stopPropagation());

document.getElementById("btn-add-line").addEventListener("click", () => {
  if (addLineMode) { exitAddLineMode(); return; }
  addLineMode = true;
  document.getElementById("btn-add-line").textContent = "Cancel Add";
  document.getElementById("btn-add-line").classList.add("active-mode");
  document.getElementById("add-line-hint").style.display = "";
  document.getElementById("add-line-hint").textContent =
    "Click to place points — click the first point (or double-click) to close the polygon";
  renderOverlay();
});

// Prevent native image-drag from interfering with the SVG overlay.
document.getElementById("page-canvas").addEventListener("dragstart", e => e.preventDefault());

const _svgEl = document.getElementById("seg-overlay");

// Close context menu when clicking anywhere outside it
document.addEventListener("click", (e) => {
  if (_ctxMenuLineId !== null && !e.target.closest("#poly-context-menu")) hidePolyContextMenu();
});

// Suppress browser context menu on the SVG surface (we use our own)
_svgEl.addEventListener("contextmenu", e => e.preventDefault());

// ── Polygon point placement ───────────────────────────────────────────────────
_svgEl.addEventListener("click", async (e) => {
  if (!addLineMode) return;
  e.stopPropagation();

  const r   = _svgEl.getBoundingClientRect();
  // Divide by zoom to convert from screen pixels → SVG viewBox coords
  const mx  = (e.clientX - r.left) / _viewZoom;
  const my  = (e.clientY - r.top)  / _viewZoom;

  // Snap-close when clicking near the first vertex (≥ 3 points already placed)
  if (addLinePolygon.length >= 3) {
    const img    = document.getElementById("page-canvas");
    const scaleX = img.clientWidth  / img.naturalWidth;
    const scaleY = img.clientHeight / img.naturalHeight;
    const [fx, fy] = addLinePolygon[0];
    // Compare in screen pixels: multiply viewBox delta by zoom
    const dx = (mx - fx * scaleX) * _viewZoom;
    const dy = (my - fy * scaleY) * _viewZoom;
    if (Math.sqrt(dx * dx + dy * dy) <= ADD_LINE_CLOSE_DIST) {
      await submitAddLinePolygon();
      return;
    }
  }

  // Add a new vertex (convert from SVG viewBox coords → image natural coords)
  const img    = document.getElementById("page-canvas");
  const scaleX = img.naturalWidth  / img.clientWidth;
  const scaleY = img.naturalHeight / img.clientHeight;
  addLinePolygon.push([Math.round(mx * scaleX), Math.round(my * scaleY)]);
  updateAddLineOverlay();
});

// Double-click closes the polygon without needing to hit the first vertex exactly
_svgEl.addEventListener("dblclick", async (e) => {
  if (!addLineMode || addLinePolygon.length < 3) return;
  e.stopPropagation();
  // The preceding click already added a duplicate point — remove it
  addLinePolygon.pop();
  await submitAddLinePolygon();
});

// ── Mousemove: live preview edge + split guide ────────────────────────────────
_svgEl.addEventListener("mousemove", (e) => {
  const r  = _svgEl.getBoundingClientRect();
  // Always convert to SVG viewBox coords (÷ zoom)
  const mx = (e.clientX - r.left) / _viewZoom;
  const my = (e.clientY - r.top)  / _viewZoom;

  if (addLineMode) {
    _addLineCursor = { x: mx, y: my };
    updateAddLineOverlay();
    return;
  }

  // Split vertical guide
  if (splitModeLineId !== null) {
    const guide = _svgEl.querySelector("#split-guide");
    const line  = currentFolioData?.lines.find(l => l.id === splitModeLineId);
    if (!line?.polygon?.length || !guide) return;
    const img    = document.getElementById("page-canvas");
    const scaleX = img.clientWidth  / img.naturalWidth;
    const scaleY = img.clientHeight / img.naturalHeight;
    const xs = line.polygon.map(([x]) => x * scaleX);
    const ys = line.polygon.map(([, y]) => y * scaleY);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    if (mx < xMin || mx > xMax) { guide.style.display = "none"; return; }
    guide.setAttribute("x1", mx); guide.setAttribute("x2", mx);
    guide.setAttribute("y1", yMin); guide.setAttribute("y2", yMax);
    guide.style.display = "";
  }
});

_svgEl.addEventListener("mouseleave", () => {
  if (!addLineMode) return;
  _addLineCursor = null;
  updateAddLineOverlay();
});

// ── Render the in-progress polygon into #add-line-group ──────────────────────
function updateAddLineOverlay() {
  const grp = document.getElementById("add-line-group");
  if (!grp) return;

  if (!addLineMode || addLinePolygon.length === 0) { grp.innerHTML = ""; return; }

  const img    = document.getElementById("page-canvas");
  const scaleX = img.clientWidth  / img.naturalWidth;
  const scaleY = img.clientHeight / img.naturalHeight;

  const screen = addLinePolygon.map(([x, y]) => [x * scaleX, y * scaleY]);
  let html = "";

  const c = _overlayColor;  // current overlay colour

  // Filled polygon (once ≥ 3 points)
  if (screen.length >= 3) {
    const pts = screen.map(([x, y]) => `${x},${y}`).join(" ");
    html += `<polygon points="${pts}" fill="${c}" fill-opacity="0.12" stroke="${c}"
      stroke-width="1.5" stroke-dasharray="5,3" pointer-events="none"/>`;
  } else if (screen.length === 2) {
    html += `<line x1="${screen[0][0]}" y1="${screen[0][1]}"
      x2="${screen[1][0]}" y2="${screen[1][1]}"
      stroke="${c}" stroke-width="1.5" stroke-dasharray="5,3" pointer-events="none"/>`;
  }

  // Live preview edge from last point to cursor
  if (_addLineCursor && screen.length >= 1) {
    const [lx, ly] = screen[screen.length - 1];
    html += `<line x1="${lx}" y1="${ly}" x2="${_addLineCursor.x}" y2="${_addLineCursor.y}"
      stroke="${c}" stroke-width="1" stroke-dasharray="3,3" opacity="0.6" pointer-events="none"/>`;
  }

  // Closing preview edge from cursor back to first point (ghost of the final edge)
  if (_addLineCursor && screen.length >= 2) {
    const [fx, fy] = screen[0];
    html += `<line x1="${_addLineCursor.x}" y1="${_addLineCursor.y}" x2="${fx}" y2="${fy}"
      stroke="${c}" stroke-width="1" stroke-dasharray="2,5" opacity="0.3" pointer-events="none"/>`;
  }

  // Vertex circles
  screen.forEach(([x, y]) => {
    html += `<circle cx="${x}" cy="${y}" r="4"
      fill="${c}" fill-opacity="0.7" stroke="${c}" stroke-width="1.5" pointer-events="none"/>`;
  });

  // First-vertex close-halo when cursor is near enough (threshold in screen pixels)
  if (screen.length >= 3 && _addLineCursor) {
    const [fx, fy] = screen[0];
    const dx = (_addLineCursor.x - fx) * _viewZoom;
    const dy = (_addLineCursor.y - fy) * _viewZoom;
    if (Math.sqrt(dx * dx + dy * dy) <= ADD_LINE_CLOSE_DIST) {
      html += `<circle cx="${fx}" cy="${fy}" r="11"
        fill="rgba(39,174,96,0.25)" stroke="#27ae60" stroke-width="2" pointer-events="none"/>`;
    }
  }

  // First vertex — larger anchor dot
  if (screen.length >= 1) {
    const [fx, fy] = screen[0];
    html += `<circle cx="${fx}" cy="${fy}" r="6"
      fill="${c}" stroke="#fff" stroke-width="1.5" pointer-events="none"/>`;
  }

  grp.innerHTML = html;
}

// ── Submit the completed polygon to the backend ───────────────────────────────
async function submitAddLinePolygon() {
  const polygon = [...addLinePolygon];
  exitAddLineMode();

  try {
    const newLine = await api("POST", `/folios/${currentFolioData.folio_id}/lines`, { polygon });
    currentFolioData.lines.push({
      id:           newLine.id,
      line_index:   newLine.line_index,
      crop_url:     newLine.crop_url,
      crop_path:    newLine.crop_path || null,
      polygon:      newLine.polygon,
      transcription: null,
      confirmed:    false,
    });
    pushUndo("add line", async () => {
      await api("DELETE", `/lines/${newLine.id}`);
      currentFolioData.lines = currentFolioData.lines.filter(l => l.id !== newLine.id);
      renderLineList();
    });
    renderLineList();
  } catch (err) {
    alert(`Add line failed: ${err.message}`);
  }
}

window.addEventListener("resize", () => { renderOverlay(); applyViewTransform(); });

// ── TRAINING VIEW ─────────────────────────────────────────────────────────────

let activeJobId = null;
let logEventSource = null;
let _jobPollTimer = null;

// Poll job status every 5 s while any job is running so the table stays
// current without the user having to click anything.
function startJobPolling() {
  if (_jobPollTimer) return;
  _jobPollTimer = setInterval(async () => {
    const jobs = await api("GET", "/training/jobs").catch(() => []);
    const anyRunning = jobs.some(j => j.status === "running");
    // Refresh the table in place (don't wipe the active log stream)
    const wrap = document.getElementById("jobs-table-wrap");
    if (wrap && jobs.length) {
      wrap.innerHTML = `
        <table>
          <thead><tr><th>#</th><th>Type</th><th>Status</th><th>Dataset</th><th>Started</th><th>Finished</th><th></th></tr></thead>
          <tbody>
            ${jobs.map(j => `
              <tr>
                <td>${j.id}</td>
                <td>${j.type}</td>
                <td>${badge(j.status)}</td>
                <td>${j.dataset_id || "—"}</td>
                <td class="text-muted">${j.started_at ? new Date(j.started_at).toLocaleString() : "—"}</td>
                <td class="text-muted">${j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}</td>
                <td>${j.log_path
                  ? `<button class="btn btn-secondary btn-sm" onclick="startLogStream(${j.id}, '${j.status}')">${j.status === "running" ? "View logs" : j.status === "failed" ? "View error log" : "Replay logs"}</button>`
                  : ""
                }</td>
              </tr>`).join("")}
          </tbody>
        </table>`;
    }
    // Update the active-job badge if we have an active job
    if (activeJobId) {
      const activeJob = jobs.find(j => j.id === activeJobId);
      if (activeJob && activeJob.status !== "running") {
        document.getElementById("active-job-badge").innerHTML = badge(activeJob.status) + ` Job #${activeJobId}`;
        document.getElementById("btn-stop-train").disabled = true;
        document.getElementById("btn-start-train").disabled = false;
      }
    }
    if (!anyRunning) stopJobPolling();
  }, 5000);
}

function stopJobPolling() {
  if (_jobPollTimer) { clearInterval(_jobPollTimer); _jobPollTimer = null; }
}

async function populateTrainingSelects() {
  const datasets = await api("GET", "/datasets");
  const models = await api("GET", "/models");

  // Compile select: show all datasets, mark compiled ones
  const compileSel = document.getElementById("compile-dataset-select");
  compileSel.innerHTML = '<option value="">— Select dataset —</option>' +
    datasets.map(d => `<option value="${d.id}">${d.name}${d.compiled ? " ✓ compiled" : ""}</option>`).join("");

  // Train select: only compiled datasets are usable; grey out the rest
  const trainSel = document.getElementById("train-dataset-select");
  trainSel.innerHTML = '<option value="">— Select dataset —</option>' +
    datasets.map(d => `<option value="${d.id}" ${d.compiled ? "" : "disabled"}>${d.name}${d.compiled ? " ✓ compiled" : " (not compiled)"}</option>`).join("");

  const baseModel = document.getElementById("train-base-model");
  baseModel.innerHTML = '<option value="">Train from scratch</option>' +
    models.map(m => `<option value="${m.path}">${m.relative_path}</option>`).join("");
}

document.getElementById("btn-compile").addEventListener("click", async () => {
  const dsId = document.getElementById("compile-dataset-select").value;
  if (!dsId) { setStatus("compile-status", "Select a dataset first.", "error"); return; }
  setStatus("compile-status", "Compiling…");
  try {
    const data = await api("POST", `/training/compile/${dsId}`);
    if (data.status === "done") {
      setStatus("compile-status", `Job ${data.job_id}: compiled successfully.`, "success");
    } else {
      const el = document.getElementById("compile-status");
      el.textContent = `Job ${data.job_id}: failed. `;
      el.className = "status error";
      const btn = document.createElement("button");
      btn.className = "btn btn-secondary btn-sm";
      btn.textContent = "View log";
      btn.onclick = () => startLogStream(data.job_id, "failed");
      el.appendChild(btn);
    }
    loadJobs();
  } catch (err) {
    setStatus("compile-status", `Error: ${err.message}`, "error");
  }
});

document.getElementById("btn-start-train").addEventListener("click", async () => {
  const dsId = document.getElementById("train-dataset-select").value;
  const name = document.getElementById("train-output-name").value.trim();
  const epochs = parseInt(document.getElementById("train-epochs").value);
  const base = document.getElementById("train-base-model").value;
  if (!dsId || !name) { setStatus("train-status", "Dataset and run name are required.", "error"); return; }

  setStatus("train-status", "Starting…");
  try {
    const data = await api("POST", "/training/start", {
      dataset_id: parseInt(dsId), output_name: name,
      epochs, base_model: base || null,
    });
    setStatus("train-status", `Job ${data.job_id} started (PID ${data.pid}).`, "success");
    document.getElementById("btn-stop-train").disabled = false;
    document.getElementById("btn-start-train").disabled = true;
    activeJobId = data.job_id;
    startLogStream(data.job_id);
    loadJobs();
    startJobPolling();
  } catch (err) {
    setStatus("train-status", `Error: ${err.message}`, "error");
  }
});

document.getElementById("btn-stop-train").addEventListener("click", async () => {
  if (!activeJobId) return;
  await api("POST", `/training/jobs/${activeJobId}/stop`);
  setStatus("train-status", "Stop signal sent.", "info");
  document.getElementById("btn-stop-train").disabled = true;
  document.getElementById("btn-start-train").disabled = false;
});

function startLogStream(jobId, knownStatus) {
  if (logEventSource) logEventSource.close();
  const logBox = document.getElementById("log-box");
  logBox.textContent = "";
  document.getElementById("active-job-badge").innerHTML = badge(knownStatus || "running") + ` Job #${jobId}`;
  // Scroll training section into view so the user sees the log
  document.getElementById("log-box").scrollIntoView({ behavior: "smooth", block: "nearest" });

  logEventSource = new EventSource(`/training/jobs/${jobId}/logs`);
  logEventSource.onmessage = (e) => {
    if (e.data === "[DONE]") {
      logEventSource.close();
      // Keep the known status badge rather than always showing "done"
      if (!knownStatus || knownStatus === "running") {
        document.getElementById("active-job-badge").innerHTML = badge("done") + ` Job #${jobId}`;
      }
      document.getElementById("btn-stop-train").disabled = true;
      document.getElementById("btn-start-train").disabled = false;
      loadJobs();
      return;
    }
    logBox.textContent += e.data + "\n";
    logBox.scrollTop = logBox.scrollHeight;
  };
  logEventSource.onerror = () => {
    logEventSource.close();
    loadJobs();
  };
}

async function loadJobs() {
  const jobs = await api("GET", "/training/jobs");
  const wrap = document.getElementById("jobs-table-wrap");
  if (!jobs.length) { wrap.innerHTML = '<div class="empty-state">No jobs yet.</div>'; return jobs; }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Type</th><th>Status</th><th>Dataset</th><th>Started</th><th>Finished</th><th></th></tr></thead>
      <tbody>
        ${jobs.map(j => `
          <tr>
            <td>${j.id}</td>
            <td>${j.type}</td>
            <td>${badge(j.status)}</td>
            <td>${j.dataset_id || "—"}</td>
            <td class="text-muted">${j.started_at ? new Date(j.started_at).toLocaleString() : "—"}</td>
            <td class="text-muted">${j.finished_at ? new Date(j.finished_at).toLocaleString() : "—"}</td>
            <td>${j.log_path
              ? `<button class="btn btn-secondary btn-sm" onclick="startLogStream(${j.id}, '${j.status}')">${j.status === "running" ? "View logs" : j.status === "failed" ? "View error log" : "Replay logs"}</button>`
              : ""
            }</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
  return jobs;
}

// ── MODELS VIEW ───────────────────────────────────────────────────────────────

async function loadModels() {
  const models = await api("GET", "/models");
  const wrap = document.getElementById("models-table-wrap");
  if (!models.length) { wrap.innerHTML = '<div class="empty-state">No models found in data/models/.</div>'; return; }
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Path</th><th>Size</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${models.map(m => `
          <tr>
            <td>${m.name}</td>
            <td class="text-muted">${m.relative_path}</td>
            <td>${m.size_mb} MB</td>
            <td class="text-muted">${new Date(m.created_at * 1000).toLocaleString()}</td>
            <td><a class="btn btn-secondary btn-sm" href="/models/download/${encodeURIComponent(m.relative_path)}">Download</a></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadDatasets();
