// web/app.js
// Connects to the backend WebSocket, renders each component as a real
// DOM element positioned from actual Scene state, and supports
// dragging new components from the dock onto the canvas.
const canvas = document.getElementById("canvas");
const canvasWrap = document.getElementById("canvas-wrap");
const canvasViewport = document.getElementById("canvas-viewport");

const palette = document.getElementById("palette");

let simulationZoom = 1;

let simulationPanX = 0;
let simulationPanY = 0;

let omsMode = "design";
let latestPlc = {};

let currentProjectFilename = null;

let projectDirty = false;

function markDirty() {
  if (projectDirty) return;
  projectDirty = true;
  updateDirtyUI();
}

function markClean() {
  if (!projectDirty) return;
  projectDirty = false;
  updateDirtyUI();
}

function updateDirtyUI() {
  document.getElementById("dirty-indicator").classList.toggle("hidden", !projectDirty);
  document.title = (projectDirty ? "* " : "") + "OMS Web Prototype";
}

function updateFileNameUI() {
  document.getElementById("current-file-name").textContent =
    currentProjectFilename || "Untitled";
}

const designModeBtn = document.getElementById("design-mode-btn");
const simulationModeBtn = document.getElementById("simulation-mode-btn");
const runtimeModeBtn = document.getElementById("runtime-mode-btn");
const modeDescription = document.getElementById("mode-description");
const runtimeAlarmBar = document.getElementById("runtime-alarm-bar");

let panning = false;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;

function isDesignMode() {
  return omsMode === "design";
}

function isSimulationMode() {
  return omsMode === "simulation";
}

function isRuntimeMode() {
  return omsMode === "runtime";
}

//const MODE_DESCRIPTIONS = {
//  design: "Engineering / configuration mode — build the machine.",
//  simulation: "Testing the machine without PLC hardware.",
//  runtime: "Connected to the PLC — live operation.",
//};

// ---------- Undo / Redo (Design mode only) ----------
// History entries are snapshots of scene objects (same shape as a
// project file's "objects" list). Only component placement/state is
// tracked -- PLC mapping and connection settings are untouched.

const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 50;

function snapshotObjects() {
  return JSON.stringify(Object.values(latestState));
}

// Call BEFORE making a design-mode change, so the pushed snapshot is
// the pre-change state to return to on Undo.
function pushHistory() {
  if (!isDesignMode()) return;
  undoStack.push(snapshotObjects());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const design = isDesignMode();
  document.getElementById("undo-btn").disabled = !design || undoStack.length === 0;
  document.getElementById("redo-btn").disabled = !design || redoStack.length === 0;
}

function restoreSnapshot(snapshot) {
  ws.send(JSON.stringify({
    action: "restore_objects",
    objects: JSON.parse(snapshot),
  }));
}

document.getElementById("undo-btn").addEventListener("click", () => {
  if (!isDesignMode() || undoStack.length === 0) return;
  redoStack.push(snapshotObjects());
  restoreSnapshot(undoStack.pop());
  updateUndoRedoButtons();
});

document.getElementById("redo-btn").addEventListener("click", () => {
  if (!isDesignMode() || redoStack.length === 0) return;
  undoStack.push(snapshotObjects());
  restoreSnapshot(redoStack.pop());
  updateUndoRedoButtons();
});

function updateModeUI() {
  const design = isDesignMode();

  designModeBtn.classList.toggle("active", omsMode === "design");
  simulationModeBtn?.classList.toggle("active", omsMode === "simulation");
  runtimeModeBtn.classList.toggle("active", omsMode === "runtime");

  //modeDescription.textContent = MODE_DESCRIPTIONS[omsMode] || "";

  document.body.classList.remove("mode-design", "mode-simulation", "mode-runtime");
  document.body.classList.add(`mode-${omsMode}`);

  // Components palette is a DESIGN-only operation.
  palette.style.pointerEvents = design ? "auto" : "none";
  palette.style.opacity = design ? "1" : "0.45";

  document.getElementById("open-project-btn").disabled = !design;
  document.getElementById("reset-view-btn").disabled = !design;
  updateUndoRedoButtons();

  updateRuntimeAlarmBar();

  // Re-render inspector because properties become read-only
  // outside of Design mode.
  renderPropertyPanel();
}

function updateRuntimeAlarmBar() {
  if (!runtimeAlarmBar) return;
  const lostComms = isRuntimeMode() && (!latestPlc.connected || !latestPlc.comms_healthy);
  runtimeAlarmBar.classList.toggle("hidden", !lostComms);
}

designModeBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({
    action: "set_mode",
    mode: "design",
  }));
});

simulationModeBtn?.addEventListener("click", () => {
  ws.send(JSON.stringify({
    action: "set_mode",
    mode: "simulation",
  }));
});

runtimeModeBtn.addEventListener("click", () => {
  if (!latestPlc.connected) {
    alert("Connect to a PLC before switching to Runtime.");
    return;
  }

  ws.send(JSON.stringify({
    action: "set_mode",
    mode: "runtime",
  }));
});

canvasViewport.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;

    e.preventDefault();

    const zoomStep = 0.1;

    if (e.deltaY < 0) {
      simulationZoom += zoomStep;
    } else {
      simulationZoom -= zoomStep;
    }

    simulationZoom = Math.max(
      0.5,
      Math.min(2.5, simulationZoom)
    );

    canvas.style.transform = `scale(${simulationZoom})`;

    const gridSize = 25 * simulationZoom;

    canvasViewport.style.backgroundSize =
      `${gridSize}px ${gridSize}px`;
  },
  { passive: false }
);

canvasWrap.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;

    e.preventDefault();

    const zoomStep = 0.1;

    if (e.deltaY < 0) {
      simulationZoom += zoomStep;
    } else {
      simulationZoom -= zoomStep;
    }

    simulationZoom = Math.max(0.5, Math.min(2.5, simulationZoom));

    canvas.style.transform = `scale(${simulationZoom})`;
    canvas.style.transformOrigin = "top left";
  },
  { passive: false }
);

let latestState = {};
// Cache of created DOM elements per tag_name, so we update in place
// instead of rebuilding the DOM every 50ms (which would restart CSS
// transitions/animations and cause flicker).
const elements = {};

// ---------- Properties dock ----------

const propertyBody = document.getElementById("property-body");
let selectedTag = null;

// Runs the initial mode-bar/palette state now that latestState,
// propertyBody and selectedTag (used by renderPropertyPanel(), which
// updateModeUI() calls) are all declared -- calling this any earlier
// throws "Cannot access 'selectedTag' before initialization" and
// aborts the rest of this script, including the drag-and-drop
// listeners further down.
updateModeUI();

// Editable design-time fields per component type, mirroring the
// original desktop app's PropertiesPanel field set/order (Name, X, Y,
// Width, Height, Rotation, Direction, Speed, then per-type fields).
// `key` is the state field read for the initial value; `send`
// (default = key) is the property name given to the backend's
// apply_property(), which dispatches to obj.set_<send>() -- some
// backend setters (e.g. CylinderBehavior.set_rotation_value) don't
// match their state key.
const PROPERTY_FIELDS = {
  conveyor: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 30, max: 5000, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 4, max: 200, suffix: " px" },
    { key: "rotation", send: "rotation_value", label: "Rotation", type: "number", min: 0, max: 359.9, step: "90", suffix: " °" },
    { key: "direction", send: "direction", label: "Direction", type: "select",
      options: [["1", "Forward"], ["0", "Reverse"]] },
    { key: "speed", send: "speed", label: "Speed", type: "number", min: 0, max: 5000, suffix: " mm/s" },
    { key: "box_width", send: "box_width", label: "Box Width", type: "number", min: 5, max: 200, suffix: " px" },
    { key: "box_height", send: "box_height", label: "Box Height", type: "number", min: 5, maxKey: "max_box_height", suffix: " px" },
    { key: "box_count", send: "box_count", label: "Box Count", type: "number", min: 1, step: "1", maxKey: "max_box_count" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
  cylinder: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 40, max: 1000, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 24, max: 1000, suffix: " px" },
    { key: "rotation", send: "rotation_value", label: "Rotation", type: "number", min: 0, max: 359.9, step: "90", suffix: " °" },
    { key: "speed", send: "speed", label: "Speed", type: "number", min: 0, max: 5000 },
    { key: "valve_type", send: "valve_type", label: "Valve Type", type: "select",
      options: [["single", "Single (1 tag)"], ["dual", "Dual (2 tags, hold)"]] },
    { key: "target_conveyor", send: "target_conveyor", label: "Push Box Off Conveyor", type: "component-select", filterTypes: ["conveyor"] },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
  motor: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 30, max: 5000, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 4, max: 200, suffix: " px" },
    { key: "rotation", send: "rotation_value", label: "Rotation", type: "number", min: 0, max: 359.9, step: "90", suffix: " °" },
    { key: "direction", send: "direction", label: "Direction", type: "select",
      options: [["1", "Forward"], ["0", "Reverse"]] },
    { key: "speed", send: "speed", label: "Speed", type: "number", min: 0, max: 5000, suffix: " mm/s" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1" , min: "0" },
  ],
  sensor: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 8, max: 200, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 8, max: 200, suffix: " px" },
    { key: "mode", send: "mode", label: "Mode", type: "select", options: [["NO", "Normally Open"], ["NC", "Normally Closed"]] },
    { key: "watch_tag", send: "watch_target", label: "Watch Component", type: "component-select" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
  push_button: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 12, max: 500, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 12, max: 500, suffix: " px" },
    { key: "color", send: "color_name", label: "Color", type: "select",
      options: [["Red", "Red"], ["Green", "Green"], ["Blue", "Blue"], ["Yellow", "Yellow"], ["Gray", "Gray"]] },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
  emergency_push_button: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 14, max: 500, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 14, max: 500, suffix: " px" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
  toggle_switch: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 20, max: 500, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 10, max: 500, suffix: " px" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
  tower_light: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 10, max: 500, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 30, max: 1000, suffix: " px" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
  label: [
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 20, max: 2000, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 16, max: 2000, suffix: " px" },
    { key: "text", send: "text", label: "Text", type: "text" },
    { key: "font_family", send: "font_family", label: "Font", type: "text" },
    { key: "font_size", send: "font_size", label: "Font Size", type: "number", min: 1, max: 200, step: "1" },
    { key: "bold", send: "bold", label: "Bold", type: "checkbox" },
    { key: "italic", send: "italic", label: "Italic", type: "checkbox" },
    { key: "background_color", send: "background_color", label: "Background", type: "color" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
  ],
};

// Read-only telemetry shown above the editable fields.
const STATUS_FIELDS = {
  conveyor: [["running", "Running"]],
  cylinder: [["extended", "Extended"], ["progress", "Progress"], ["moving", "Moving"]],
  motor: [["running", "Running"]],
  sensor: [["detected", "Detected"]],
  push_button: [["pressed", "Pressed"]],
  emergency_push_button: [["pressed", "Pressed"]],
  toggle_switch: [["on", "On"]],
  tower_light: [["red", "Red"], ["blue", "Blue"], ["green", "Green"], ["yellow", "Yellow"]],
};

// Fixed per-lamp colors -- keep in sync with
// core/components/tower_light.py's LAMP_ORDER.
const TOWER_LIGHT_LAMP_ORDER = ["red", "blue", "green", "yellow"];
const TOWER_LIGHT_LIT_COLORS = {
  red: "#e62828", blue: "#285ae6", green: "#32c83c", yellow: "#e6c81e",
};
const TOWER_LIGHT_DIM_COLORS = {
  red: "#5a2828", blue: "#28325a", green: "#28502d", yellow: "#5a5023",
};

// Base color per named option, used to fill the button face -- keep in
// sync with core/components/push_button.py's COLOR_PALETTE names.
const PUSH_BUTTON_COLORS = {
  Red: "#dc3c3c",
  Green: "#3cb454",
  Blue: "#3c64dc",
  Yellow: "#e6c828",
  Gray: "#a0a0a0",
};

function sendSetProperty(tagName, property, value) {
  ws.send(JSON.stringify({ action: "set_property", tag_name: tagName, property, value }));
}

function selectComponent(tagName) {
  selectedTag = tagName;
  for (const [tag, el] of Object.entries(elements)) {
    el.classList.toggle("selected", tag === tagName);
  }
  document.body.tabIndex = -1;
  document.body.focus({ preventScroll: true });
  renderPropertyPanel();
  renderComponentsList(latestState);
}

function deselectAll() {
  selectedTag = null;
  for (const el of Object.values(elements)) {
    el.classList.remove("selected");
  }
  renderPropertyPanel();
  renderComponentsList(latestState);
}

// Clicking empty canvas space (not a component) clears the selection,
// which also hides the now-unselected components' .tag labels.
canvasViewport.addEventListener("click", (e) => {
  if (e.target === canvas || e.target === canvasViewport) deselectAll();
});

function renderPropertyPanel() {
  const obj = selectedTag ? latestState[selectedTag] : null;

  if (!obj) {
    selectedTag = null;
    propertyBody.innerHTML = '<p class="empty">Select a component to view its properties.</p>';
    return;
  }

  const fields = PROPERTY_FIELDS[obj.type] || [];
  const statusFields = STATUS_FIELDS[obj.type] || [];

  const statusHtml = statusFields
    .map(([key, label]) => {
      const value = obj[key];
      const text = typeof value === "number" ? value.toFixed(2) : String(value);
      return `<div class="status-row"><span>${label}</span><span>${text}</span></div>`;
    })
    .join("");

  const fieldsHtml = fields
    .map((f) => {
      if (f.type === "select") {
        const opts = f.options
          .map(([val, text]) => `<option value="${val}" ${String(obj[f.key]) === val ? "selected" : ""}>${text}</option>`)
          .join("");
        return `<label>${f.label}<select data-send="${f.send}">${opts}</select></label>`;
      }
      if (f.type === "component-select") {
        const allowedTypes = f.filterTypes || ["conveyor", "cylinder"];
        const componentTags = Object.entries(latestState)
          .filter(([, o]) => allowedTypes.includes(o.type))
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([tag, o]) => ({
            tag,
            type: o.type,
          }));

        const current = obj[f.key];
        const opts = ['<option value="">(none)</option>']
          .concat(componentTags.map(
            ({ tag, type }) =>
              `<option value="${tag}" ${tag === current ? "selected" : ""}>${tag} (${type})</option>`
          ))
          .join("");

        return `<label>${f.label}<select data-send="${f.send}">${opts}</select></label>`;
      }
      if (f.type === "text") {
        const val = String(obj[f.key] ?? "").replace(/"/g, "&quot;");
        return `<label>${f.label}<input type="text" data-send="${f.send}" value="${val}"></label>`;
      }
      if (f.type === "checkbox") {
        return `<label class="checkbox-field"><input type="checkbox" data-send="${f.send}" ${obj[f.key] ? "checked" : ""}> ${f.label}</label>`;
      }
      if (f.type === "color") {
        return `<label>${f.label}<input type="color" data-send="${f.send}" value="${obj[f.key]}"></label>`;
      }
      const max = f.maxKey ? obj[f.maxKey] : f.max;
      const min = f.min !== undefined ? `min="${f.min}"` : "";
      const maxAttr = max !== undefined ? `max="${max}"` : "";
      const step = f.step ? `step="${f.step}"` : `step="any"`;
      const raw = obj[f.key];
      const val = (f.step && typeof raw === "number")
        ? Math.round(raw / parseFloat(f.step)) * parseFloat(f.step)
        : raw;
      return `<label>${f.label}${f.suffix ? ` (${f.suffix.trim()})` : ""}<input type="number" ${step} ${min} ${maxAttr} data-send="${f.send}" value="${val}"></label>`;
    })
    .join("");

  propertyBody.innerHTML = `
    <div class="selected-name">
      <input id="name-input" type="text" value="${selectedTag}">
    </div>
    <div id="status-block">${statusHtml}</div>
    <form id="property-form">
      ${fieldsHtml}

      ${
        isDesignMode()
          ? `
            <button type="submit" class="apply">Apply</button>
            <button type="button" class="delete" id="delete-component">
              Delete Component
            </button>
          `
          : `
            <div class="runtime-property-note">
              ${isRuntimeMode() ? "Runtime" : "Simulation"} mode — properties are read-only.
            </div>
          `
      }
    </form>
  `;

  if (!isDesignMode()) {
    propertyBody
      .querySelectorAll("#property-form input, #property-form select")
      .forEach((element) => {
        element.disabled = true;
      });
  }

  document.getElementById("delete-component")?.addEventListener("click", () => {
    if (!isDesignMode()) return;
    if (!selectedTag) return;

    const tag = selectedTag;

    if (!confirm(`Delete ${tag}?`)) return;

    sendDeleteComponent(tag);
    selectedTag = null;
    propertyBody.innerHTML =
      '<p class="empty">Select a component to view its properties.</p>';
  });

  document.getElementById("name-input").addEventListener("change", (e) => {
    const newName = e.target.value.trim();
    if (!selectedTag || !newName || newName === selectedTag) return;

    sendSetProperty(selectedTag, "name", newName);
    pushHistory();
    markDirty();
    selectedTag = newName;
  });

  document.getElementById("property-form").addEventListener("submit", (e) => {
    e.preventDefault();
    pushHistory();
    markDirty();
    for (const input of e.target.querySelectorAll("[data-send]")) {
      const value = input.type === "checkbox" ? (input.checked ? 1 : 0) : input.value;
      sendSetProperty(selectedTag, input.dataset.send, value);
    }
  });
}

const ws = new WebSocket(`ws://${location.host}/ws`);


ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  // One-off reply to a "plc_validate" command, not part of the
  // regular tick broadcast (which always has an "objects" key).
  if (msg.plc_validation !== undefined) {
    showValidationResult(msg.plc_validation);
    return;
  }

  if (msg.project_data !== undefined) {
    saveProjectData(msg.project_data);
    return;
  }

  if (msg.mode_error) {
    alert(msg.mode_error);
    return;
  }

  if (msg.mode && msg.mode !== omsMode) {
    omsMode = msg.mode;
    updateModeUI();
  }

  latestState = msg.objects || {};
  latestPlc = msg.plc || {};
  render(latestState);
  renderPlcStatus(latestPlc);
  renderMappingTable(latestPlc, latestState);
  updateRuntimeAlarmBar();
};

function sendSetPoint(tagName, point, value) {
  ws.send(JSON.stringify({ action: "set_point", tag_name: tagName, point, value }));
}

function sendAddComponent(componentType, x, y) {
  pushHistory();
  markDirty();
  ws.send(JSON.stringify({ action: "add_component", component_type: componentType, x, y }));
}

let currentFileHandle = null;
const supportsFileSystemAccess = "showSaveFilePicker" in window;

async function pickSaveHandle(suggestedName) {
  try {
    return await window.showSaveFilePicker({
      suggestedName: `${suggestedName}.oms`,
      types: [{ description: "OMS Project", accept: { "application/json": [".oms"] } }],
    });
  } catch (err) {
    return null; // user cancelled the picker
  }
}

async function saveProjectData(data) {
  if (supportsFileSystemAccess && currentFileHandle) {
    const writable = await currentFileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    markClean();
    return;
  }
  downloadProjectBlob(data); // fallback -- may get renamed by the browser
}

function downloadProjectBlob(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentProjectFilename || "project"}.oms`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  markClean();
}

function requestProjectSave() {
  ws.send(JSON.stringify({ action: "save_project" }));
}

function saveProjectAsClassic() {
  const name = prompt("Save project as:", currentProjectFilename || "project");
  if (!name) return;
  currentProjectFilename = name.replace(/\.oms$/i, "");
  updateFileNameUI();
  requestProjectSave();
}

document.getElementById("save-as-project-btn").addEventListener("click", async () => {
  if (supportsFileSystemAccess) {
    const handle = await pickSaveHandle(currentProjectFilename || "project");
    if (!handle) return;
    currentFileHandle = handle;
    currentProjectFilename = handle.name.replace(/\.oms$/i, "");
    updateFileNameUI();
    requestProjectSave();
    return;
  }
  saveProjectAsClassic();
});

document.getElementById("open-project-btn").addEventListener("click", () => {
  document.getElementById("open-project-input").click();
});

async function performSave() {
  if (supportsFileSystemAccess) {
    if (!currentFileHandle) {
      currentFileHandle = await pickSaveHandle(currentProjectFilename || "project");
      if (!currentFileHandle) return;
      currentProjectFilename = currentFileHandle.name.replace(/\.oms$/i, "");
      updateFileNameUI();
    }
    requestProjectSave();
    return;
  }
  if (!currentProjectFilename) return saveProjectAsClassic();
  requestProjectSave();
}

document.getElementById("save-project-btn").addEventListener("click", performSave);

document.getElementById("open-project-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (projectDirty) {
    const shouldSave = confirm(
      "You have unsaved changes. OK = save current project first, then open. Cancel = discard changes and open."
    );
    if (shouldSave) await performSave();
  }

  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (err) {
      alert("Not a valid .oms project file.");
      return;
    }
    currentProjectFilename = file.name.replace(/\.oms$/i, "");
    updateFileNameUI();
    markClean();
    deselectAll();
    applyLoadedConnectionSettings(data.plc_connection);
    ws.send(JSON.stringify({ action: "load_project", data }));
  };
  reader.readAsText(file);
  e.target.value = ""; // allow re-opening the same file later
});

document.getElementById("reset-view-btn").addEventListener("click", () => {
  if (!isDesignMode()) return;
  if (!confirm("Remove all components from the simulation area?")) return;
  pushHistory();
  markDirty();
  ws.send(JSON.stringify({ action: "reset_view" }));
});

function sendDeleteComponent(tagName) {
  if (!tagName) return;
  pushHistory();
  markDirty();
  ws.send(JSON.stringify({
    action: "delete_component",
    tag_name: tagName
  }));
}

// ---------- Rendering ----------

function render(state) {
  // Remove graphical elements that no longer exist in the simulation.
  for (const [tagName, el] of Object.entries(elements)) {
    if (!state[tagName]) {
      el.remove();
      delete elements[tagName];

      if (selectedTag === tagName) {
        selectedTag = null;
        propertyBody.innerHTML =
          '<p class="empty">Select a component to view its properties.</p>';
      }
    }
  }

  // Create/update components that exist in the simulation.
  for (const [tagName, obj] of Object.entries(state)) {
    if (obj.type === "conveyor") renderConveyor(tagName, obj);
    else if (obj.type === "cylinder") renderCylinder(tagName, obj);
    else if (obj.type === "motor") renderMotor(tagName, obj);
    else if (obj.type === "sensor") renderSensor(tagName, obj);
    else if (obj.type === "push_button") renderPushButton(tagName, obj);
    else if (obj.type === "emergency_push_button") renderEmergencyPushButton(tagName, obj);
    else if (obj.type === "toggle_switch") renderToggleSwitch(tagName, obj);
    else if (obj.type === "tower_light") renderTowerLight(tagName, obj);
    else if (obj.type === "label") renderLabel(tagName, obj);
  }

  renderComponentsList(state);
  updateSelectedStatus();
}

let componentsListKey = null;

// Two-letter monogram + accent color per component type, so the list
// reads at a glance instead of showing bare tag names.
const TYPE_BADGE = {
  conveyor: { label: "CV", color: "#3a7bd5" },
  cylinder: { label: "CY", color: "#c9822e" },
  motor: { label: "MO", color: "#3cce80" },
  sensor: { label: "SE", color: "#a259d9" },
  push_button: { label: "PB", color: "#4aa3df" },
  emergency_push_button: { label: "EP", color: "#f35361" },
  toggle_switch: { label: "TS", color: "#2eb8a3" },
  tower_light: { label: "TL", color: "#d9a029" },
  label: { label: "LB", color: "#8493a3" },
};

const TYPE_LABEL = {
  conveyor: "Conveyor",
  cylinder: "Cylinder",
  motor: "Motor",
  sensor: "Sensor",
  push_button: "Push button",
  emergency_push_button: "Emergency PB",
  toggle_switch: "Toggle switch",
  tower_light: "Tower light",
  label: "Label",
};

// Field to read for the live status dot -- omitted types (e.g. "label")
// just don't get a dot.
const STATUS_FIELD = {
  conveyor: "running",
  motor: "running",
  cylinder: "extended",
  sensor: "detected",
  push_button: "pressed",
  emergency_push_button: "pressed",
  toggle_switch: "on",
};

function isComponentActive(obj) {
  if (obj.type === "tower_light") {
    return Object.values(obj.lamp_states || {}).some(Boolean);
  }
  const field = STATUS_FIELD[obj.type];
  return field ? !!obj[field] : null; // null -- this type has no status dot
}

function renderComponentsList(state) {
  const list = document.getElementById("components-list");
  const tags = Object.keys(state);
  const key = tags.join(",");

  if (key !== componentsListKey) {
    componentsListKey = key;
    list.innerHTML = "";
    for (const tagName of tags) {
      const obj = state[tagName];
      const badge = TYPE_BADGE[obj.type] || { label: "??", color: "#8493a3" };

      const li = document.createElement("li");
      li.className = "component-row";
      li.dataset.tag = tagName;

      li.innerHTML = `
        <span class="component-badge" style="background:${badge.color}">${badge.label}</span>
        <span class="component-info">
          <span class="component-name"></span>
          <span class="component-type">${TYPE_LABEL[obj.type] || obj.type}</span>
        </span>
        <span class="component-status-dot"></span>
      `;
      li.querySelector(".component-name").textContent = tagName;
      list.appendChild(li);
    }
  }

  for (const li of list.children) {
    const tagName = li.dataset.tag;
    const obj = state[tagName];
    li.classList.toggle("selected", tagName === selectedTag);

    if (obj) {
      const active = isComponentActive(obj);
      const dot = li.querySelector(".component-status-dot");
      dot.classList.toggle("hidden", active === null);
      dot.classList.toggle("on", !!active);
    }
  }
}

document.getElementById("components-list").addEventListener("mousedown", function (e) {
//document.getElementById("components-list").addEventListener("click", function (e) {
  var li = e.target;
  while (li && li !== this && !li.getAttribute("data-tag")) {
    li = li.parentNode;
  }
  if (!li || li === this) return;
  selectComponent(li.getAttribute("data-tag"));
});

// Refreshes only the read-only status rows for the selected component
// (not the editable form inputs, so mid-edit values aren't clobbered).
function updateSelectedStatus() {
  if (!selectedTag) return;
  const obj = latestState[selectedTag];
  const block = document.getElementById("status-block");
  if (!obj || !block) return;

  const statusFields = STATUS_FIELDS[obj.type] || [];
  block.innerHTML = statusFields
    .map(([key, label]) => {
      const value = obj[key];
      const text = typeof value === "number" ? value.toFixed(2) : String(value);
      return `<div class="status-row"><span>${label}</span><span>${text}</span></div>`;
    })
    .join("");

  // Keep X/Y live during a drag (or any other source of movement)
  // without waiting for reselection. Skip a field the user is
  // currently focused in, so we don't stomp on their typing.
  for (const key of ["x", "y"]) {
    const input = document.querySelector(`#property-form [data-send="${key}"]`);
    if (input && document.activeElement !== input) {
      input.value = obj[key];
    }
  }
}

function enableComponentDragging(el, tagName) {
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;

    if (!isDesignMode()) {
      return;
    }

    dragging = true;
    moved = false;

    startX = e.clientX;
    startY = e.clientY;

    const obj = latestState[tagName];
    if (!obj) return;

    originX = obj.x;
    originY = obj.y;

    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");

    selectComponent(tagName);
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      if (!moved) pushHistory();
      moved = true;
    }

    // Convert mouse movement from screen pixels
    // back into simulation coordinates.
    const newX = Math.round(
      originX + dx / simulationZoom
    );

    const newY = Math.round(
      originY + dy / simulationZoom
    );

    el.style.left = `${newX}px`;
    el.style.top = `${newY}px`;

    markDirty();
    sendSetProperty(tagName, "x", newX);
    sendSetProperty(tagName, "y", newY);
  });

  el.addEventListener("pointerup", (e) => {
    if (!dragging) return;

    dragging = false;
    el.classList.remove("dragging");

    try {
      el.releasePointerCapture(e.pointerId);
    } catch (_) {}

    if (moved) {
      e.preventDefault();
      el.dataset.justDragged = "true";

      setTimeout(() => {
        delete el.dataset.justDragged;
      }, 0);
    }
  });
}

// Nudge the selected component with the arrow keys.
// Hold Shift for a bigger step.
document.addEventListener("keydown", (e) => {
  if (!isDesignMode()) return;
  if (!selectedTag) return;

  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
    return; // don't hijack arrow keys while typing in a field
  }

  const STEP = e.shiftKey ? 10 : 1;
  let dx = 0, dy = 0;

  switch (e.key) {
    case "ArrowUp": dy = -STEP; break;
    case "ArrowDown": dy = STEP; break;
    case "ArrowLeft": dx = -STEP; break;
    case "ArrowRight": dx = STEP; break;
    default: return;
  }

  e.preventDefault();
  pushHistory();
  markDirty(); 

  const obj = latestState[selectedTag];
  const el = elements[selectedTag];
  if (!obj || !el) return;

  const newX = Math.round(obj.x + dx);
  const newY = Math.round(obj.y + dy);

  el.style.left = `${newX}px`;
  el.style.top = `${newY}px`;

  sendSetProperty(selectedTag, "x", newX);
  sendSetProperty(selectedTag, "y", newY);
});

function getOrCreate(tagName, className, innerBuilder, onClick) {
  let el = elements[tagName];

  if (!el) {
    el = document.createElement("div");
    el.className = `component ${className}`;

    innerBuilder(el);

    el.addEventListener("click", (e) => {
      if (el.dataset.justDragged === "true") {
        e.preventDefault();
        return;
      }

      onClick();
    });

    enableComponentDragging(el, tagName);

    canvas.appendChild(el);
    elements[tagName] = el;
  }

  return el;
}

function renderConveyor(tagName, c) {
  const el = getOrCreate(
    tagName,
    "conveyor-ui",
    (container) => {
      // No fixed number of .box-ui elements up front -- box_count can
      // be anywhere from 1 up to max_box_count, so boxes are
      // created/removed to match box_positions.length on every render.
      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);
    },
    () => {
      selectComponent(tagName);
      if (isDesignMode()) return;
      sendSetPoint(tagName, "running", latestState[tagName]?.running ? 0 : 1);
    }
  );

  el.style.left = `${c.x}px`;
  el.style.top = `${c.y}px`;
  el.style.width = `${c.width}px`;
  el.style.height = `${c.height}px`;
  el.style.transform = `rotate(${c.rotation || 0}deg)`;
  el.style.zIndex = c.layer || 0;
  el.classList.toggle("running", !!c.running);

  const boxHeight = c.box_height ?? Math.min(24, c.height - 4);
  const travel = Math.max(0, c.width - c.box_width);
  const positions = c.box_positions && c.box_positions.length ? c.box_positions : [0];
  const tagEl = el.querySelector(".tag");

  // Reconcile the number of .box-ui elements with the current number
  // of box positions (box_count can change live via the Properties
  // panel, or the count can shift as boxes spawn/exit each tick).
  let boxEls = Array.from(el.querySelectorAll(".box-ui"));
  while (boxEls.length < positions.length) {
    const box = document.createElement("div");
    box.className = "box-ui";
    el.insertBefore(box, tagEl);
    boxEls.push(box);
  }
  while (boxEls.length > positions.length) {
    boxEls.pop().remove();
  }

  positions.forEach((rawPos, i) => {
    const pos = Math.min(rawPos, travel);
    const box = boxEls[i];
    box.style.left = `${pos}px`;
    box.style.top = `${(c.height - boxHeight) / 2}px`;
    box.style.width = `${c.box_width}px`;
    box.style.height = `${boxHeight}px`;
  });

  tagEl.textContent = `${tagName}  running=${c.running}  speed=${c.speed}`;
}

function renderCylinder(tagName, cyl) {
  const el = getOrCreate(
    tagName,
    "cylinder-ui",
    (container) => {
      const body = document.createElement("div");
      body.className = "body-ui";
      container.appendChild(body);

      const rod = document.createElement("div");
      rod.className = "rod-ui";
      container.appendChild(rod);

      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);
    },
    () => {
      selectComponent(tagName);
      if (isDesignMode()) return;
      sendSetPoint(tagName, "extend", latestState[tagName]?.extended ? 0 : 1);
    }
  );

  const bodyWidth = cyl.width * 0.62;

  // Container spans the full item footprint (body + rod travel) so
  // rotation pivots around the whole item's center, matching the
  // original CylinderItem's setTransformOriginPoint(rect.center()).
  el.style.left = `${cyl.x}px`;
  el.style.top = `${cyl.y}px`;
  el.style.width = `${cyl.width}px`;
  el.style.height = `${cyl.height}px`;
  el.style.transform = `rotate(${cyl.rotation || 0}deg)`;
  el.style.zIndex = cyl.layer || 0;

  el.querySelector(".body-ui").style.width = `${bodyWidth}px`;

  const rodMaxLen = cyl.width - bodyWidth;
  const rodLen = rodMaxLen * cyl.progress;

  const rod = el.querySelector(".rod-ui");
  rod.style.left = `${bodyWidth}px`;
  rod.style.width = `${rodLen}px`;

  el.querySelector(".tag").textContent =
    `${tagName}  progress=${cyl.progress.toFixed(2)}`;
}

function renderMotor(tagName, c) {
  const el = getOrCreate(
    tagName,
    "motor-ui",
    (container) => {
      container.innerHTML = `
        <div class="motor-terminal"></div>
        <div class="motor-body">
          <div class="motor-ribs"></div>
          <div class="motor-status"></div>
        </div>
        <div class="motor-shield"></div>
        <div class="motor-fan">
          <div class="motor-fan-label">FWD</div>
          <div class="motor-direction"></div>
        </div>
        <div class="motor-shaft"></div>
        <div class="motor-coupling"></div>
        <div class="motor-foot motor-foot-left"></div>
        <div class="motor-foot motor-foot-right"></div>
        <div class="tag"></div>
      `;

      selectComponent(tagName);
    },
    () => {
      selectComponent(tagName);
      if (isDesignMode()) return;
      sendSetPoint(
        tagName,
        "running",
        latestState[tagName]?.running ? 0 : 1
      );
    }
  );

  el.style.left = `${c.x}px`;
  el.style.top = `${c.y}px`;
  el.style.width = `${c.width}px`;
  el.style.height = `${c.height}px`;
  el.style.transform = `rotate(${c.rotation || 0}deg)`;
  el.style.zIndex = c.layer || 0;

  el.classList.toggle("running", !!c.running);
  el.classList.toggle("reverse", !c.direction_forward);

  const fanLabel = el.querySelector(".motor-fan-label");
  fanLabel.textContent = c.direction_forward ? "FWD" : "REV";

  const direction = el.querySelector(".motor-direction");

  if (c.running) {
    direction.style.transform =
      `rotate(${c.rotation_phase || 0}deg)`;
  } else {
    direction.style.transform = "rotate(0deg)";
  }

  el.querySelector(".tag").textContent = tagName;
}

function renderSensor(tagName, s) {
  const el = getOrCreate(
    tagName,
    "sensor-ui",
    (container) => {
      container.innerHTML = `
        <div class="sensor-body">
          <div class="sensor-lens"></div>
          <div class="sensor-led"></div>
        </div>
        <div class="tag"></div>
      `;

      selectComponent(tagName);
    },
    () => {
      selectComponent(tagName);
    }
  );

  el.style.left = `${s.x}px`;
  el.style.top = `${s.y}px`;
  el.style.width = `${s.width}px`;
  el.style.height = `${s.height}px`;
  el.style.zIndex = s.layer || 0;

  el.classList.toggle("detected", !!s.detected);

  el.querySelector(".tag").textContent =
    `${tagName}  detected=${s.detected}`;
}

// A momentary control: pressed must follow the mouse being held down,
// not a click-to-toggle like conveyor/cylinder/motor above. So it's
// sent via "set_property" (-> Scene.apply_property -> set_pressed()),
// not "set_point" (-> apply_command, restricted to PLC-writable
// points) -- a real pushbutton's state is operator input, never
// written by the PLC. pointer capture (from enableComponentDragging)
// means pointerup still fires on this element even if the mouse is
// released after moving off it.
function renderPushButton(tagName, b) {
  const el = getOrCreate(
    tagName,
    "pushbutton-ui",
    (container) => {
      const face = document.createElement("div");
      face.className = "pushbutton-face";
      container.appendChild(face);

      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);

      const release = () => {
        if (latestState[tagName]?.pressed) sendSetProperty(tagName, "pressed", 0);
      };

      container.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        sendSetProperty(tagName, "pressed", 1);
      });
      container.addEventListener("pointerup", release);
      container.addEventListener("pointerleave", release);
      container.addEventListener("pointercancel", release);
    },
    () => {
      selectComponent(tagName);
    }
  );

  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.style.width = `${b.width}px`;
  el.style.height = `${b.height}px`;
  el.style.zIndex = b.layer || 0;
  el.style.setProperty("--btn-color", PUSH_BUTTON_COLORS[b.color] || PUSH_BUTTON_COLORS.Red);

  el.classList.toggle("pressed", !!b.pressed);

  el.querySelector(".tag").textContent = `${tagName}  pressed=${b.pressed}`;
}

// Latching, unlike push_button above: one click presses it (and latches
// the freeze -- see Scene.is_emergency_stopped()), the next click
// releases it. Ported from EmergencyPushButtonItem.mousePressEvent,
// whose mouseReleaseEvent is commented out there too.
function renderEmergencyPushButton(tagName, b) {
  const el = getOrCreate(
    tagName,
    "epb-ui",
    (container) => {
      const face = document.createElement("div");
      face.className = "epb-face";
      container.appendChild(face);

      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);

      container.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const isPressed = !!latestState[tagName]?.pressed;
        sendSetProperty(tagName, "pressed", isPressed ? 0 : 1);
      });
    },
    () => {
      selectComponent(tagName);
    }
  );

  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.style.width = `${b.width}px`;
  el.style.height = `${b.height}px`;
  el.style.zIndex = b.layer || 0;

  el.classList.toggle("pressed", !!b.pressed);

  el.querySelector(".tag").textContent = `${tagName}  pressed=${b.pressed}`;
}

// Click (press+release without a drag) flips the state -- getOrCreate's
// own "click" listener already ignores clicks that followed a drag
// (el.dataset.justDragged), so ToggleSwitchItem's move-vs-click check
// doesn't need to be reimplemented here.
function renderToggleSwitch(tagName, t) {
  const el = getOrCreate(
    tagName,
    "toggle-ui",
    (container) => {
      const track = document.createElement("div");
      track.className = "toggle-track";
      const knob = document.createElement("div");
      knob.className = "toggle-knob";
      track.appendChild(knob);
      container.appendChild(track);

      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);
    },
    () => {
      const isOn = !!latestState[tagName]?.on;
      sendSetProperty(tagName, "on", isOn ? 0 : 1);
      selectComponent(tagName);
    }
  );

  el.style.left = `${t.x}px`;
  el.style.top = `${t.y}px`;
  el.style.width = `${t.width}px`;
  el.style.height = `${t.height}px`;
  el.style.zIndex = t.layer || 0;

  el.classList.toggle("on", !!t.on);

  el.querySelector(".tag").textContent = `${tagName}  on=${t.on}`;
}

// Each lamp is independently clickable -- unlike push_button/
// emergency_push_button/toggle_switch, red/blue/green/yellow are
// PLC-writable points (setters exist), so clicks go through
// sendSetPoint (-> apply_command), same as conveyor/cylinder, not
// sendSetProperty.
function renderTowerLight(tagName, tl) {
  const el = getOrCreate(
    tagName,
    "tower-ui",
    (container) => {
      for (const color of TOWER_LIGHT_LAMP_ORDER) {
        const lamp = document.createElement("div");
        lamp.className = "tower-lamp";
        lamp.dataset.color = color;
        container.appendChild(lamp);
      }

      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);
    },
    () => {
      selectComponent(tagName);
    }
  );

  el.style.left = `${tl.x}px`;
  el.style.top = `${tl.y}px`;
  el.style.width = `${tl.width}px`;
  el.style.height = `${tl.height}px`;
  el.style.zIndex = tl.layer || 0;

  for (const color of TOWER_LIGHT_LAMP_ORDER) {
    const lamp = el.querySelector(`.tower-lamp[data-color="${color}"]`);
    const lit = !!tl[color];
    lamp.classList.toggle("lit", lit);
    lamp.style.setProperty(
      "--lamp-color",
      lit ? TOWER_LIGHT_LIT_COLORS[color] : TOWER_LIGHT_DIM_COLORS[color]
    );
  }

  el.querySelector(".tag").textContent =
    `${tagName}  ${TOWER_LIGHT_LAMP_ORDER.map((c) => `${c}=${tl[c]}`).join(" ")}`;
}

// Visual-only annotation -- no PLC points, no click-to-toggle behavior.
// Text/font/color are all driven by the Properties panel.
function renderLabel(tagName, l) {
  const el = getOrCreate(
    tagName,
    "label-ui",
    (container) => {
      const text = document.createElement("div");
      text.className = "label-text";
      container.appendChild(text);

      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);
    },
    () => {
      selectComponent(tagName);
    }
  );

  el.style.left = `${l.x}px`;
  el.style.top = `${l.y}px`;
  el.style.width = `${l.width}px`;
  el.style.height = `${l.height}px`;
  el.style.zIndex = l.layer || 0;
  el.style.background = l.background_color;

  const textEl = el.querySelector(".label-text");
  textEl.textContent = l.text;
  textEl.style.fontFamily = l.font_family;
  textEl.style.fontSize = `${l.font_size}px`;
  textEl.style.fontWeight = l.bold ? "bold" : "normal";
  textEl.style.fontStyle = l.italic ? "italic" : "normal";

  el.querySelector(".tag").textContent = tagName;
}

// ---------- Dock: drag components onto the canvas ----------

palette.addEventListener("dragstart", (e) => {
  const btn = e.target.closest("button[draggable='true']");
  if (!btn) return;
  e.dataTransfer.setData("text/plain", btn.dataset.type);
  e.dataTransfer.effectAllowed = "copy";
});

canvasViewport.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  canvasViewport.classList.add("drag-over");
});

canvasViewport.addEventListener("dragleave", (e) => {
  // Only remove the highlight when leaving the viewport itself.
  if (!canvasViewport.contains(e.relatedTarget)) {
    canvasViewport.classList.remove("drag-over");
  }
});

canvasViewport.addEventListener("drop", (e) => {
  e.preventDefault();
  canvasViewport.classList.remove("drag-over");

  if (!isDesignMode()) return;

  const componentType = e.dataTransfer.getData("text/plain");
  if (!componentType) return;

  const rect = canvasViewport.getBoundingClientRect();

  const x =
    Math.round((e.clientX - rect.left - simulationPanX) / simulationZoom);

  const y =
    Math.round((e.clientY - rect.top - simulationPanY) / simulationZoom);

  sendAddComponent(componentType, x, y);
});

// ---------- Tabs (Properties / PLC Mapping) ----------

document.querySelectorAll(".tabs .tab").forEach((tabBtn) => {
  tabBtn.addEventListener("click", () => {
    document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));

    tabBtn.classList.add("active");
    document.querySelector(`.tab-panel[data-panel="${tabBtn.dataset.tab}"]`).classList.add("active");
  });
});

// ---------- PLC connection ----------

const backendSelect = document.getElementById("plc-backend-select");
let backendSelectInitialized = false;

backendSelect.addEventListener("change", (e) => {
  const isS7 = e.target.value === "s7";
  document.getElementById("plc-opcua-fields").style.display = isS7 ? "none" : "";
  document.getElementById("plc-s7-fields").style.display = isS7 ? "" : "none";
});

// Prefills the connect form from a loaded project's saved connection
// settings (backend + params) -- does NOT auto-connect, just repopulates
// the fields so the user can hit Connect again without retyping.
function applyLoadedConnectionSettings(plcConnection) {
  if (!plcConnection || !plcConnection.backend) return;
  const { backend, params = {} } = plcConnection;

  backendSelect.value = backend;
  backendSelectInitialized = true;
  backendSelect.dispatchEvent(new Event("change"));

  if (backend === "s7") {
    document.getElementById("plc-ip").value = params.ip || "";
    document.getElementById("plc-rack").value = params.rack ?? 0;
    document.getElementById("plc-slot").value = params.slot ?? 1;
  } else {
    document.getElementById("plc-url").value = params.url || "";
    document.getElementById("plc-username").value = params.username || "";
    document.getElementById("plc-password").value = params.password || "";
    if (params.security_policy) {
      document.getElementById("plc-security").value = params.security_policy;
    }
    document.getElementById("plc-cert").value = params.certificate_path || "";
    document.getElementById("plc-key").value = params.private_key_path || "";
  }
}

document.getElementById("plc-connect-btn").addEventListener("click", () => {
  const backend = backendSelect.value;
  let params;

  if (backend === "s7") {
    params = {
      ip: document.getElementById("plc-ip").value,
      rack: Number(document.getElementById("plc-rack").value) || 0,
      slot: Number(document.getElementById("plc-slot").value) || 1,
    };
  } else {
    params = {
      url: document.getElementById("plc-url").value,
      username: document.getElementById("plc-username").value || null,
      password: document.getElementById("plc-password").value || null,
      security_policy: document.getElementById("plc-security").value,
      certificate_path: document.getElementById("plc-cert").value || null,
      private_key_path: document.getElementById("plc-key").value || null,
    };
  }

  ws.send(JSON.stringify({ action: "plc_connect", backend, params }));
});

document.getElementById("plc-disconnect-btn").addEventListener("click", () => {
  ws.send(JSON.stringify({ action: "plc_disconnect" }));
});

document.getElementById("plc-pause-btn").addEventListener("click", () => {
  const action = latestPlc.paused ? "plc_resume" : "plc_pause";
  ws.send(JSON.stringify({ action }));
});

document.getElementById("plc-connect-bar-title").addEventListener("click", (e) => {
  const bar = document.getElementById("plc-connect-bar");
  const collapsed = bar.classList.toggle("collapsed");
  document.getElementById("plc-collapse-toggle").setAttribute(
    "aria-label", collapsed ? "Expand PLC connection panel" : "Collapse PLC connection panel"
  );
});

function renderPlcStatus(plc) {
  const dot = document.getElementById("plc-status-dot");
  const text = document.getElementById("plc-status-text");
  const pauseBtn = document.getElementById("plc-pause-btn");

  dot.classList.toggle("connected", !!plc.connected);
  dot.classList.toggle("unhealthy", !!plc.connected && !plc.comms_healthy);
  dot.classList.toggle("paused", !!plc.connected && !!plc.paused);

  if (plc.connected) {
    if (plc.paused) {
      text.textContent = `Connected (${plc.backend}) — Paused`;
    } else {
      text.textContent = plc.comms_healthy
        ? `Connected (${plc.backend})`
        : `Connected (${plc.backend}) — comms lost`;
    }
  } else {
    text.textContent = plc.backend ? `Not connected (last: ${plc.backend})` : "Not connected";
  }

  pauseBtn.disabled = !plc.connected;
  pauseBtn.textContent = plc.paused ? "Resume" : "Pause";

  // Runtime requires a live PLC -- reflect that on the mode button
  // itself, not just as an alert when clicked.
  runtimeModeBtn.classList.toggle("unavailable", !plc.connected);
  runtimeModeBtn.title = plc.connected
    ? ""
    : "Connect to a PLC before switching to Runtime.";

  document.getElementById("plc-last-error").textContent = plc.last_error || "";

  document.getElementById("plc-event-log").innerHTML = (plc.event_log || [])
    .map((msg) => `<div>${String(msg)}</div>`)
    .join("");

  for (const opt of backendSelect.options) {
    const available = plc.available_backends ? plc.available_backends[opt.value] : true;
    const base = opt.dataset.label || opt.textContent;
    opt.dataset.label = base;
    opt.disabled = available === false;
    opt.textContent = available === false ? `${base} (not installed)` : base;
  }

  // Reflect the currently-selected/connected backend once, on first
  // status we receive -- afterwards the dropdown is the user's own to
  // drive (e.g. picking a different backend before connecting).
  if (!backendSelectInitialized && plc.backend) {
    backendSelect.value = plc.backend;
    backendSelect.dispatchEvent(new Event("change"));
    backendSelectInitialized = true;
  }

  updateNodeHint(plc);
}

function updateNodeHint(plc) {
  const el = document.getElementById("node-hint");
  const hints = plc.address_format_hints || {};

  if (plc.connected) {
    el.textContent = hints[plc.backend] || "Connected.";
  } else if (plc.backend) {
    el.textContent = `Not connected yet — format for ${plc.backend}: ${hints[plc.backend] || ""}`;
  } else {
    el.textContent = "PLC Node column: the expected address format depends on the connection ";
  }
}

// ---------- PLC mapping table ----------

let mappingRowsKey = null;
let mappingCells = {}; // "tag|point" -> { nodeInput, liveCell }

function renderMappingTable(plc, state) {
  const tbody = document.getElementById("mapping-tbody");
  const grouping = document.getElementById("mapping-group").checked;

  const rows = [];
  for (const tag of Object.keys(state).sort()) {
    const obj = state[tag];
    if (!obj._io_points) continue;
    for (const point of Object.keys(obj._io_points).sort()) {
      rows.push({ tag, point, isPlcToOms: obj._io_points[point] });
    }
  }

  const key = grouping + "|" + rows.map((r) => `${r.tag}.${r.point}`).join(",");
  if (key !== mappingRowsKey) {
    mappingRowsKey = key;
    buildMappingRows(tbody, rows, plc.mapping || [], grouping);
  }

  for (const [k, cells] of Object.entries(mappingCells)) {
    const [tag, point] = k.split("|");
    const val = state[tag]?.[point];
    cells.liveCell.textContent = val === undefined ? "—" : String(val);
  }

  applyMappingFilter();
}

function buildMappingRows(tbody, rows, mappingList, grouping) {
  const nodeByKey = {};
  for (const m of mappingList) {
    nodeByKey[`${m.object_tag}|${m.io_point}`] = m.plc_node;
  }

  tbody.innerHTML = "";
  mappingCells = {};

  let lastTag = null;

  for (const row of rows) {

    // ---------- Object group header ----------
    if (grouping && row.tag !== lastTag) {
      const headerRow = document.createElement("tr");
      headerRow.className = "mapping-group-header";
      headerRow.dataset.groupTag = row.tag;

      headerRow.innerHTML = `
        <td colspan="6">
          <span class="group-arrow">▼</span>
          ${row.tag}
        </td>
      `;

      headerRow.addEventListener("click", () => {
        const collapsed = headerRow.classList.toggle("collapsed");

        const arrow = headerRow.querySelector(".group-arrow");
        arrow.textContent = collapsed ? "▶" : "▼";

        // Hide/show all rows belonging to this object
        let sib = headerRow.nextElementSibling;

        while (sib && !sib.classList.contains("mapping-group-header")) {
          sib.style.display = collapsed ? "none" : "";
          sib = sib.nextElementSibling;
        }

        // Re-apply the search filter without losing collapse state
        applyMappingFilter();
      });

      tbody.appendChild(headerRow);
      lastTag = row.tag;
    }

    // ---------- Mapping row ----------
    const key = `${row.tag}|${row.point}`;
    const nodeValue = nodeByKey[key] || "";
    const direction = row.isPlcToOms ? "PLC -> OMS" : "OMS -> PLC";

    const tr = document.createElement("tr");

    tr.dataset.groupTag = row.tag;
    tr.classList.toggle("unmapped-row", !nodeValue);

    tr.innerHTML = `
      <td>${row.tag}</td>
      <td>${row.point}</td>
      <td class="center">${direction}</td>
      <td>
        <input type="text" class="node-input">
      </td>
      <td class="center live-value">—</td>
      <td>
        ${row.isPlcToOms
          ? '<span class="force-cell"><input type="text" class="force-input" placeholder="value"></span>'
          : ""}
      </td>
    `;

    const nodeInput = tr.querySelector(".node-input");

    nodeInput.value = nodeValue;

    nodeInput.addEventListener("input", () => {
      tr.classList.toggle("unmapped-row", !nodeInput.value.trim());
    });

    nodeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        applyAllMappings();
      }
    });

    nodeInput.addEventListener("blur", () => {
      applyAllMappings();
    });

    // Force value using ENTER
    if (row.isPlcToOms) {
      const forceInput = tr.querySelector(".force-input");

      const applyForce = () => {
        const value = forceInput.value.trim();

        if (!value) return;

        ws.send(JSON.stringify({
          action: "plc_force",
          tag_name: row.tag,
          io_point: row.point,
          value,
        }));
      };

      forceInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          applyForce();
        }
      });
    }

    tbody.appendChild(tr);

    mappingCells[key] = {
      nodeInput,
      liveCell: tr.querySelector(".live-value"),
    };
  }
}


function applyMappingFilter() {
  const text = document
    .getElementById("mapping-filter")
    .value
    .toLowerCase()
    .trim();

  const tbody = document.getElementById("mapping-tbody");

  let currentGroup = null;
  let groupHeader = null;
  let groupHasMatch = false;

  for (const tr of tbody.children) {

    // ---------- Group header ----------
    if (tr.classList.contains("mapping-group-header")) {

      // Finish previous group
      if (groupHeader) {
        const collapsed = groupHeader.classList.contains("collapsed");

        groupHeader.style.display =
          !text || groupHasMatch ? "" : "none";

        let row = groupHeader.nextElementSibling;

        while (row && !row.classList.contains("mapping-group-header")) {
          const matches =
            !text ||
            row.textContent.toLowerCase().includes(text);

          row.style.display =
            !matches || collapsed ? "none" : "";

          row = row.nextElementSibling;
        }
      }

      // Start new group
      groupHeader = tr;
      currentGroup = tr.dataset.groupTag;
      groupHasMatch = false;

      continue;
    }

    // ---------- Normal row ----------
    const matches =
      !text ||
      tr.textContent.toLowerCase().includes(text);

    if (matches) {
      groupHasMatch = true;
    }

    // If grouping is OFF, just filter normally
    if (!document.getElementById("mapping-group").checked) {
      tr.style.display = matches ? "" : "none";
    }
  }

  // Finish final group
  if (groupHeader) {
    const collapsed = groupHeader.classList.contains("collapsed");

    groupHeader.style.display =
      !text || groupHasMatch ? "" : "none";

    let row = groupHeader.nextElementSibling;

    while (row && !row.classList.contains("mapping-group-header")) {
      const matches =
        !text ||
        row.textContent.toLowerCase().includes(text);

      row.style.display =
        !matches || collapsed ? "none" : "";

      row = row.nextElementSibling;
    }
  }
}

document.getElementById("mapping-filter").addEventListener("input", applyMappingFilter);

document.getElementById("mapping-group").addEventListener("change", () => {
  mappingRowsKey = null; // force a rebuild so group headers appear/disappear
  renderMappingTable(latestPlc, latestState);
});

document.getElementById("mapping-expand-all").addEventListener("click", () => {
  document.querySelectorAll("#mapping-tbody .mapping-group-header").forEach((headerRow) => {
    headerRow.classList.remove("collapsed");

    const td = headerRow.querySelector("td");
    const tag = headerRow.dataset.groupTag;
    td.textContent = `▼ ${tag}`;

    let sib = headerRow.nextElementSibling;
    while (sib && !sib.classList.contains("mapping-group-header")) {
      sib.style.display = "";
      sib = sib.nextElementSibling;
    }
  });

  applyMappingFilter();
});

document.getElementById("mapping-collapse-all").addEventListener("click", () => {
  document.querySelectorAll("#mapping-tbody .mapping-group-header").forEach((headerRow) => {
    headerRow.classList.add("collapsed");

    const td = headerRow.querySelector("td");
    const tag = headerRow.dataset.groupTag;
    td.textContent = `▶ ${tag}`;

    let sib = headerRow.nextElementSibling;
    while (sib && !sib.classList.contains("mapping-group-header")) {
      sib.style.display = "none";
      sib = sib.nextElementSibling;
    }
  });

  applyMappingFilter();
});

document.getElementById("mapping-rescan-btn").addEventListener("click", () => {
  mappingRowsKey = null;
  renderMappingTable(latestPlc, latestState);
});

function applyAllMappings() {
  markDirty();
  const mappings = [];
  for (const [key, cells] of Object.entries(mappingCells)) {
    const [tag, point] = key.split("|");
    const value = cells.nodeInput.value.trim();
    if (value) mappings.push({ object_tag: tag, io_point: point, plc_node: value });
  }
  ws.send(JSON.stringify({ action: "plc_set_mapping", mappings }));
}

document.getElementById("mapping-validate-btn").addEventListener("click", () => {
  ws.send(JSON.stringify({ action: "plc_validate" }));
});

function showValidationResult(problems) {
  if (!problems || problems.length === 0) {
    alert("All mapped addresses look valid for the selected connection type.");
    return;
  }
  if (problems.length === 1 && problems[0].error && !problems[0].object_tag) {
    alert(problems[0].error);
    return;
  }
  const lines = problems.map((p, i) =>
    `${i + 1}. ${p.object_tag} \u2192 ${p.io_point}\n   PLC address: ${p.plc_node}\n   Problem: ${p.error}`
  );
  alert(`${problems.length} mapping error(s) found:\n\n${lines.join("\n\n")}`);
}

function applySimulationTransform() {
  canvas.style.transform =
    `translate(${simulationPanX}px, ${simulationPanY}px) scale(${simulationZoom})`;

  const gridSize = 25 * simulationZoom;

  canvasViewport.style.backgroundSize =
    `${gridSize}px ${gridSize}px`;

  // Keep the grid synchronized with the simulation view while panning.
  canvasViewport.style.backgroundPosition =
    `${simulationPanX}px ${simulationPanY}px`;
}

// ---------- Simulation: pan view by dragging empty area ----------

canvasViewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;

  // Clicking a component is handled by the component's own drag logic.
  if (e.target.closest(".component")) return;

  panning = true;

  panStartX = e.clientX;
  panStartY = e.clientY;

  panOriginX = simulationPanX;
  panOriginY = simulationPanY;

  canvasViewport.setPointerCapture(e.pointerId);
  canvasViewport.style.cursor = "grabbing";
});

canvasViewport.addEventListener("pointermove", (e) => {
  if (!panning) return;

  const dx = e.clientX - panStartX;
  const dy = e.clientY - panStartY;

  simulationPanX = panOriginX + dx;
  simulationPanY = panOriginY + dy;

  applySimulationTransform();
});

function stopSimulationPanning(e) {
  if (!panning) return;

  panning = false;

  try {
    canvasViewport.releasePointerCapture(e.pointerId);
  } catch (_) {}

  canvasViewport.style.cursor = "grab";
}

canvasViewport.addEventListener("pointerup", stopSimulationPanning);
canvasViewport.addEventListener("pointercancel", stopSimulationPanning);

canvasViewport.style.cursor = "grab";

applySimulationTransform();

window.addEventListener("beforeunload", (e) => {
  if (!projectDirty) return;
  e.preventDefault();
  e.returnValue = "";
});