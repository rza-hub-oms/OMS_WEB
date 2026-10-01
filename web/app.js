// web/app.js — UI composition and interaction layer
import { send, setMessageHandler } from "./modules/socket.js";
import { renderConveyor } from "./modules/conveyor-renderer.js";
import { renderCylinder } from "./modules/cylinder-renderer.js";
import { renderMotor } from "./modules/motor-renderer.js";
import { renderSensor } from "./modules/sensor-renderer.js";
import { renderPushButton } from "./modules/push-button-renderer.js";
import { renderEmergencyPushButton } from "./modules/emergency-push-button-renderer.js";
import { renderToggleSwitch } from "./modules/toggle-switch-renderer.js";
import { renderTowerLight } from "./modules/tower-light-renderer.js";
import { renderLabel } from "./modules/label-renderer.js";
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
let latestTags = [];
let latestDiagnostics = null;
let latestTrends = { selected: [], interval_s: 1, samples: [] };
let latestProduction = { config: {}, total_count: 0, good_count: 0, reject_count: 0 };
let productionRenderKey = "";
let selectedTrendTags = new Set();
let trendTagRenderKey = "";
let trendRows = [""];
let trendBackendKey = null;
let trendChartRenderKey = "";

let currentProjectFilename = null;
let latestProjectMetadata = {};
let lastServerMetadata = null;

// ---------- Operator screen state (must exist before initial UI render) ----------
const BUILTIN_OPERATOR_SCREENS = {
  machine: { title: "Machine", description: "Live machine canvas. In Runtime this is the primary operator view." },
  dashboard: { title: "Dashboard", description: "Production KPIs, machine status, active alarms and PLC state." },
  alarms: { title: "Alarms", description: "Existing OMS alarm panel with active alarms, history and acknowledgement." },
  trends: { title: "Trends", description: "Existing OMS trend recorder and live trend data." },
  production: { title: "Production", description: "Existing production counters, OEE and shift information." },
  diagnostics: { title: "Diagnostics", description: "Existing PLC and machine diagnostics tools." },
  reports: { title: "Reports", description: "Operational history, production summary and CSV export." },
};
const SCREEN_MODULES = [
  ["machine", "Machine"], ["dashboard", "Dashboard"], ["alarms", "Alarms"],
  ["trends", "Trends"], ["production", "Production"], ["diagnostics", "Diagnostics"], ["reports", "Reports"],
];
let screensOpen = false;
let activeOperatorScreen = "machine";
let customOperatorScreens = [];
let customScreenEditorOpen = false;
let activeCustomScreenId = null;
let widgetEditMode = false;
let selectedWidgetId = null;

let projectDirty = false;
const RECOVERY_KEY = "oms.recovery.v1";
let recoveryBackupTimer = null;

function writeRecoveryBackup(data) {
  if (!data) return;
  try {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({
      saved_at: new Date().toISOString(),
      filename: currentProjectFilename || "recovery",
      data,
    }));
    updateRecoveryUI();
  } catch (err) {
    console.warn("OMS recovery backup unavailable:", err);
  }
}

function requestRecoveryBackup() {
  if (!projectDirty) return;
  send({ action: "project_snapshot" });
}

function scheduleRecoveryBackup() {
  if (recoveryBackupTimer) clearTimeout(recoveryBackupTimer);
  recoveryBackupTimer = setTimeout(requestRecoveryBackup, 1500);
}

function readRecoveryBackup() {
  try { return JSON.parse(localStorage.getItem(RECOVERY_KEY) || "null"); }
  catch (_) { return null; }
}

function updateRecoveryUI() {
  const btn = document.getElementById("recover-project-btn");
  if (!btn) return;
  const backup = readRecoveryBackup();
  btn.disabled = !backup?.data;
  btn.title = backup?.saved_at
    ? `Recover backup from ${new Date(backup.saved_at).toLocaleString()}`
    : "No recovery backup available";
}

function markDirty() {
  if (!projectDirty) {
    projectDirty = true;
    updateDirtyUI();
  }
  scheduleRecoveryBackup();
}

function markClean() {
  if (!projectDirty) return;
  projectDirty = false;
  if (recoveryBackupTimer) { clearTimeout(recoveryBackupTimer); recoveryBackupTimer = null; }
  updateDirtyUI();
}

function updateDirtyUI() {
  document.getElementById("dirty-indicator").classList.toggle("hidden", !projectDirty);
  document.title = (projectDirty ? "* " : "") + "OMS Web Prototype";
  updateRecoveryUI();
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

// Small DOM helper shared by the dashboard and other UI renderers.
// Keep this at module scope so every renderer can use it.
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

let panning = false;
let selectionMarquee = null;
let marqueeStartX = 0;
let marqueeStartY = 0;
let marqueeAdditive = false;
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
  send({
    action: "restore_objects",
    objects: JSON.parse(snapshot),
  });
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
  document.body.classList.remove("panel-fullscreen");
  activeOperatorScreen = "machine";
  applyCustomScreenMode();

  // Components palette is a DESIGN-only operation.
  palette.style.pointerEvents = design ? "auto" : "none";
  palette.style.opacity = design ? "1" : "0.45";

  document.getElementById("open-project-btn").disabled = !design;
  document.getElementById("reset-view-btn").disabled = !design;
  updateUndoRedoButtons();

  updateRuntimeAlarmBar();
  updateOperatorScreenBar();

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
  send({
    action: "set_mode",
    mode: "design",
  });
});

simulationModeBtn?.addEventListener("click", () => {
  send({
    action: "set_mode",
    mode: "simulation",
  });
});

runtimeModeBtn.addEventListener("click", () => {
  if (!latestPlc.connected || latestPlc.comms_healthy === false) {
    alert("Connect to a PLC and wait for healthy communication before switching to Runtime.");
    return;
  }

  send({
    action: "set_mode",
    mode: "runtime",
  });
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
let latestLogicRules = [];
let latestSequences = [];
let latestSequenceStatus = [];
let latestAlarms = { definitions: [], active: [], history: [], active_count: 0 };
let latestHierarchy = [];
let latestConnections = [];
// Cache of created DOM elements per tag_name, so we update in place
// instead of rebuilding the DOM every 50ms (which would restart CSS
// transitions/animations and cause flicker).
const elements = {};

// ---------- Properties dock ----------

const propertyBody = document.getElementById("property-body");
let selectedTag = null;
let selectedTags = new Set();
let suppressSelection = false;

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
    { key: "mode", send: "mode", label: "Mode", type: "select", options: [["auto", "Auto"], ["manual", "Manual"]] },
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 30, max: 5000, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 4, max: 200, suffix: " px" },
    { key: "rotation", send: "rotation_value", label: "Rotation", type: "number", min: 0, max: 359.9, step: "1", suffix: " °" },
    { key: "direction", send: "direction", label: "Direction", type: "select",
      options: [["1", "Forward"], ["0", "Reverse"]] },
    { key: "speed", send: "speed", label: "Speed", type: "number", min: 0, max: 5000, suffix: " mm/s" },
    { key: "box_width", send: "box_width", label: "Box Width", type: "number", min: 5, max: 200, suffix: " px" },
    { key: "box_height", send: "box_height", label: "Box Height", type: "number", min: 5, maxKey: "max_box_height", suffix: " px" },
    { key: "box_count", send: "box_count", label: "Box Count", type: "number", min: 1, step: "1", maxKey: "max_box_count" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
    { key: "fault", send: "fault", label: "Fault", type: "checkbox" },
    { key: "emergency_stop", send: "emergency_stop", label: "Emergency Stop", type: "checkbox" },
  ],
  cylinder: [
    { key: "mode", send: "mode", label: "Mode", type: "select", options: [["auto", "Auto"], ["manual", "Manual"]] },
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 40, max: 1000, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 24, max: 1000, suffix: " px" },
    { key: "rotation", send: "rotation_value", label: "Rotation", type: "number", min: 0, max: 359.9, step: "1", suffix: " °" },
    { key: "speed", send: "speed", label: "Speed", type: "number", min: 0, max: 5000 },
    { key: "valve_type", send: "valve_type", label: "Valve Type", type: "select",
      options: [["single", "Single (1 tag)"], ["dual", "Dual (2 tags, hold)"]] },
    // filterTypes lists every component type CYLINDER_RELATION_HANDLERS
    // (core/scene.py) currently has a handler for. Add a type here only
    // once its handler exists server-side -- offering a target with no
    // handler would let it be selected but silently do nothing.
    { key: "target_tag", send: "target_tag", label: "Interacts With", type: "component-select", filterTypes: ["conveyor", "sensor", "push_button"] },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1", min: "0" },
    { key: "fault", send: "fault", label: "Fault", type: "checkbox" },
    { key: "emergency_stop", send: "emergency_stop", label: "Emergency Stop", type: "checkbox" },
  ],
  motor: [
    { key: "mode", send: "mode", label: "Mode", type: "select", options: [["auto", "Auto"], ["manual", "Manual"]] },
    { key: "x", send: "x", label: "X", type: "number", step: "0.1", suffix: " px" },
    { key: "y", send: "y", label: "Y", type: "number", step: "0.1", suffix: " px" },
    { key: "width", send: "width", label: "Width", type: "number", min: 30, max: 5000, suffix: " px" },
    { key: "height", send: "height", label: "Height", type: "number", min: 4, max: 200, suffix: " px" },
    { key: "rotation", send: "rotation_value", label: "Rotation", type: "number", min: 0, max: 359.9, step: "1", suffix: " °" },
    { key: "direction", send: "direction", label: "Direction", type: "select",
      options: [["1", "Forward"], ["0", "Reverse"]] },
    { key: "speed", send: "speed", label: "Speed", type: "number", min: 0, max: 5000, suffix: " mm/s" },
    { key: "layer", send: "layer", label: "Layer", type: "number", step: "1" , min: "0" },
    { key: "fault", send: "fault", label: "Fault", type: "checkbox" },
    { key: "emergency_stop", send: "emergency_stop", label: "Emergency Stop", type: "checkbox" },
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
  conveyor: [["running", "Running"], ["mode", "Mode"], ["fault", "Fault"], ["emergency_stop", "E-Stop"]],
  cylinder: [["extended", "Extended"], ["progress", "Progress"], ["moving", "Moving"], ["mode", "Mode"], ["fault", "Fault"], ["emergency_stop", "E-Stop"]],
  motor: [["running", "Running"], ["mode", "Mode"], ["fault", "Fault"], ["emergency_stop", "E-Stop"]],
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
  send({ action: "set_property", tag_name: tagName, property, value });
}

function selectComponent(tagName, additive = false) {
  if (suppressSelection) return;
  if (additive) {
    if (selectedTags.has(tagName)) selectedTags.delete(tagName);
    else selectedTags.add(tagName);
  } else {
    selectedTags.clear();
    selectedTags.add(tagName);
  }

  selectedTag = selectedTags.size === 1 ? [...selectedTags][0] : null;

  for (const [tag, el] of Object.entries(elements)) {
    el.classList.toggle("selected", selectedTags.has(tag));
  }

  renderPropertyPanel();
  renderComponentsList(latestState);
}

function deselectAll() {
  selectedTags.clear();
  selectedTag = null;
  for (const el of Object.values(elements)) el.classList.remove("selected");
  renderPropertyPanel();
  renderComponentsList(latestState);
}

function renderPropertyPanel() {
  if (selectedTags.size > 1) {
    propertyBody.innerHTML = '<p class="empty">Multiple components selected.</p>';
    return;
  }

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
        return `<label class="checkbox-field">${f.label}<input type="checkbox" data-send="${f.send}" ${obj[f.key] ? "checked" : ""}></label>`;
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

  const parentOptions = Object.keys(latestState)
    .filter(tag => tag !== selectedTag)
    .sort()
    .map(tag => `<option value="${escapeHtml(tag)}" ${obj.parent_tag === tag ? "selected" : ""}>${escapeHtml(tag)}</option>`)
    .join("");

  propertyBody.innerHTML = `
    <div class="selected-name">
      <input id="name-input" type="text" value="${selectedTag}">
    </div>
    <div id="status-block">${statusHtml}</div>
    <form id="property-form">
      <label>Machine Parent
        <select data-send="parent_tag">
          <option value="" ${!obj.parent_tag ? "selected" : ""}>(Root)</option>
          ${parentOptions}
        </select>
      </label>
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

    pushHistory();
    markDirty();
    sendSetProperty(selectedTag, "name", newName);
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



setMessageHandler((event) => {
  const msg = JSON.parse(event.data);

  // One-off reply to a "plc_validate" command, not part of the
  // regular tick broadcast (which always has an "objects" key).
  if (msg.logic_validation !== undefined) {
    const errors = msg.logic_validation || [];
    alert(errors.length ? errors.map(e => `Rule ${e.index + 1}: ${e.error}`).join("\n") : "Logic rules are valid.");
    return;
  }

  if (msg.sequence_validation !== undefined) {
    const errors = msg.sequence_validation || [];
    alert(errors.length ? errors.map(e => `Sequence ${e.index + 1}${e.step !== undefined ? ` / Step ${e.step + 1}` : ""}: ${e.error}`).join("\n") : "Sequences are valid.");
    return;
  }

  if (msg.connection_validation !== undefined) {
    const errors = msg.connection_validation || [];
    alert(errors.length
      ? errors.map(e => `Connection ${e.index + 1}: ${e.error}`).join("\n")
      : "Engineering connections are valid.");
    return;
  }

  if (msg.plc_validation !== undefined) {
    showValidationResult(msg.plc_validation);
    return;
  }

  if (msg.diagnostics !== undefined) {
    latestDiagnostics = msg.diagnostics;
    renderDiagnostics();
    return;
  }

  if (msg.project_load_error !== undefined) {
    const errors = msg.project_load_error || [];
    alert("Cannot open project:\n\n" + errors.map(e => `${e.field}: ${e.error}`).join("\n"));
    return;
  }

  if (msg.project_loaded !== undefined) {
    // Project loading replaces the component tree and therefore the
    // component-backed system tags.  Refresh all dependent UI state
    // immediately instead of waiting for the next periodic broadcast.
    const loaded = msg.project_loaded || {};
    if (loaded.metadata) { latestProjectMetadata = loaded.metadata || {}; loadOperatorScreensFromMetadata(latestProjectMetadata); renderRuntimeScreenBar(); }
    if (loaded.tags) {
      latestTags = loaded.tags;
      renderTags();
    }
    if (loaded.plc) {
      latestPlc = loaded.plc;
      mappingRowsKey = null;
      renderPlcStatus(latestPlc);
      renderMappingTable(latestPlc, latestState);
      renderPlcMonitor(latestPlc, latestState);
    } else {
      mappingRowsKey = null;
    }
    return;
  }

  if (msg.project !== undefined) {
    const project = msg.project || {};
    if (project.metadata && JSON.stringify(project.metadata) !== JSON.stringify(lastServerMetadata)) {
      lastServerMetadata = project.metadata;
      latestProjectMetadata = project.metadata; loadOperatorScreensFromMetadata(latestProjectMetadata); renderRuntimeScreenBar();
    }
    if (project.name) { currentProjectFilename = project.name; updateFileNameUI(); }
  }

  if (msg.project_data !== undefined) {
    saveProjectData(msg.project_data);
    return;
  }

  if (msg.project_snapshot !== undefined) {
    if (projectDirty) writeRecoveryBackup(msg.project_snapshot);
    return;
  }

  if (msg.db_import_result !== undefined) {
    handleDbImportResult(msg.db_import_result);
    return;
  }

  if (msg.opcua_browse_result !== undefined) {
    handleOpcuaBrowseResult(msg.opcua_browse_result);
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
  if (msg.plc?.tags && JSON.stringify(msg.plc.tags) !== JSON.stringify(latestTags)) {
    latestTags = msg.plc.tags;
    renderTags();
    updateCustomWidgetValues();
  }
  if (msg.logic_rules && JSON.stringify(msg.logic_rules) !== JSON.stringify(latestLogicRules)) {
    latestLogicRules = msg.logic_rules;
    renderLogicRules();
  }
  if (msg.sequences && JSON.stringify(msg.sequences) !== JSON.stringify(latestSequences)) {
    latestSequences = msg.sequences;
    renderSequences();
  }
  if (msg.sequence_status) {
    latestSequenceStatus = msg.sequence_status;
    renderSequenceStatus();
  }
  if (msg.alarms && JSON.stringify(msg.alarms) !== JSON.stringify(latestAlarms)) {
    latestAlarms = msg.alarms;
    renderAlarms();
    updateAlarmBadge();
    updateCustomWidgetValues();
  }
  if (msg.hierarchy) {
    const key = JSON.stringify(msg.hierarchy) + "|" + omsMode + "|" + [...selectedTags].join(",");
    if (key !== hierarchyRenderKey) {
      hierarchyRenderKey = key;
      latestHierarchy = msg.hierarchy;
      renderHierarchy();
    }
  }
  if (msg.connections && JSON.stringify(msg.connections) !== JSON.stringify(latestConnections)) {
    latestConnections = msg.connections;
    renderConnections();
  }
  if (msg.trends) {
    latestTrends = msg.trends;
    renderTrends();
  }
  if (msg.production) {
    latestProduction = msg.production;
    renderProduction();
  }
  render(latestState);
  renderDashboard();
  if (reportsOpen) renderReports();
  renderPlcStatus(latestPlc);
  renderMappingTable(latestPlc, latestState);
  renderPlcMonitor(latestPlc, latestState);
  updateRuntimeAlarmBar();
});

function renderTags() {
  const list = document.getElementById("tag-list");
  if (!list) return;
  list.innerHTML = latestTags.map(tag => {
    const value = typeof tag.value === "boolean" ? (tag.value ? "TRUE" : "FALSE") : (tag.value ?? "—");
    const source = tag.system ? `${tag.object_tag}.${tag.io_point}` : "Internal";
    return `<div class="mapping-card tag-card">
      <div><b>${tag.name}</b><small>${source}</small></div>
      <span>${tag.datatype}</span>
      <span>${tag.direction}</span>
      <strong>${String(value)}</strong>
      ${tag.system ? "" : `<button class="tag-connect" type="button" data-tag="${escapeHtml(tag.name)}">${tag.object_tag ? "Connected" : "Connect"}</button><button class="tag-expression" type="button" data-tag="${escapeHtml(tag.name)}">${tag.expression ? "fx ✓" : "fx"}</button><button class="tag-delete" type="button" data-tag="${escapeHtml(tag.name)}">✕</button>`}
      ${tag.expression ? `<small class="tag-expression-text">= ${tag.expression}${tag.expression_error ? ` · ERROR: ${tag.expression_error}` : ""}</small>` : ""}
    </div>`;
  }).join("") || '<p class="empty">No tags.</p>';
  list.querySelectorAll(".tag-delete").forEach(btn => btn.addEventListener("click", () => {
    if (!isDesignMode()) return;
    send({ action: "delete_tag", name: btn.dataset.tag });
  }));
  list.querySelectorAll(".tag-connect").forEach(btn => btn.addEventListener("click", () => {
    if (!isDesignMode()) return;
    openTagComponentPicker(btn.dataset.tag);
  }));
  list.querySelectorAll(".tag-expression").forEach(btn => btn.addEventListener("click", () => {
    if (!isDesignMode()) return;
    openTagExpressionEditor(btn.dataset.tag);
  }));
}

// ---------- Internal tag -> component connection ----------
const tagComponentModal = document.getElementById("tag-component-modal");
const tagComponentList = document.getElementById("tag-component-list");
const tagComponentFilter = document.getElementById("tag-component-filter");
const tagComponentEmpty = document.getElementById("tag-component-empty");
let tagComponentTarget = null;

function openTagComponentPicker(tagName) {
  tagComponentTarget = tagName;
  document.getElementById("tag-component-title").textContent = `Connect ${tagName}`;
  tagComponentFilter.value = "";
  renderTagComponentPicker("");
  tagComponentModal.classList.remove("hidden");
  tagComponentFilter.focus();
}

function renderTagComponentPicker(filterText) {
  const needle = String(filterText || "").toLowerCase();
  const rows = latestTags.filter(t => t.system &&
    (!needle || `${t.object_tag} ${t.io_point} ${t.name}`.toLowerCase().includes(needle)));
  tagComponentList.innerHTML = "";
  tagComponentEmpty.classList.toggle("hidden", rows.length > 0);
  tagComponentEmpty.textContent = rows.length ? "" : "No component I/O points match that search.";
  for (const tag of rows) {
    const row = document.createElement("div");
    row.className = "tag-picker-row";
    row.innerHTML = `<span class="tag-picker-name">${escapeHtml(tag.object_tag)}</span>
      <span class="tag-picker-type">${escapeHtml(tag.io_point)} · ${escapeHtml(tag.datatype)}</span>
      <span class="tag-picker-address">${escapeHtml(tag.direction)}</span>`;
    row.addEventListener("click", () => {
      if (!tagComponentTarget) return;
      send({ action: "bind_tag", name: tagComponentTarget, object_tag: tag.object_tag, io_point: tag.io_point });
      tagComponentModal.classList.add("hidden");
    });
    tagComponentList.appendChild(row);
  }
}

tagComponentFilter?.addEventListener("input", e => renderTagComponentPicker(e.target.value));
document.getElementById("tag-component-close")?.addEventListener("click", () => tagComponentModal.classList.add("hidden"));

document.addEventListener("click", e => {
  if (e.target === tagComponentModal) tagComponentModal.classList.add("hidden");
});

// ---------- Visual Tag Logic editor ----------
// The editor deliberately hides the expression syntax for normal users.
// It builds the safe tag("...") expression from selectable tags/operators.
const tagExpressionModal = document.getElementById("tag-expression-modal");
const tagExpressionRows = document.getElementById("tag-expression-rows");
const tagExpressionPreview = document.getElementById("tag-expression-preview");
const tagExpressionError = document.getElementById("tag-expression-error");
const tagExpressionAdvanced = document.getElementById("tag-expression-advanced");
let tagExpressionTarget = null;
let tagExpressionWorking = [];

function expressionTagOptions() {
  return [...latestTags].sort((a, b) => a.name.localeCompare(b.name));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;"}[ch]));
}

function expressionOperatorOptions(datatype) {
  if (datatype === "bool") return [["==", "is"], ["!=", "is not"]];
  if (["int", "float", "number"].includes(datatype)) return [["==", "="], ["!=", "≠"], [">", ">"], [">=", "≥"], ["<", "<"], ["<=", "≤"]];
  return [["==", "="], ["!=", "≠"]];
}

function conditionValueControl(row, tag) {
  const dtype = tag?.datatype || "string";
  const value = row.value ?? (dtype === "bool" ? "true" : "0");
  if (dtype === "bool") {
    return `<select class="tag-cond-value"><option value="true" ${String(value)==="true"?"selected":""}>TRUE</option><option value="false" ${String(value)!== "true"?"selected":""}>FALSE</option></select>`;
  }
  const type = ["int","float","number"].includes(dtype) ? "number" : "text";
  const step = dtype === "float" ? "any" : "1";
  return `<input class="tag-cond-value" type="${type}" step="${step}" value="${escapeHtml(value)}" placeholder="value">`;
}

function renderTagExpressionRows() {
  if (!tagExpressionRows) return;
  const options = expressionTagOptions();
  if (!tagExpressionWorking.length) tagExpressionWorking = [{ tag: options[0]?.name || "", op: "==", value: "true", join: "AND" }];
  tagExpressionRows.innerHTML = tagExpressionWorking.map((row, index) => {
    const tag = options.find(t => t.name === row.tag) || options[0];
    const ops = expressionOperatorOptions(tag?.datatype || "string");
    if (tag && !ops.some(([v]) => v === row.op)) row.op = ops[0][0];
    const tagOptions = options.map(t => `<option value="${escapeHtml(t.name)}" ${t.name===row.tag?"selected":""}>${escapeHtml(t.name)}</option>`).join("");
    const opOptions = ops.map(([v,label]) => `<option value="${v}" ${v===row.op?"selected":""}>${label}</option>`).join("");
    return `<div class="tag-condition-row" data-index="${index}">
      ${index ? `<select class="tag-cond-join"><option value="AND" ${row.join!=="OR"?"selected":""}>AND</option><option value="OR" ${row.join==="OR"?"selected":""}>OR</option></select>` : `<span class="tag-cond-where">WHEN</span>`}
      <select class="tag-cond-tag">${tagOptions}</select>
      <select class="tag-cond-op">${opOptions}</select>
      ${conditionValueControl(row, tag)}
      <button type="button" class="tag-cond-remove" title="Remove condition">✕</button>
    </div>`;
  }).join("");
  tagExpressionRows.querySelectorAll(".tag-condition-row").forEach(rowEl => {
    const i = Number(rowEl.dataset.index);
    rowEl.querySelector(".tag-cond-tag").addEventListener("change", e => {
      tagExpressionWorking[i].tag = e.target.value;
      const t = expressionTagOptions().find(x => x.name === e.target.value);
      tagExpressionWorking[i].op = expressionOperatorOptions(t?.datatype || "string")[0][0];
      tagExpressionWorking[i].value = t?.datatype === "bool" ? "true" : "0";
      renderTagExpressionRows();
      updateTagExpressionPreview();
    });
    rowEl.querySelector(".tag-cond-op").addEventListener("change", e => { tagExpressionWorking[i].op = e.target.value; updateTagExpressionPreview(); });
    rowEl.querySelector(".tag-cond-value").addEventListener("input", e => { tagExpressionWorking[i].value = e.target.value; updateTagExpressionPreview(); });
    rowEl.querySelector(".tag-cond-value").addEventListener("change", e => { tagExpressionWorking[i].value = e.target.value; updateTagExpressionPreview(); });
    rowEl.querySelector(".tag-cond-join")?.addEventListener("change", e => { tagExpressionWorking[i].join = e.target.value; updateTagExpressionPreview(); });
    rowEl.querySelector(".tag-cond-remove").addEventListener("click", () => {
      tagExpressionWorking.splice(i, 1);
      renderTagExpressionRows();
      updateTagExpressionPreview();
    });
  });
}

function conditionValueExpression(row) {
  const tag = expressionTagOptions().find(t => t.name === row.tag);
  const dtype = tag?.datatype || "string";
  let value = String(row.value ?? "");
  if (dtype === "bool") value = value === "true" ? "True" : "False";
  else if (["int","float","number"].includes(dtype)) value = value === "" ? "0" : value;
  else value = JSON.stringify(value);
  return `tag(${JSON.stringify(row.tag)}) ${row.op} ${value}`;
}

function buildVisualTagExpression() {
  // The backend evaluates this with Python's own ast.parse(), which only
  // recognizes lowercase `and`/`or` keywords -- not "AND"/"OR". The dropdown
  // shows uppercase for readability, but the generated expression must use
  // lowercase or the backend rejects any multi-condition expression as a
  // syntax error even though every individual condition is valid.
  return tagExpressionWorking.filter(r => r.tag).map((row, i) => `${i ? ` ${(row.join || "AND").toLowerCase()} ` : ""}${conditionValueExpression(row)}`).join("");
}

function updateTagExpressionPreview() {
  const expression = document.getElementById("tag-expression-advanced-toggle")?.checked ? tagExpressionAdvanced.value.trim() : buildVisualTagExpression();
  tagExpressionPreview.textContent = expression || "—";
  tagExpressionError.textContent = "";
  return expression;
}

const SINGLE_TAG_CONDITION_RE = /^tag\((['"])(.*?)\1\)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;

function parseSingleTagCondition(text, join) {
  const m = SINGLE_TAG_CONDITION_RE.exec(text.trim());
  if (!m) return null;
  let raw = m[4].trim();
  if (raw === "True" || raw === "False") raw = raw.toLowerCase();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  return { tag: m[2], op: m[3], value: raw, join };
}

function parseExistingExpression(expression) {
  // Keep existing expressions intact when opening Advanced mode. For the
  // visual builder, reconstruct its rows only when the expression is
  // exactly what the builder itself would produce -- one or more
  // `tag("X") OP value` conditions joined by AND/OR (buildVisualTagExpression()
  // below). Anything else (hand-written Advanced expressions, functions,
  // parentheses) returns null so the caller falls back to Advanced mode
  // instead of silently showing a blank default condition.
  const text = String(expression || "").trim();
  if (!text) return null;

  // Split on top-level and/or joins, but only right before another
  // condition (lookahead for `tag(`) so a join keyword that happens to
  // appear inside a quoted string value is never mistaken for a separator.
  // Case-insensitive so expressions saved before the lowercase fix (or
  // typed by hand in Advanced mode) still reopen correctly.
  const parts = text.split(/\s+(and|or)\s+(?=tag\()/i);
  if (parts.length === 1) {
    const row = parseSingleTagCondition(text, "AND");
    return row ? [row] : null;
  }

  const rows = [];
  let join = "AND";
  for (const part of parts) {
    if (/^(and|or)$/i.test(part)) { join = part.toUpperCase(); continue; }
    const row = parseSingleTagCondition(part, join);
    if (!row) return null;
    rows.push(row);
  }
  return rows;
}

function openTagExpressionEditor(tagName) {
  tagExpressionTarget = tagName;
  const current = latestTags.find(t => t.name === tagName);
  document.getElementById("tag-expression-title").textContent = `Logic for ${tagName}`;
  document.getElementById("tag-expression-subtitle").textContent = current?.datatype ? `Output: ${current.datatype}` : "";
  tagExpressionError.textContent = "";
  const existing = current?.expression || "";
  const parsed = parseExistingExpression(existing);
  // If there IS a saved expression but the visual builder can't represent
  // it, open straight into Advanced mode showing the real text -- never
  // silently fall back to a blank default condition, which made a saved
  // expression look like it had vanished.
  const needsAdvanced = !!existing && !parsed;
  tagExpressionWorking = parsed || [{ tag: expressionTagOptions()[0]?.name || "", op: "==", value: "true", join: "AND" }];
  tagExpressionAdvanced.value = existing;
  document.getElementById("tag-expression-advanced-toggle").checked = needsAdvanced;
  document.getElementById("tag-expression-advanced-wrap").classList.toggle("hidden", !needsAdvanced);
  renderTagExpressionRows();
  updateTagExpressionPreview();
  tagExpressionModal.classList.remove("hidden");
}

document.getElementById("tag-expression-add")?.addEventListener("click", () => {
  const options = expressionTagOptions();
  const tag = options[0];
  tagExpressionWorking.push({ tag: tag?.name || "", op: tag ? expressionOperatorOptions(tag.datatype)[0][0] : "==", value: tag?.datatype === "bool" ? "true" : "0", join: "AND" });
  renderTagExpressionRows();
  updateTagExpressionPreview();
});
document.getElementById("tag-expression-clear")?.addEventListener("click", () => {
  tagExpressionWorking = [];
  tagExpressionAdvanced.value = "";
  renderTagExpressionRows();
  updateTagExpressionPreview();
});
document.getElementById("tag-expression-advanced-toggle")?.addEventListener("change", e => {
  document.getElementById("tag-expression-advanced-wrap").classList.toggle("hidden", !e.target.checked);
  updateTagExpressionPreview();
});
tagExpressionAdvanced?.addEventListener("input", updateTagExpressionPreview);
document.getElementById("tag-expression-save")?.addEventListener("click", () => {
  const advanced = document.getElementById("tag-expression-advanced-toggle").checked;
  const expression = advanced ? tagExpressionAdvanced.value.trim() : buildVisualTagExpression();
  if (!expression) {
    send({ action: "set_tag_expression", name: tagExpressionTarget, expression: "" });
  } else {
    send({ action: "set_tag_expression", name: tagExpressionTarget, expression });
  }
  markDirty();
  tagExpressionModal.classList.add("hidden");
});
["tag-expression-close", "tag-expression-cancel"].forEach(id => document.getElementById(id)?.addEventListener("click", () => tagExpressionModal.classList.add("hidden")));

document.getElementById("tag-add-btn")?.addEventListener("click", () => {
  if (!isDesignMode()) return;
  const name = prompt("Internal tag name (for example: ProductionCount)");
  if (!name) return;
  const datatype = prompt("Data type: bool, int, float, string", "bool") || "bool";
  const description = prompt("Description", "") || "";
  send({ action: "add_tag", name, datatype, description, value: datatype === "bool" ? false : 0, writable: true });
  markDirty();
});

function writableIoPoints() {
  const rows = [];
  for (const [tag, obj] of Object.entries(latestState)) {
    const points = obj._io_points || {};
    for (const [point, writable] of Object.entries(points)) {
      if (writable) rows.push({ tag, point, label: `${tag} → ${point}` });
    }
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

function readableIoPoints() {
  const rows = [];
  for (const [tag, obj] of Object.entries(latestState)) {
    const points = obj._io_points || {};
    for (const point of Object.keys(points)) rows.push({ tag, point, label: `${tag} → ${point}` });
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

function logicSelect(options, selected) {
  return `<select>${options.map(o => `<option value="${o.tag}|${o.point}" ${`${o.tag}|${o.point}` === selected ? "selected" : ""}>${o.label}</option>`).join("")}</select>`;
}

function renderLogicRules() {
  const list = document.getElementById("logic-rules-list");
  if (!list) return;
  const sources = readableIoPoints();
  const destinations = writableIoPoints();
  list.innerHTML = latestLogicRules.map((rule, i) => {
    const src = `${rule.source?.object_tag || ""}|${rule.source?.io_point || ""}`;
    const dst = `${rule.destination?.object_tag || ""}|${rule.destination?.io_point || ""}`;
    const enabled = rule.enabled !== false;
    return `<div class="mapping-card logic-rule" data-index="${i}">
      <span class="logic-rule-num">RULE ${i + 1}</span>
      <button class="logic-delete" type="button" title="Delete rule">✕</button>
      <div class="logic-rule-head">
        <label class="logic-toggle" title="Enable/disable rule">
          <input class="logic-enabled" type="checkbox" ${enabled ? "checked" : ""}>
          <span class="logic-toggle-slider"></span>
        </label>
        <span class="logic-toggle-label">${enabled ? "Enabled" : "Disabled"}</span>
      </div>
      <div class="logic-rule-row logic-rule-if">
        <span class="logic-rule-tag">IF</span>
        ${logicSelect(sources, src)}
        <select class="logic-op">
          <option value="truthy" ${rule.operator === "truthy" ? "selected" : ""}>is ON</option>
          <option value="equals" ${rule.operator === "equals" ? "selected" : ""}>equals</option>
          <option value="not_equals" ${rule.operator === "not_equals" ? "selected" : ""}>not equals</option>
          <option value="rising" ${rule.operator === "rising" ? "selected" : ""}>rising edge</option>
          <option value="falling" ${rule.operator === "falling" ? "selected" : ""}>falling edge</option>
        </select>
        <input class="logic-value" type="text" placeholder="compare value" value="${rule.value ?? ""}">
        <label class="logic-delay">Delay <input class="logic-delay-ms" type="number" min="0" max="30000" step="50" value="${rule.delay_ms ?? 0}"> ms</label>
      </div>
      <div class="logic-rule-row logic-rule-then">
        <span class="logic-rule-tag logic-rule-tag-then">THEN SET</span>
        ${logicSelect(destinations, dst)}
        <label class="logic-output">ON <input class="logic-true-value" type="text" value="${rule.true_value ?? true}"></label>
        <label class="logic-output">OFF <input class="logic-false-value" type="text" value="${rule.false_value ?? false}"></label>
      </div>
    </div>`;
  }).join("") || '<p class="empty">No rules. Add a rule to connect simulated I/O.</p>';

  list.querySelectorAll(".logic-rule").forEach(card => {
    const i = Number(card.dataset.index);
    const rule = latestLogicRules[i];
    const selects = card.querySelectorAll("select");
    const readPair = value => { const [tag, point] = value.split("|"); return { object_tag: tag, io_point: point }; };
    const changed = () => {
      const [sourceSel, opSel, destSel] = [selects[0], selects[1], selects[2]];
      // opSel is actually the second select; source/destination are 0/2.
      rule.source = readPair(sourceSel.value); rule.operator = opSel.value; rule.destination = readPair(destSel.value);
      rule.value = card.querySelector(".logic-value").value;
      rule.delay_ms = Number(card.querySelector(".logic-delay-ms").value || 0);
      rule.true_value = card.querySelector(".logic-true-value").value;
      rule.false_value = card.querySelector(".logic-false-value").value;
      rule.enabled = card.querySelector(".logic-enabled").checked;
      markDirty(); send({ action: "set_logic_rules", rules: latestLogicRules });
    };
    card.querySelectorAll("select,input").forEach(el => el.addEventListener("change", changed));
    card.querySelector(".logic-enabled")?.addEventListener("change", e => {
      const label = card.querySelector(".logic-toggle-label");
      if (label) label.textContent = e.target.checked ? "Enabled" : "Disabled";
    });
    card.querySelector(".logic-delete")?.addEventListener("click", () => { latestLogicRules.splice(i, 1); markDirty(); send({ action: "set_logic_rules", rules: latestLogicRules }); renderLogicRules(); });
  });
}

document.getElementById("logic-add-btn")?.addEventListener("click", () => {
  if (!isDesignMode()) return;
  const sources = readableIoPoints(), destinations = writableIoPoints();
  if (!sources.length || !destinations.length) { alert("Create at least one readable and one writable I/O point first."); return; }
  latestLogicRules.push({ enabled: true, operator: "truthy", source: { object_tag: sources[0].tag, io_point: sources[0].point }, destination: { object_tag: destinations[0].tag, io_point: destinations[0].point }, value: "", delay_ms: 0, true_value: true, false_value: false });
  markDirty(); send({ action: "set_logic_rules", rules: latestLogicRules }); renderLogicRules();
});

document.getElementById("logic-validate-btn")?.addEventListener("click", () => send({ action: "validate_logic" }));

function sequenceSelect(options, selected) {
  return `<select class="sequence-select">${options.map(o => `<option value="${o.tag}|${o.point}" ${`${o.tag}|${o.point}` === selected ? "selected" : ""}>${o.label}</option>`).join("")}</select>`;
}

function parseSequenceValue(value) {
  const v = String(value ?? "").trim();
  if (v === "true" || v === "on") return true;
  if (v === "false" || v === "off") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function renderSequences() {
  const list = document.getElementById("sequence-list");
  if (!list) return;
  const sources = readableIoPoints();
  const destinations = writableIoPoints();
  list.innerHTML = latestSequences.map((seq, si) => {
    const steps = seq.steps || [];
    return `<div class="mapping-card sequence-card" data-index="${si}" data-seq-id="${seq.id || `sequence_${si + 1}`}">
      <div class="sequence-head">
        <input class="sequence-name" value="${seq.name || `Sequence ${si + 1}`}" placeholder="Sequence name">
        <label><input class="sequence-enabled" type="checkbox" ${seq.enabled !== false ? "checked" : ""}> Enabled</label>
        <label><input class="sequence-auto" type="checkbox" ${seq.auto_start !== false ? "checked" : ""}> Auto start</label>
        <select class="sequence-cycle"><option value="once" ${seq.cycle !== "continuous" ? "selected" : ""}>Once</option><option value="continuous" ${seq.cycle === "continuous" ? "selected" : ""}>Continuous</option></select>
        <button class="sequence-delete" type="button">✕</button>
      </div>
      <div class="sequence-steps">${steps.map((step, pi) => {
        const tr = step.transition || {};
        const trSel = `${tr.object_tag || ""}|${tr.io_point || ""}`;
        const action = (step.actions || [])[0] || { destination: { object_tag: destinations[0]?.tag || "", io_point: destinations[0]?.point || "" }, value: true };
        const actSel = `${action.destination?.object_tag || ""}|${action.destination?.io_point || ""}`;
        return `<div class="sequence-step" data-step="${pi}">
          <div class="sequence-step-title"><b>STEP ${pi + 1}</b><input class="step-name" value="${step.name || `Step ${pi + 1}`}" placeholder="Step name"><button class="step-delete" type="button">✕</button></div>
          <div class="sequence-row"><span>DO</span>${sequenceSelect(destinations, actSel)}<input class="step-value" value="${action.value ?? true}" title="Output value"></div>
          <div class="sequence-row"><span>WAIT UNTIL</span>${sequenceSelect(sources, trSel)}<select class="step-op"><option value="truthy" ${tr.operator === "truthy" ? "selected" : ""}>is ON</option><option value="equals" ${tr.operator === "equals" ? "selected" : ""}>equals</option><option value="not_equals" ${tr.operator === "not_equals" ? "selected" : ""}>not equals</option><option value="rising" ${tr.operator === "rising" ? "selected" : ""}>rising</option><option value="falling" ${tr.operator === "falling" ? "selected" : ""}>falling</option></select><input class="step-condition-value" value="${tr.value ?? ""}" placeholder="value"></div>
          <div class="sequence-row"><span>TIMEOUT</span><input class="step-timeout" type="number" min="0" step="50" value="${step.timeout_ms || 0}"> ms<select class="step-timeout-mode"><option value="fault" ${step.on_timeout !== "advance" && step.on_timeout !== "stop" ? "selected" : ""}>Fault</option><option value="stop" ${step.on_timeout === "stop" ? "selected" : ""}>Stop</option><option value="advance" ${step.on_timeout === "advance" ? "selected" : ""}>Advance</option></select></div>
        </div>`;
      }).join("")}</div>
      <button class="sequence-add-step" type="button">＋ Add step</button>
    </div>`;
  }).join("") || '<p class="empty">No sequences. Add one to build a machine cycle.</p>';
  highlightActiveSteps();

  list.querySelectorAll(".sequence-card").forEach(card => {
    const si = Number(card.dataset.index), seq = latestSequences[si];
    const readPair = value => { const [tag, point] = value.split("|"); return { object_tag: tag, io_point: point }; };
    // Pulls current form values into the in-memory model. Split out from
    // save() so the step-delete handler can sync fields BEFORE mutating
    // seq.steps -- syncing after a splice would iterate the (still full)
    // old step-card DOM against a now-shorter array and throw on the
    // last card, silently aborting the whole click (that was the bug:
    // the X button appeared to do nothing).
    const syncFields = () => {
      seq.name = card.querySelector(".sequence-name").value;
      seq.enabled = card.querySelector(".sequence-enabled").checked;
      seq.auto_start = card.querySelector(".sequence-auto").checked;
      seq.cycle = card.querySelector(".sequence-cycle").value;
      card.querySelectorAll(".sequence-step").forEach((stepCard, pi) => {
        const step = seq.steps[pi];
        if (!step) return;
        const selects = stepCard.querySelectorAll(".sequence-select");
        step.name = stepCard.querySelector(".step-name").value;
        const act = readPair(selects[0].value), tr = readPair(selects[1].value);
        step.actions = [{ destination: act, value: parseSequenceValue(stepCard.querySelector(".step-value").value) }];
        step.transition = { ...tr, operator: stepCard.querySelector(".step-op").value, value: parseSequenceValue(stepCard.querySelector(".step-condition-value").value) };
        step.timeout_ms = Number(stepCard.querySelector(".step-timeout").value || 0);
        step.on_timeout = stepCard.querySelector(".step-timeout-mode").value;
      });
    };
    const save = () => { syncFields(); markDirty(); send({ action: "set_sequences", sequences: latestSequences }); };
    card.querySelectorAll("input,select").forEach(el => el.addEventListener("change", save));
    card.querySelector(".sequence-delete")?.addEventListener("click", () => { latestSequences.splice(si, 1); markDirty(); send({ action: "set_sequences", sequences: latestSequences }); renderSequences(); });
    card.querySelector(".sequence-add-step")?.addEventListener("click", () => {
      const source = sources[0] || { tag: "", point: "" }, dest = destinations[0] || { tag: "", point: "" };
      syncFields();
      seq.steps.push({ name: `Step ${seq.steps.length + 1}`, actions: [{ destination: { object_tag: dest.tag, io_point: dest.point }, value: true }], transition: { object_tag: source.tag, io_point: source.point, operator: "truthy", value: "" }, timeout_ms: 0, on_timeout: "fault" });
      markDirty(); send({ action: "set_sequences", sequences: latestSequences }); renderSequences();
    });
    card.querySelectorAll(".step-delete").forEach(btn => btn.addEventListener("click", () => {
      const pi = Number(btn.closest(".sequence-step").dataset.step);
      syncFields();
      if (seq.steps.length > 1) seq.steps.splice(pi, 1);
      markDirty(); send({ action: "set_sequences", sequences: latestSequences }); renderSequences();
    }));
  });
}

function renderSequenceStatus() {
  const list = document.getElementById("sequence-status-list");
  if (!list) return;
  list.innerHTML = latestSequenceStatus.map(s => `<div class="sequence-status ${s.status}"><b>${s.name}</b><span>${s.status.toUpperCase()}</span><span>${s.step || "—"}</span>${s.fault ? `<em>${s.fault}</em>` : ""}</div>`).join("");
  highlightActiveSteps();
}

// Turns on the STEP badge for whichever step is currently executing, using
// the state index reported per sequence id in latestSequenceStatus. Only
// toggles classes on the already-rendered cards so it never disturbs
// in-progress edits (no re-render / no lost input focus).
function highlightActiveSteps() {
  const list = document.getElementById("sequence-list");
  if (!list) return;
  const statusById = new Map(latestSequenceStatus.map(s => [String(s.id), s]));
  list.querySelectorAll(".sequence-card").forEach(card => {
    const s = statusById.get(card.dataset.seqId);
    const activeIndex = s && s.state >= 0 ? s.state : -1;
    const isFault = s && s.status === "fault";
    card.querySelectorAll(".sequence-step").forEach(stepEl => {
      const pi = Number(stepEl.dataset.step);
      const isActive = pi === activeIndex;
      stepEl.classList.toggle("active-step", isActive);
      stepEl.classList.toggle("fault-step", isActive && isFault);
    });
  });
}

document.getElementById("sequence-add-btn")?.addEventListener("click", () => {
  if (!isDesignMode()) return;
  const source = readableIoPoints()[0], dest = writableIoPoints()[0];
  if (!source || !dest) { alert("Create at least one readable and one writable I/O point first."); return; }
  latestSequences.push({ id: `sequence_${Date.now()}`, name: `Sequence ${latestSequences.length + 1}`, enabled: true, auto_start: true, cycle: "once", steps: [{ name: "Step 1", actions: [{ destination: { object_tag: dest.tag, io_point: dest.point }, value: true }], transition: { object_tag: source.tag, io_point: source.point, operator: "truthy", value: "" }, timeout_ms: 0, on_timeout: "fault" }] });
  markDirty(); send({ action: "set_sequences", sequences: latestSequences }); renderSequences();
});
document.getElementById("sequence-validate-btn")?.addEventListener("click", () => send({ action: "validate_sequences" }));
document.getElementById("sequence-reset-btn")?.addEventListener("click", () => send({ action: "sequence_command", command: "reset" }));

function sendSetPoint(tagName, point, value) {
  send({ action: "set_point", tag_name: tagName, point, value });
}

function sendAddComponent(componentType, x, y) {
  pushHistory();
  markDirty();
  send({ action: "add_component", component_type: componentType, x, y });
}

let currentFileHandle = null;
let lastSavedProjectData = null;
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
  lastSavedProjectData = data;
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
  send({ action: "save_project", metadata: latestProjectMetadata || {} });
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

document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    performSave();
  }
});

window.addEventListener("beforeunload", e => {
  if (!projectDirty) return;
  e.preventDefault();
  e.returnValue = "";
});

document.getElementById("recover-project-btn")?.addEventListener("click", async () => {
  const backup = readRecoveryBackup();
  if (!backup?.data) return;
  const stamp = backup.saved_at ? new Date(backup.saved_at).toLocaleString() : "unknown time";
  if (!confirm(`Recover the automatic OMS backup from ${stamp}?\n\nThe recovered project will become the current project and should be saved afterward.`)) return;
  if (projectDirty && !(await (async () => {
    const saveFirst = confirm("Current project has unsaved changes. OK = save it first. Cancel = recover without saving.");
    if (saveFirst) await performSave();
    return true;
  })())) return;
  const data = backup.data;
  currentProjectFilename = `${backup.filename || "recovered"}_recovered`.replace(/\.oms$/i, "");
  currentFileHandle = null;
  updateFileNameUI();
  markClean();
  deselectAll();
  applyLoadedConnectionSettings(data.plc_connection);
  send({ action: "load_project", data });
});

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
    send({ action: "load_project", data });
  };
  reader.readAsText(file);
  e.target.value = ""; // allow re-opening the same file later
});

document.getElementById("reset-view-btn").addEventListener("click", () => {
  if (!isDesignMode()) return;
  if (!confirm("Remove all components from the simulation area?")) return;
  pushHistory();
  markDirty();
  send({ action: "reset_view" });
});

function sendDeleteComponent(tagName) {
  if (!tagName) return;
  pushHistory();
  markDirty();
  send({
    action: "delete_component",
    tag_name: tagName
  });
}

// ---------- Operator dashboard ----------
let dashboardOpen = false;
function setDashboardOpen(open) {
  dashboardOpen = !!open;
  const overlay = document.getElementById("dashboard-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !dashboardOpen);
  overlay.setAttribute("aria-hidden", dashboardOpen ? "false" : "true");
  if (dashboardOpen) renderDashboard();
}

function dashboardMachineStatus(obj) {
  const fault = !!(obj.fault || obj.emergency_stop || obj.error);
  if (fault) return ["FAULT", "fault"];
  if (obj.type === "conveyor" || obj.type === "motor") return obj.running ? ["RUNNING", "running"] : ["STOPPED", "stopped"];
  if (obj.type === "cylinder") {
    if (obj.moving) return ["MOVING", "running"];
    if (obj.fault) return ["FAULT", "fault"];
    return ["READY", "stopped"];
  }
  if (obj.type === "sensor") return obj.detected ? ["ACTIVE", "active"] : ["READY", "stopped"];
  if (obj.type === "emergency_push_button") return obj.pressed ? ["PRESSED", "fault"] : ["READY", "stopped"];
  if (obj.type === "push_button" || obj.type === "toggle_switch") return obj.pressed || obj.value ? ["ON", "active"] : ["OFF", "stopped"];
  return ["READY", "stopped"];
}

function renderDashboard() {
  const overlay = document.getElementById("dashboard-overlay");
  if (!overlay) return;
  setText("dashboard-mode", omsMode.charAt(0).toUpperCase() + omsMode.slice(1));
  setText("dashboard-project", currentProjectFilename || "Untitled");
  setText("dashboard-clock", new Date().toLocaleTimeString());

  const p = latestProduction || {};
  setText("dash-total", p.total_count ?? 0);
  setText("dash-good", p.good_count ?? 0);
  setText("dash-reject", p.reject_count ?? 0);
  setText("dash-oee", `${((p.oee || 0) * 100).toFixed(1)}%`);
  setText("dash-availability", `${((p.availability || 0) * 100).toFixed(1)}%`);
  setText("dash-performance", `${((p.performance || 0) * 100).toFixed(1)}%`);
  setText("dash-quality", `${((p.quality || 0) * 100).toFixed(1)}%`);
  setText("dash-cycle", Number.isFinite(p.cycle_time_s) ? `${p.cycle_time_s.toFixed(1)} s` : "—");
  setText("dash-shift-name", p.shift?.name || "Shift 1");
  setText("dash-shift-elapsed", formatDuration(p.shift?.elapsed_seconds));

  const machines = Object.entries(latestState || {}).filter(([, o]) => ["conveyor", "motor", "cylinder"].includes(o.type));
  const faultCount = machines.filter(([, o]) => dashboardMachineStatus(o)[1] === "fault").length;
  const runningCount = machines.filter(([, o]) => dashboardMachineStatus(o)[1] === "running").length;
  setText("dash-machine-summary", `${runningCount} running · ${faultCount} fault`);
  const machineEl = document.getElementById("dashboard-machines");
  if (machineEl) {
    machineEl.innerHTML = machines.length ? machines.map(([name, obj]) => {
      const [label, cls] = dashboardMachineStatus(obj);
      return `<div class="dashboard-machine-row"><span class="dashboard-machine-name">${escapeHtml(name)}</span><span class="dashboard-status ${cls}"><i></i>${label}</span></div>`;
    }).join("") : '<div class="dashboard-empty">No machine equipment configured.</div>';
  }

  const active = latestAlarms?.active || [];
  setText("dash-alarm-count", active.length);
  const alarmEl = document.getElementById("dashboard-alarms");
  if (alarmEl) alarmEl.innerHTML = active.length ? active.slice(0, 8).map(a =>
    `<div class="dashboard-alarm-row ${escapeHtml(a.severity || "warning")}"><span class="dashboard-alarm-severity">${escapeHtml((a.severity || "warning").toUpperCase())}</span><span>${escapeHtml(a.name || a.id)}</span><small>${a.acknowledged ? "ACK" : "ACTIVE"}</small></div>`
  ).join("") : '<div class="dashboard-empty">No active alarms.</div>';

  const plc = latestPlc || {};
  const plcStatus = document.getElementById("dashboard-plc-status");
  if (plcStatus) {
    plcStatus.className = `dashboard-plc-status ${plc.connected ? (plc.comms_healthy === false ? "fault" : "connected") : ""}`;
    plcStatus.textContent = plc.connected ? (plc.comms_healthy === false ? "CONNECTED — COMMS LOST" : `CONNECTED — ${String(plc.backend || "PLC").toUpperCase()}`) : "NOT CONNECTED";
  }
  setText("dashboard-plc-detail", plc.connected ? (plc.paused ? "PLC communication is paused." : "Live PLC values are available.") : "Simulation values are local.");
}

// ---------- Operator screens ----------
function loadOperatorScreensFromMetadata(metadata) {
  const raw = metadata?.operator_screens;
  customOperatorScreens = Array.isArray(raw) ? raw.filter(s => s && s.id && s.title).map(s => ({
    id: String(s.id), title: String(s.title), description: String(s.description || "Custom operator screen"),
    modules: Array.isArray(s.modules) ? s.modules.filter(m => BUILTIN_OPERATOR_SCREENS[m]) : ["machine"],
    widgets: sanitizeWidgets(s.widgets),
  })) : [];
  if (customOperatorScreens.some(s => s.id === activeOperatorScreen) || BUILTIN_OPERATOR_SCREENS[activeOperatorScreen]) return;
  activeOperatorScreen = "machine";
}
function allOperatorScreens() {
  const custom = Object.fromEntries(customOperatorScreens.map(s => [s.id, s]));
  return { ...BUILTIN_OPERATOR_SCREENS, ...custom };
}
function persistOperatorScreens() {
  latestProjectMetadata = { ...(latestProjectMetadata || {}), operator_screens: customOperatorScreens };
  markDirty();
}
function renderOperatorScreenCards() {
  const el = document.getElementById("operator-screen-grid");
  if (!el) return;
  const screens = allOperatorScreens();
  const cards = Object.entries(screens).map(([id, screen]) => `
    <div class="operator-screen-card-wrap">
      <button type="button" class="operator-screen-card ${activeOperatorScreen === id ? "active" : ""}" data-open-operator-screen="${escapeHtml(id)}">
        <span class="operator-screen-card-title">${escapeHtml(screen.title)}</span>
        <span class="operator-screen-card-description">${escapeHtml(screen.description)}</span>
        <span class="operator-screen-card-open">Open →</span>
      </button>
      ${id.startsWith("custom_") ? `<button type="button" class="operator-screen-delete" data-delete-operator-screen="${escapeHtml(id)}">Delete</button>` : ""}
    </div>`).join("");
  el.innerHTML = cards + `<button type="button" class="operator-screen-card operator-screen-add" id="add-operator-screen-btn"><span class="operator-screen-card-title">＋ New Screen</span><span class="operator-screen-card-description">Create a project-specific operator screen from existing OMS views.</span><span class="operator-screen-card-open">Configure →</span></button>`;
  el.querySelectorAll("[data-open-operator-screen]").forEach(btn => btn.addEventListener("click", () => openOperatorScreen(btn.dataset.openOperatorScreen)));
  el.querySelectorAll("[data-delete-operator-screen]").forEach(btn => btn.addEventListener("click", () => deleteCustomOperatorScreen(btn.dataset.deleteOperatorScreen)));
  document.getElementById("add-operator-screen-btn")?.addEventListener("click", () => setCustomScreenEditorOpen(true));
}
function setScreensOpen(open) {
  screensOpen = !!open;
  const overlay = document.getElementById("screens-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !screensOpen);
  overlay.setAttribute("aria-hidden", screensOpen ? "false" : "true");
  if (screensOpen) renderOperatorScreenCards();
}
function setCustomScreenEditorOpen(open) {
  customScreenEditorOpen = !!open;
  const el = document.getElementById("operator-screen-editor");
  if (!el) return;
  el.classList.toggle("hidden", !customScreenEditorOpen);
  if (customScreenEditorOpen) {
    document.getElementById("custom-screen-title").value = "";
    document.getElementById("custom-screen-description").value = "";
    document.querySelectorAll("[data-screen-module]").forEach((c, i) => c.checked = i === 0);
  }
}
function createCustomOperatorScreen() {
  const title = document.getElementById("custom-screen-title")?.value.trim();
  if (!title) { alert("Please enter a screen name."); return; }
  const modules = [...document.querySelectorAll("[data-screen-module]:checked")].map(c => c.dataset.screenModule);
  const id = `custom_${Date.now()}`;
  customOperatorScreens.push({ id, title, description: document.getElementById("custom-screen-description")?.value.trim() || "Custom operator screen", modules, widgets: [] });
  persistOperatorScreens();
  setCustomScreenEditorOpen(false);
  renderOperatorScreenCards();
  openOperatorScreen(id);
}
function deleteCustomOperatorScreen(id) {
  const screen = customOperatorScreens.find(s => s.id === id);
  if (!screen || !confirm(`Delete operator screen "${screen.title}"?`)) return;
  customOperatorScreens = customOperatorScreens.filter(s => s.id !== id);
  if (activeOperatorScreen === id) activeOperatorScreen = "machine";
  persistOperatorScreens();
  renderOperatorScreenCards();
  renderRuntimeScreenBar();
}
function selectInspectorTab(tabName) {
  const btn = document.querySelector(`.tabs .tab[data-tab="${tabName}"]`);
  if (!btn) return false;
  btn.click();
  return true;
}
function setPanelFullscreen(on) { document.body.classList.toggle("panel-fullscreen", !!on); }
function closeOperatorOverlays() {
  setScreensOpen(false); setDashboardOpen(false); setReportsOpen(false); closeCustomRuntimeScreen(); setPanelFullscreen(false);
}
document.getElementById("panel-fullscreen-close")?.addEventListener("click", () => openOperatorScreen("machine"));
document.addEventListener("keydown", e => { if (e.key === "Escape" && document.body.classList.contains("panel-fullscreen")) openOperatorScreen("machine"); });
function openOperatorScreen(screenId) {
  const screens = allOperatorScreens();
  if (!screens[screenId]) return;
  activeOperatorScreen = screenId;
  document.querySelectorAll(".runtime-screen-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.operatorScreen === screenId));
  closeOperatorOverlays();
  if (BUILTIN_OPERATOR_SCREENS[screenId]) {
    if (screenId === "machine") return;
    if (screenId === "dashboard") { setDashboardOpen(true); return; }
    if (screenId === "reports") { setReportsOpen(true); return; }
    if (selectInspectorTab(screenId)) setPanelFullscreen(true); return;
  }
  const custom = customOperatorScreens.find(s => s.id === screenId);
  if (custom) openCustomOperatorScreen(custom);
}
function openCustomOperatorScreen(screen) {
  const overlay = document.getElementById("custom-runtime-overlay");
  const title = document.getElementById("custom-runtime-title");
  const desc = document.getElementById("custom-runtime-description");
  const grid = document.getElementById("custom-runtime-grid");
  if (!overlay || !grid) return;
  activeCustomScreenId = screen.id; widgetEditMode = false; selectedWidgetId = null;
  title.textContent = screen.title; desc.textContent = screen.description;
  grid.innerHTML = screen.modules.map(id => {
    const view = BUILTIN_OPERATOR_SCREENS[id];
    return `<button type="button" class="custom-runtime-tile" data-custom-module="${escapeHtml(id)}"><b>${escapeHtml(view.title)}</b><span>${escapeHtml(view.description)}</span><small>Open →</small></button>`;
  }).join("");
  grid.querySelectorAll("[data-custom-module]").forEach(btn => btn.addEventListener("click", () => openOperatorScreen(btn.dataset.customModule)));
  overlay.classList.remove("hidden"); overlay.setAttribute("aria-hidden", "false");
  applyCustomScreenMode();
}
function closeCustomRuntimeScreen() {
  const overlay = document.getElementById("custom-runtime-overlay");
  if (overlay) { overlay.classList.add("hidden"); overlay.setAttribute("aria-hidden", "true"); }
  activeCustomScreenId = null; widgetEditMode = false; selectedWidgetId = null;
  applyCustomScreenMode();
}

// ---------- Custom screen widgets ----------
// A custom operator screen can hold live widgets bound to OMS tags.
// Layout is edited in Design mode; widgets are live in Simulation/Runtime.
// Values are updated IN PLACE (never rebuilt per tick) so clicks are not lost.
const WIDGET_TYPES = {
  value: { label: "Value", w: 160, h: 80 },
  indicator: { label: "Indicator", w: 160, h: 50 },
  button: { label: "Button", w: 140, h: 56 },
  label: { label: "Label", w: 220, h: 40 },
  alarms: { label: "Alarms", w: 160, h: 80 },
};
const WIDGET_COLORS = { green: "#2fbf5b", red: "#e04545", yellow: "#e0b030", blue: "#3d8bdc" };
const WIDGET_GRID = 10;

function sanitizeWidgets(raw) {
  if (!Array.isArray(raw)) return [];
  const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };
  return raw.filter(w => w && WIDGET_TYPES[w.type]).map((w, i) => ({
    id: String(w.id || `w_${Date.now()}_${i}`),
    type: w.type,
    x: num(w.x, 20, 0, 5000), y: num(w.y, 20, 0, 5000),
    w: num(w.w, WIDGET_TYPES[w.type].w, 30, 1200), h: num(w.h, WIDGET_TYPES[w.type].h, 20, 800),
    tag: String(w.tag || ""), label: String(w.label ?? ""), unit: String(w.unit || ""),
    decimals: (w.decimals === "" || w.decimals == null) ? "" : num(w.decimals, 0, 0, 6),
    color: WIDGET_COLORS[w.color] ? w.color : "green",
    mode: ["momentary", "toggle", "set"].includes(w.mode) ? w.mode : "momentary",
    setValue: String(w.setValue ?? "1"),
  }));
}
function currentCustomScreen() { return customOperatorScreens.find(s => s.id === activeCustomScreenId) || null; }
function widgetTagMap() { return new Map((latestTags || []).map(t => [t.name, t])); }
function widgetIsOn(tag) {
  const v = tag?.value;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return !!v;
}
function widgetButtonsEnabled() { return (isSimulationMode() || isRuntimeMode()) && !widgetEditMode; }
function formatWidgetValue(w, tag) {
  if (!tag) return "—";
  const v = tag.value;
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "ON" : "OFF";
  const txt = typeof v === "number" && w.decimals !== "" ? v.toFixed(w.decimals) : String(v);
  return w.unit ? `${txt} ${w.unit}` : txt;
}
function widgetOnOffValue(tag, on) { return typeof tag?.value === "boolean" ? on : (on ? 1 : 0); }
function parseWidgetSetValue(text, tag) {
  if (typeof tag?.value === "boolean") return !["", "0", "false", "off"].includes(String(text).trim().toLowerCase());
  if (typeof tag?.value === "number") { const n = Number(text); return Number.isFinite(n) ? n : 0; }
  return String(text);
}
function sendWidgetTag(name, value) { send({ action: "set_tag", name, value }); }

function renderWidgetCanvas() {
  const canvas = document.getElementById("widget-canvas");
  const screen = currentCustomScreen();
  if (!canvas) return;
  canvas.classList.toggle("editing", widgetEditMode);
  if (!screen) { canvas.innerHTML = ""; return; }
  canvas.innerHTML = screen.widgets.map(w => {
    const title = escapeHtml(w.label || w.tag || WIDGET_TYPES[w.type].label);
    const inner = {
      value: `<span class="cw-title">${title}</span><span class="cw-val" data-role="val">—</span>`,
      indicator: `<span class="cw-lamp" data-role="lamp"></span><span class="cw-title">${title}</span>`,
      button: `<button type="button" class="cw-btn" data-role="btn">${title}</button>`,
      label: `<span class="cw-text">${escapeHtml(w.label || "Label")}</span>`,
      alarms: `<span class="cw-title">${escapeHtml(w.label || "Active alarms")}</span><span class="cw-val" data-role="val">0</span>`,
    }[w.type];
    return `<div class="cw cw-${w.type} ${widgetEditMode && w.id === selectedWidgetId ? "selected" : ""}" data-wid="${escapeHtml(w.id)}" style="left:${w.x}px;top:${w.y}px;width:${w.w}px;height:${w.h}px">${inner}</div>`;
  }).join("");
  updateCustomWidgetValues();
}

function setTextIfChanged(el, text) { if (el && el.textContent !== text) el.textContent = text; }
function updateCustomWidgetValues() {
  const canvas = document.getElementById("widget-canvas");
  const screen = currentCustomScreen();
  if (!canvas || !screen) return;
  const tags = widgetTagMap();
  const enabled = widgetButtonsEnabled();
  canvas.querySelectorAll("[data-wid]").forEach(el => {
    const w = screen.widgets.find(x => x.id === el.dataset.wid);
    if (!w) return;
    const tag = tags.get(w.tag);
    el.classList.toggle("missing", w.type !== "label" && w.type !== "alarms" && !!w.tag && !tag);
    if (w.type === "value") setTextIfChanged(el.querySelector('[data-role="val"]'), formatWidgetValue(w, tag));
    else if (w.type === "indicator") {
      const lamp = el.querySelector('[data-role="lamp"]');
      const on = !!tag && widgetIsOn(tag);
      lamp.style.background = on ? WIDGET_COLORS[w.color] : "#26323d";
      lamp.style.boxShadow = on ? `0 0 10px ${WIDGET_COLORS[w.color]}` : "none";
    } else if (w.type === "button") {
      const btn = el.querySelector('[data-role="btn"]');
      const usable = enabled && !!tag && tag.writable !== false;
      btn.disabled = !usable;
      btn.title = usable ? "" : (!w.tag ? "No tag selected" : !tag ? "Tag not found" : widgetEditMode ? "" : (isDesignMode() ? "Active in Simulation / Runtime" : "Tag is read-only"));
      btn.classList.toggle("on", !!tag && w.mode === "toggle" && widgetIsOn(tag));
    } else if (w.type === "alarms") {
      const active = latestAlarms.active || [];
      setTextIfChanged(el.querySelector('[data-role="val"]'), String(latestAlarms.active_count ?? active.length));
      el.classList.toggle("alarm-on", active.some(x => !x.acknowledged));
    }
  });
}

function selectWidget(id) {
  selectedWidgetId = id;
  document.querySelectorAll("#widget-canvas [data-wid]").forEach(el => el.classList.toggle("selected", widgetEditMode && el.dataset.wid === id));
  renderWidgetEditor();
}
function addWidget(type) {
  const screen = currentCustomScreen();
  if (!screen || !WIDGET_TYPES[type]) return;
  const n = screen.widgets.length % 12;
  const [w] = sanitizeWidgets([{ id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type, x: 20 + n * 20, y: 20 + n * 20, label: type === "label" ? "Label" : "" }]);
  screen.widgets.push(w);
  selectedWidgetId = w.id;
  persistOperatorScreens(); renderWidgetCanvas(); renderWidgetEditor();
}
function deleteSelectedWidget() {
  const screen = currentCustomScreen();
  if (!screen || !selectedWidgetId) return;
  screen.widgets = screen.widgets.filter(w => w.id !== selectedWidgetId);
  selectedWidgetId = null;
  persistOperatorScreens(); renderWidgetCanvas(); renderWidgetEditor();
}

function renderWidgetEditor() {
  const panel = document.getElementById("widget-editor");
  if (!panel) return;
  const screen = currentCustomScreen();
  panel.hidden = !(widgetEditMode && screen);
  if (panel.hidden) return;
  const w = screen.widgets.find(x => x.id === selectedWidgetId);
  const tools = Object.entries(WIDGET_TYPES).map(([t, d]) => `<button type="button" class="widget-tool" data-add-widget="${t}">+ ${d.label}</button>`).join("");
  const tagList = `<datalist id="widget-tag-list">${(latestTags || []).map(t => `<option value="${escapeHtml(t.name)}"></option>`).join("")}</datalist>`;
  const field = (key, label, type = "text", extra = "") => `<label>${label}<input data-wf="${key}" type="${type}" value="${escapeHtml(w[key])}" ${extra}></label>`;
  let form = '<p class="widget-hint">Click a widget to edit it, or add one above. Drag to move.</p>';
  if (w) {
    form = `<div class="widget-form-title">${WIDGET_TYPES[w.type].label}</div>`;
    if (w.type !== "alarms" || true) form += field("label", "Label");
    if (w.type === "value" || w.type === "indicator" || w.type === "button") form += field("tag", "Tag", "text", 'list="widget-tag-list" autocomplete="off"');
    if (w.type === "value") form += field("unit", "Unit") + field("decimals", "Decimals (empty = auto)", "number", 'min="0" max="6"');
    if (w.type === "indicator") form += `<label>On color<select data-wf="color">${Object.keys(WIDGET_COLORS).map(c => `<option value="${c}" ${w.color === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>`;
    if (w.type === "button") {
      form += `<label>Mode<select data-wf="mode">${[["momentary", "Momentary (hold)"], ["toggle", "Toggle"], ["set", "Set value"]].map(([v, t]) => `<option value="${v}" ${w.mode === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
      if (w.mode === "set") form += field("setValue", "Value to write");
    }
    form += `<div class="widget-geom">${field("x", "X", "number", 'min="0"')}${field("y", "Y", "number", 'min="0"')}${field("w", "W", "number", 'min="30"')}${field("h", "H", "number", 'min="20"')}</div>`;
    form += '<button type="button" class="widget-delete" data-delete-widget>Delete widget</button>';
  }
  panel.innerHTML = `<div class="widget-tools">${tools}</div>${tagList}${form}`;
}

function syncWidgetGeometryInputs(w) {
  document.querySelectorAll("#widget-editor [data-wf]").forEach(inp => {
    if (["x", "y", "w", "h"].includes(inp.dataset.wf)) inp.value = w[inp.dataset.wf];
  });
}

document.getElementById("widget-editor")?.addEventListener("click", e => {
  const add = e.target.closest("[data-add-widget]");
  if (add) { addWidget(add.dataset.addWidget); return; }
  if (e.target.closest("[data-delete-widget]")) deleteSelectedWidget();
});
document.getElementById("widget-editor")?.addEventListener("input", e => {
  const key = e.target.dataset?.wf;
  const screen = currentCustomScreen();
  const w = screen?.widgets.find(x => x.id === selectedWidgetId);
  if (!key || !w) return;
  const raw = e.target.value;
  if (["x", "y", "w", "h"].includes(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    w[key] = Math.max(key === "w" ? 30 : key === "h" ? 20 : 0, Math.round(n));
  } else if (key === "decimals") {
    w.decimals = raw === "" ? "" : Math.min(6, Math.max(0, Math.round(Number(raw)) || 0));
  } else {
    w[key] = raw;
  }
  persistOperatorScreens();
  renderWidgetCanvas();
  if (key === "mode") renderWidgetEditor();
});

document.getElementById("widget-canvas")?.addEventListener("pointerdown", e => {
  const el = e.target.closest("[data-wid]");
  const screen = currentCustomScreen();
  if (!screen) return;
  if (!el) { if (widgetEditMode && selectedWidgetId) selectWidget(null); return; }
  const w = screen.widgets.find(x => x.id === el.dataset.wid);
  if (!w) return;

  if (widgetEditMode) {                       // ---- drag to move
    e.preventDefault();
    selectWidget(w.id);
    const sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = ev => {
      moved = true;
      w.x = Math.max(0, Math.round((ox + ev.clientX - sx) / WIDGET_GRID) * WIDGET_GRID);
      w.y = Math.max(0, Math.round((oy + ev.clientY - sy) / WIDGET_GRID) * WIDGET_GRID);
      el.style.left = `${w.x}px`; el.style.top = `${w.y}px`;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (moved) { persistOperatorScreens(); syncWidgetGeometryInputs(w); }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return;
  }

  if (w.type !== "button" || !e.target.closest(".cw-btn")) return;   // ---- live button
  const tag = widgetTagMap().get(w.tag);
  if (!widgetButtonsEnabled() || !tag || tag.writable === false) return;
  if (w.mode === "toggle") { sendWidgetTag(w.tag, widgetOnOffValue(tag, !widgetIsOn(tag))); return; }
  if (w.mode === "set") { sendWidgetTag(w.tag, parseWidgetSetValue(w.setValue, tag)); return; }
  sendWidgetTag(w.tag, widgetOnOffValue(tag, true));                  // momentary: on while held
  const release = () => {
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    sendWidgetTag(w.tag, widgetOnOffValue(tag, false));
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
});

document.getElementById("widget-edit-btn")?.addEventListener("click", () => {
  widgetEditMode = !widgetEditMode;
  selectedWidgetId = null;
  applyCustomScreenMode();
});

function applyCustomScreenMode() {
  if (!isDesignMode()) widgetEditMode = false;
  const btn = document.getElementById("widget-edit-btn");
  if (btn) { btn.hidden = !(isDesignMode() && activeCustomScreenId); btn.textContent = widgetEditMode ? "Done editing" : "Edit layout"; }
  document.getElementById("custom-runtime-overlay")?.classList.toggle("widget-editing", widgetEditMode);
  renderWidgetCanvas();
  renderWidgetEditor();
}

document.getElementById("screens-btn")?.addEventListener("click", () => setScreensOpen(true));
document.getElementById("screens-close-btn")?.addEventListener("click", () => setScreensOpen(false));
document.getElementById("screens-overlay")?.addEventListener("click", e => { if (e.target.id === "screens-overlay") setScreensOpen(false); });
document.getElementById("custom-screen-cancel-btn")?.addEventListener("click", () => setCustomScreenEditorOpen(false));
document.getElementById("custom-screen-create-btn")?.addEventListener("click", createCustomOperatorScreen);
document.getElementById("custom-runtime-close-btn")?.addEventListener("click", () => closeCustomRuntimeScreen());
document.addEventListener("keydown", e => { if (e.key === "Escape" && screensOpen) setScreensOpen(false); });
function renderRuntimeScreenBar() {
  const bar = document.getElementById("runtime-screen-bar");
  if (!bar) return;
  const visible = isRuntimeMode();
  bar.classList.toggle("hidden", !visible);
  if (!visible) return;

  const screens = allOperatorScreens();
  const ids = [
    "machine", "dashboard", "alarms", "trends", "production",
    "diagnostics", "reports", ...customOperatorScreens.map(s => s.id)
  ];

  // Keep only valid screen IDs so one stale project entry cannot break
  // the whole navigation bar.
  const validIds = ids.filter(id => screens[id]);
  bar.innerHTML = validIds.map(id => `
    <button type="button" data-operator-screen="${escapeHtml(id)}"
      class="runtime-screen-btn ${activeOperatorScreen === id ? "active" : ""}">
      ${escapeHtml(screens[id].title)}${id === "alarms" ? '<span class="runtime-badge" hidden></span>' : ""}
    </button>`).join("");
  updateAlarmBadge();
}
function updateAlarmBadge() {
  const badge = document.querySelector('#runtime-screen-bar [data-operator-screen="alarms"] .runtime-badge');
  if (!badge) return;
  const active = latestAlarms.active || [];
  const total = latestAlarms.active_count ?? active.length;
  const unack = active.filter(x => !x.acknowledged).length;
  badge.textContent = String(total);
  badge.hidden = total === 0;
  badge.classList.toggle("unack", unack > 0);
}

// One delegated handler is more reliable than rebinding individual buttons
// every time the bar is rebuilt. It also keeps navigation working after a
// project load or when custom screens are added/deleted.
document.getElementById("runtime-screen-bar")?.addEventListener("click", e => {
  const btn = e.target.closest("[data-operator-screen]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openOperatorScreen(btn.dataset.operatorScreen);
});

function updateOperatorScreenBar() { renderRuntimeScreenBar(); }

document.getElementById("dashboard-btn")?.addEventListener("click", () => setDashboardOpen(true));
document.getElementById("dashboard-close-btn")?.addEventListener("click", () => setDashboardOpen(false));
document.getElementById("dashboard-overlay")?.addEventListener("click", e => { if (e.target.id === "dashboard-overlay") setDashboardOpen(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && dashboardOpen) setDashboardOpen(false); });

// ---------- Operational reports ----------
let reportsOpen = false;
function setReportsOpen(open) {
  reportsOpen = !!open;
  const overlay = document.getElementById("reports-overlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !reportsOpen);
  overlay.setAttribute("aria-hidden", reportsOpen ? "false" : "true");
  if (reportsOpen) renderReports();
}

function reportTime(value) {
  if (!value) return "—";
  const d = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function renderReports() {
  const p = latestProduction || {};
  setText("reports-project", currentProjectFilename || "Untitled");
  setText("reports-shift-name", p.shift?.name || "Shift 1");
  setText("reports-shift-start", reportTime(p.shift?.started_at));
  setText("reports-shift-elapsed", formatDuration(p.shift?.elapsed_seconds));
  const prod = document.getElementById("reports-production");
  if (prod) {
    const metrics = [
      ["Total", p.total_count ?? 0],
      ["Good", p.good_count ?? 0],
      ["Reject", p.reject_count ?? 0],
      ["OEE", `${((p.oee || 0) * 100).toFixed(1)}%`],
      ["Availability", `${((p.availability || 0) * 100).toFixed(1)}%`],
      ["Performance", `${((p.performance || 0) * 100).toFixed(1)}%`],
      ["Quality", `${((p.quality || 0) * 100).toFixed(1)}%`],
      ["Avg Cycle", Number.isFinite(p.average_cycle_s) ? `${p.average_cycle_s.toFixed(1)} s` : "—"],
    ];
    prod.innerHTML = metrics.map(([label, value]) => `<div class="report-metric"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("");
  }

  const alarmHistory = latestAlarms?.history || [];
  setText("reports-alarm-count", alarmHistory.length);
  const alarmEl = document.getElementById("reports-alarms");
  if (alarmEl) {
    alarmEl.innerHTML = alarmHistory.length ? `<table class="reports-table"><thead><tr><th>Time</th><th>Severity</th><th>Alarm</th><th>Event</th></tr></thead><tbody>${alarmHistory.slice(0, 150).map(a => `<tr><td>${escapeHtml(reportTime(a.timestamp))}</td><td>${escapeHtml((a.severity || "warning").toUpperCase())}</td><td>${escapeHtml(a.name || a.id || "")}</td><td>${escapeHtml(a.event || "")}</td></tr>`).join("")}</tbody></table>` : '<div class="reports-empty">No alarm history in this session.</div>';
  }

  const plcEvents = latestPlc?.event_log || [];
  const plcEl = document.getElementById("reports-plc-events");
  if (plcEl) {
    plcEl.innerHTML = plcEvents.length ? `<table class="reports-table"><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${plcEvents.slice(-100).reverse().map(e => `<tr><td>${escapeHtml(reportTime(e.timestamp || e.time))}</td><td>${escapeHtml(e.event || e.type || "PLC")}</td><td>${escapeHtml(e.message || e.detail || e.error || "")}</td></tr>`).join("")}</tbody></table>` : '<div class="reports-empty">No PLC events recorded.</div>';
  }

  const samples = latestTrends?.samples || [];
  const trendEl = document.getElementById("reports-trends");
  if (trendEl) {
    const names = latestTrends?.selected || [];
    trendEl.innerHTML = samples.length ? `<table class="reports-table"><thead><tr><th>Time</th>${names.map(n => `<th>${escapeHtml(n)}</th>`).join("")}</tr></thead><tbody>${samples.slice(-100).reverse().map(sample => `<tr><td>${escapeHtml(reportTime(sample.timestamp))}</td>${names.map(n => `<td>${sample.values?.[n] == null ? "—" : escapeHtml(Number(sample.values[n]).toFixed(3))}</td>`).join("")}</tr>`).join("")}</tbody></table>` : '<div class="reports-empty">No trend samples recorded. Start a trend in Simulation or Runtime to collect samples.</div>';
  }
}

function exportReportsCsv() {
  const rows = [["REPORT", currentProjectFilename || "Untitled"], ["SHIFT", latestProduction?.shift?.name || "Shift 1"], ["SHIFT START", reportTime(latestProduction?.shift?.started_at)], [], ["PRODUCTION", "VALUE"],
    ["Total", latestProduction?.total_count ?? 0], ["Good", latestProduction?.good_count ?? 0], ["Reject", latestProduction?.reject_count ?? 0],
    ["OEE", ((latestProduction?.oee || 0) * 100).toFixed(1) + "%"], ["Availability", ((latestProduction?.availability || 0) * 100).toFixed(1) + "%"],
    ["Performance", ((latestProduction?.performance || 0) * 100).toFixed(1) + "%"], ["Quality", ((latestProduction?.quality || 0) * 100).toFixed(1) + "%"], [],
    ["ALARM HISTORY", "", "", ""], ["Time", "Severity", "Alarm", "Event"],
    ...(latestAlarms?.history || []).map(a => [reportTime(a.timestamp), a.severity || "", a.name || a.id || "", a.event || ""]), [],
    ["PLC EVENTS", "", ""], ["Time", "Event", "Detail"],
    ...(latestPlc?.event_log || []).map(e => [reportTime(e.timestamp || e.time), e.event || e.type || "PLC", e.message || e.detail || e.error || ""]), []];
  const csv = rows.map(row => row.map(v => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `OMS_Report_${new Date().toISOString().replaceAll(':','-').slice(0,19)}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

document.getElementById("reports-btn")?.addEventListener("click", () => setReportsOpen(true));
document.getElementById("reports-close-btn")?.addEventListener("click", () => setReportsOpen(false));
document.getElementById("reports-export-btn")?.addEventListener("click", exportReportsCsv);
document.getElementById("reports-new-shift-btn")?.addEventListener("click", () => {
  const name = prompt("New shift name:", latestProduction?.shift?.name || "Shift 1");
  if (name === null) return;
  send({ action: "start_new_shift", name: name.trim() || "Shift 1" });
});
document.getElementById("reports-overlay")?.addEventListener("click", e => { if (e.target.id === "reports-overlay") setReportsOpen(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && reportsOpen) setReportsOpen(false); });

// ---------- Rendering ----------

function render(state) {
  // Remove graphical elements that no longer exist in the simulation.
  for (const [tagName, el] of Object.entries(elements)) {
    if (!state[tagName]) {
      el.remove();
      delete elements[tagName];

      selectedTags.delete(tagName);
      if (selectedTag === tagName) selectedTag = null;
      renderPropertyPanel();
    }
  }

  // Create/update components that exist in the simulation.
  for (const [tagName, obj] of Object.entries(state)) {
    const deps = {
      getOrCreate, selectComponent, isDesignMode, sendSetPoint, sendSetProperty,
      getLatestState: () => latestState,
      colors: PUSH_BUTTON_COLORS,
      lampOrder: TOWER_LIGHT_LAMP_ORDER,
      litColors: TOWER_LIGHT_LIT_COLORS,
      dimColors: TOWER_LIGHT_DIM_COLORS,
    };
    if (obj.type === "conveyor") renderConveyor(tagName, obj, deps);
    else if (obj.type === "cylinder") renderCylinder(tagName, obj, deps);
    else if (obj.type === "motor") renderMotor(tagName, obj, deps);
    else if (obj.type === "sensor") renderSensor(tagName, obj, deps);
    else if (obj.type === "push_button") renderPushButton(tagName, obj, deps);
    else if (obj.type === "emergency_push_button") renderEmergencyPushButton(tagName, obj, deps);
    else if (obj.type === "toggle_switch") renderToggleSwitch(tagName, obj, deps);
    else if (obj.type === "tower_light") renderTowerLight(tagName, obj, deps);
    else if (obj.type === "label") renderLabel(tagName, obj, deps);
  }

  renderComponentsList(state);
  renderConnectionLines();
  updateSelectedStatus();
}

let hierarchyRenderKey = null;
let draggedHierarchyTag = null;

function renderHierarchy() {
  const root = document.getElementById("engineering-hierarchy");
  if (!root) return;

  function nodeHtml(node, depth = 0) {
    const children = (node.children || []).map(child => nodeHtml(child, depth + 1)).join("");
    const selected = selectedTags.has(node.tag_name) ? " selected" : "";
    return `<div class="hierarchy-item ${selected}" data-tag="${escapeHtml(node.tag_name)}" draggable="${isDesignMode()}">
      <div role="button" tabindex="0" class="hierarchy-select" data-tag="${escapeHtml(node.tag_name)}" title="Select ${escapeHtml(node.tag_name)}">
        ${depth ? "└─ " : "▾ "}${escapeHtml(node.tag_name)}
      </div>
      ${children}
    </div>`;
  }

  root.innerHTML = latestHierarchy.length
    ? latestHierarchy.map(node => nodeHtml(node)).join("")
    : '<p class="empty">No components.</p>';

  root.querySelectorAll(".hierarchy-select").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectComponent(btn.dataset.tag);
    });
  });

  if (!isDesignMode()) return;

  root.querySelectorAll(".hierarchy-item").forEach(item => {
    item.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      draggedHierarchyTag = item.dataset.tag;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.dataset.tag);
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", (e) => {
      e.stopPropagation();
      draggedHierarchyTag = null;
      item.classList.remove("dragging");
    });
    item.addEventListener("dragover", (e) => {
      const child = draggedHierarchyTag;
      if (!child || child === item.dataset.tag || isHierarchyDescendant(child, item.dataset.tag)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      item.classList.add("drag-over");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove("drag-over");
      const child = draggedHierarchyTag;
      const parent = item.dataset.tag;
      if (!child || child === parent || isHierarchyDescendant(child, parent)) return;
      moveHierarchyItem(child, parent);
    });
  });
}

function hierarchyNodeContains(node, target) {
  if (!node) return false;
  for (const child of node.children || []) {
    if (child.tag_name === target || hierarchyNodeContains(child, target)) return true;
  }
  return false;
}

function findHierarchyNode(nodes, tag) {
  for (const node of nodes || []) {
    if (node.tag_name === tag) return node;
    const found = findHierarchyNode(node.children || [], tag);
    if (found) return found;
  }
  return null;
}

function isHierarchyDescendant(parentCandidate, target) {
  const candidate = findHierarchyNode(latestHierarchy || [], parentCandidate);
  return !!candidate && hierarchyNodeContains(candidate, target);
}

function moveHierarchyItem(child, parent) {
  if (!isDesignMode() || !latestState[child]) return;
  pushHistory();
  markDirty();
  send({ action: "set_parent", child, parent });
}

function renderConnections() {
  const list = document.getElementById("connection-list");
  if (!list) return;
  const connections = latestConnections || [];
  list.innerHTML = connections.length ? connections.map((c, index) => `
    <div class="mapping-card connection-card">
      <div>
        <b>${escapeHtml(c.source)} → ${escapeHtml(c.target)}</b>
        <small>${escapeHtml(c.kind || "process")}${c.label ? ` · ${escapeHtml(c.label)}` : ""}</small>
      </div>
      ${isDesignMode() ? `<button class="connection-delete" type="button" data-index="${index}">Delete</button>` : ""}
    </div>
  `).join("") : '<p class="empty">No engineering connections.</p>';

  list.querySelectorAll(".connection-delete").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!isDesignMode()) return;
      pushHistory();
      markDirty();
      send({ action: "remove_connection", index: Number(btn.dataset.index) });
    });
  });
}

function renderConnectionLines() {
  const svg = document.getElementById("connections-layer");
  if (!svg) return;
  svg.innerHTML = "";
  for (const connection of latestConnections || []) {
    const source = elements[connection.source];
    const target = elements[connection.target];
    if (!source || !target) continue;
    const sx = source.offsetLeft + source.offsetWidth / 2;
    const sy = source.offsetTop + source.offsetHeight / 2;
    const tx = target.offsetLeft + target.offsetWidth / 2;
    const ty = target.offsetTop + target.offsetHeight / 2;
    const midX = (sx + tx) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`);
    path.setAttribute("class", `connection-path connection-${connection.kind || "process"}`);
    svg.appendChild(path);
  }
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

function renderAlarms() {
  const list = document.getElementById("alarm-list");
  const history = document.getElementById("alarm-history");
  const count = document.getElementById("alarm-active-count");
  if (!list || !history) return;
  const definitions = latestAlarms.definitions || [];
  const activeById = new Map((latestAlarms.active || []).map(a => [a.id, a]));
  count.textContent = String(latestAlarms.active_count || 0);

  list.innerHTML = definitions.map((alarm, i) => {
    const live = activeById.get(alarm.id);
    return `<div class="mapping-card alarm-card ${live ? `alarm-${alarm.severity}` : ""}">
      <div class="alarm-head">
        <b>${alarm.name}</b>
        <span class="alarm-severity">${alarm.severity.toUpperCase()}</span>
        ${live ? `<span class="alarm-active">ACTIVE${live.acknowledged ? " · ACK" : ""}</span>` : `<span class="alarm-inactive">CLEAR</span>`}
      </div>
      <div class="alarm-fields">
        <input class="alarm-name" value="${alarm.name || ""}" placeholder="Alarm name">
        <select class="alarm-severity-select">
          <option value="info" ${alarm.severity === "info" ? "selected" : ""}>Info</option>
          <option value="warning" ${alarm.severity === "warning" ? "selected" : ""}>Warning</option>
          <option value="critical" ${alarm.severity === "critical" ? "selected" : ""}>Critical</option>
        </select>
        <label><input class="alarm-enabled" type="checkbox" ${alarm.enabled !== false ? "checked" : ""}> Enabled</label>
        <label><input class="alarm-latched" type="checkbox" ${alarm.latched ? "checked" : ""}> Latched</label>
      </div>
      <input class="alarm-expression" value='${(alarm.expression || "").replaceAll("'", "&#39;")}' placeholder='tag("Conveyor_1.fault") OR tag("EStop_1.pressed")'>
      <div class="alarm-actions">
        ${live ? `<button class="alarm-ack" type="button">Acknowledge</button>` : ""}
        <button class="alarm-save" type="button">Apply</button>
        <button class="alarm-delete" type="button">Delete</button>
        ${alarm.last_error ? `<em>${alarm.last_error}</em>` : ""}
      </div>
    </div>`;
  }).join("") || '<p class="empty">No alarms configured. Add one to monitor a tag condition.</p>';

  list.querySelectorAll(".alarm-card").forEach((card, i) => {
    const alarm = definitions[i];
    card.querySelector(".alarm-save")?.addEventListener("click", () => {
      alarm.name = card.querySelector(".alarm-name").value.trim() || alarm.id;
      alarm.severity = card.querySelector(".alarm-severity-select").value;
      alarm.enabled = card.querySelector(".alarm-enabled").checked;
      alarm.latched = card.querySelector(".alarm-latched").checked;
      alarm.expression = card.querySelector(".alarm-expression").value.trim();
      markDirty(); send({ action: "set_alarms", alarms: definitions });
    });
    card.querySelector(".alarm-delete")?.addEventListener("click", () => {
      latestAlarms.definitions = definitions.filter(a => a.id !== alarm.id);
      markDirty(); send({ action: "set_alarms", alarms: latestAlarms.definitions });
      renderAlarms();
    });
    card.querySelector(".alarm-ack")?.addEventListener("click", () => {
      send({ action: "alarm_ack", alarm_id: alarm.id });
    });
  });

  history.innerHTML = (latestAlarms.history || []).slice(0, 100).map(item =>
    `<div class="alarm-history-row"><span>${new Date(item.timestamp).toLocaleTimeString()}</span><b>${item.name}</b><span>${item.severity}</span><span>${item.event}</span></div>`
  ).join("") || '<p class="empty">No alarm events yet.</p>';
}


function numericTrendTags() {
  return [...latestTags]
    .filter(t => ["int", "integer", "float", "real", "number"].includes(String(t.datatype || "").toLowerCase()) && typeof t.value === "number" && !Number.isNaN(t.value))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sendTrendTags() {
  selectedTrendTags = new Set(trendRows.filter(Boolean));
  trendTagRenderKey = "";
  send({ action: "set_trend_tags", tags: [...selectedTrendTags] });
}

function renderTrends() {
  const list = document.getElementById("trend-tag-list");
  const chart = document.getElementById("trend-chart");
  const legend = document.getElementById("trend-legend");
  const empty = document.getElementById("trend-empty");
  if (!list || !chart || !legend || !empty) return;

  const running = latestTrends.running !== false;
  const startBtn = document.getElementById("trends-start-btn");
  const pauseBtn = document.getElementById("trends-pause-btn");
  if (startBtn) startBtn.disabled = running;
  if (pauseBtn) pauseBtn.disabled = !running;

  const iv = document.getElementById("trend-interval");
  const ivKey = String(latestTrends.interval_s ?? 1);
  if (iv && iv.dataset.serverValue !== ivKey) {
    iv.dataset.serverValue = ivKey;
    if (document.activeElement !== iv) iv.value = ivKey;
  }

  const available = numericTrendTags();

  // Sync the rows from the backend only when the backend selection changed
  // (reconnect, project load) and differs from what is shown locally.
  const backendSel = Array.isArray(latestTrends.selected) ? latestTrends.selected : [];
  const backendKey = backendSel.join("|");
  if (backendKey !== trendBackendKey) {
    trendBackendKey = backendKey;
    if (backendKey !== trendRows.filter(Boolean).join("|")) {
      trendRows = backendSel.length ? [...backendSel] : [""];
    }
  }
  selectedTrendTags = new Set(trendRows.filter(Boolean));

  const tagKey = available.map(t => t.name).join("|") + "#" + trendRows.join(",");
  if (tagKey !== trendTagRenderKey) {
    trendTagRenderKey = tagKey;

    if (!available.length) {
      list.innerHTML = '<p class="empty">No numeric tags are currently available.</p>';
    } else {
      const used = new Set(trendRows.filter(Boolean));
      list.innerHTML = trendRows.map((current, i) => {
        const opts = available
          .filter(t => t.name === current || !used.has(t.name))
          .map(t => `<option value="${escapeHtml(t.name)}" ${t.name === current ? "selected" : ""}>${escapeHtml(t.name)} (${escapeHtml(t.datatype)})</option>`)
          .join("");
        return `<div class="trend-select-row" data-index="${i}">
          <select class="trend-select"><option value="">Select tag…</option>${opts}</select>
          <button type="button" class="trend-row-remove" title="Remove">✕</button>
        </div>`;
      }).join("") + '<button type="button" id="trend-add-row" class="engineering-action">＋ Add tag</button>';

      list.querySelectorAll(".trend-select-row").forEach(rowEl => {
        const i = Number(rowEl.dataset.index);
        rowEl.querySelector(".trend-select").addEventListener("change", e => {
          trendRows[i] = e.target.value;
          sendTrendTags();
        });
        rowEl.querySelector(".trend-row-remove").addEventListener("click", () => {
          trendRows.splice(i, 1);
          if (!trendRows.length) trendRows = [""];
          sendTrendTags();
        });
      });
      document.getElementById("trend-add-row")?.addEventListener("click", () => {
        trendRows.push("");
        renderTrends();
      });
    }
  }

  renderTrendChart();
}

function renderTrendChart() {
  const chart = document.getElementById("trend-chart");
  const legend = document.getElementById("trend-legend");
  const empty = document.getElementById("trend-empty");
  if (!chart || !legend || !empty) return;

  const names = [...selectedTrendTags];
  const samples = latestTrends.samples || [];
  const width = chart.clientWidth || 720, height = chart.clientHeight || 300, left = 52, right = 18, top = 18, bottom = 34;
  const chartKey = `${width}x${height}|${names.join("|")}::${samples.length}:${samples.length ? samples[samples.length - 1].timestamp : 0}`;
  if (chartKey === trendChartRenderKey) return;
  trendChartRenderKey = chartKey;
  const plotW = width - left - right, plotH = height - top - bottom;
  chart.setAttribute("viewBox", `0 0 ${width} ${height}`);

  if (!names.length || !samples.length) {
    chart.innerHTML = `<rect class="trend-plot-bg" x="${left}" y="${top}" width="${plotW}" height="${plotH}" rx="6"></rect><text class="trend-chart-empty" x="${width/2}" y="${height/2}" text-anchor="middle">No trend samples yet</text>`;
    legend.innerHTML = "";
    empty.classList.toggle("hidden", names.length > 0);
    return;
  }
  empty.classList.add("hidden");

  const pointsByName = {};
  let min = Infinity, max = -Infinity;
  for (const name of names) {
    const pts = samples.map(s => ({ t: s.timestamp, v: s.values?.[name] })).filter(p => typeof p.v === "number" && Number.isFinite(p.v));
    pointsByName[name] = pts;
    for (const p of pts) { min = Math.min(min, p.v); max = Math.max(max, p.v); }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    chart.innerHTML = `<rect class="trend-plot-bg" x="${left}" y="${top}" width="${plotW}" height="${plotH}" rx="6"></rect><text class="trend-chart-empty" x="${width/2}" y="${height/2}" text-anchor="middle">Waiting for samples…</text>`;
    legend.innerHTML = "";
    return;
  }
  if (min === max) { min -= 1; max += 1; }
  const t0 = samples[0].timestamp, t1 = samples[samples.length - 1].timestamp || t0 + 1;
  const tx = t => left + ((t - t0) / Math.max(1e-9, t1 - t0)) * plotW;
  const ty = v => top + (1 - (v - min) / (max - min)) * plotH;
  const palette = ["#5aa9e6", "#e6a157", "#6bc48f", "#c47be8", "#e36b7a", "#a9b45a"];

  let html = `<rect class="trend-plot-bg" x="${left}" y="${top}" width="${plotW}" height="${plotH}" rx="6"></rect>`;
  for (let i = 0; i <= 4; i++) {
    const y = top + plotH * i / 4;
    const value = max - (max - min) * i / 4;
    html += `<line class="trend-grid" x1="${left}" y1="${y}" x2="${left+plotW}" y2="${y}"></line>`;
    html += `<text class="trend-axis" x="${left-8}" y="${y+4}" text-anchor="end">${Number(value).toFixed(1)}</text>`;
  }
  for (const [idx, name] of names.entries()) {
    const pts = pointsByName[name];
    if (!pts.length) continue;
    const color = palette[idx % palette.length];
    const d = pts.map((p, i) => `${i ? "L" : "M"}${tx(p.t).toFixed(1)},${ty(p.v).toFixed(1)}`).join(" ");
    html += `<path class="trend-line" d="${d}" stroke="${color}"></path>`;
  }
  html += `<text class="trend-axis" x="${left}" y="${height-8}">${new Date(t0*1000).toLocaleTimeString()}</text>`;
  html += `<text class="trend-axis" x="${left+plotW}" y="${height-8}" text-anchor="end">${new Date(t1*1000).toLocaleTimeString()}</text>`;
  chart.innerHTML = html;
  legend.innerHTML = names.map((name, idx) => `<span class="trend-legend-item"><i style="background:${palette[idx % palette.length]}"></i>${escapeHtml(name)}</span>`).join("");
}

document.getElementById("trends-clear-btn")?.addEventListener("click", () => {
  send({ action: "clear_trends" });
});

document.getElementById("trends-start-btn")?.addEventListener("click", () => send({ action: "set_trend_running", running: true }));
document.getElementById("trends-pause-btn")?.addEventListener("click", () => send({ action: "set_trend_running", running: false }));

document.getElementById("trend-interval")?.addEventListener("change", e => {
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v > 0) send({ action: "set_trend_interval", interval_s: v });
});

function toggleTrendBig(force) {
  const tab = document.getElementById("trends-tab");
  const btn = document.getElementById("trends-big-btn");
  if (!tab) return;
  const on = force !== undefined ? force : !tab.classList.contains("trend-big");
  tab.classList.toggle("trend-big", on);
  if (btn) btn.textContent = on ? "✕ Close" : "⛶ Enlarge";
  trendChartRenderKey = "";
  renderTrendChart();
}
document.getElementById("trends-big-btn")?.addEventListener("click", () => toggleTrendBig());
document.addEventListener("keydown", e => { if (e.key === "Escape") toggleTrendBig(false); });


function booleanProductionTags() {
  return latestTags.filter(t => String(t.datatype).toLowerCase() === "bool").sort((a, b) => a.name.localeCompare(b.name));
}

function renderProduction() {
  const tags = booleanProductionTags();
  const cfg = latestProduction.config || {};
  const selectIds = ["production-trigger", "production-reject-trigger", "production-running"];
  const values = [cfg.production_trigger || "", cfg.reject_trigger || "", cfg.running_tag || ""];
  for (let i = 0; i < selectIds.length; i++) {
    const el = document.getElementById(selectIds[i]);
    if (!el) continue;
    const key = tags.map(t => t.name).join("|") + "::" + values[i];
    if (el.dataset.renderKey !== key) {
      el.dataset.renderKey = key;
      el.innerHTML = `<option value="">${i === 0 ? "Select production trigger…" : "None"}</option>` + tags.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join("");
      el.value = values[i];
    }
  }
  const ideal = document.getElementById("production-ideal-cycle");
  const idealKey = String(cfg.ideal_cycle_s || "");
  if (ideal && ideal.dataset.serverValue !== idealKey) {
    ideal.dataset.serverValue = idealKey;
    if (document.activeElement !== ideal) ideal.value = idealKey;
  }

  setText("production-total", latestProduction.total_count ?? 0);
  setText("production-good", latestProduction.good_count ?? 0);
  setText("production-reject", latestProduction.reject_count ?? 0);
  setText("production-cycle", Number.isFinite(latestProduction.cycle_time_s) ? `${latestProduction.cycle_time_s.toFixed(1)} s` : "—");
  setText("production-availability", `${((latestProduction.availability || 0) * 100).toFixed(1)}%`);
  setText("production-performance", `${((latestProduction.performance || 0) * 100).toFixed(1)}%`);
  setText("production-quality", `${((latestProduction.quality || 0) * 100).toFixed(1)}%`);
  setText("production-oee", `${((latestProduction.oee || 0) * 100).toFixed(1)}%`);
}

document.getElementById("production-apply-btn")?.addEventListener("click", () => {
  if (!isDesignMode()) return;
  const config = {
    production_trigger: document.getElementById("production-trigger")?.value || "",
    reject_trigger: document.getElementById("production-reject-trigger")?.value || "",
    running_tag: document.getElementById("production-running")?.value || "",
    ideal_cycle_s: Number(document.getElementById("production-ideal-cycle")?.value || 0),
  };
  if (!config.production_trigger) {
    alert("Select a production trigger tag first.");
    return;
  }
  send({ action: "set_production_config", config });
  markDirty();
});

document.getElementById("production-reset-btn")?.addEventListener("click", () => {
  send({ action: "reset_production" });
});

function renderDiagnostics() {
  const summary = document.getElementById("diagnostics-summary");
  const list = document.getElementById("diagnostics-list");
  if (!summary || !list) return;
  if (!latestDiagnostics) {
    summary.className = "diagnostics-summary";
    summary.textContent = "Run Diagnostics to check this project.";
    list.innerHTML = "";
    return;
  }

  const counts = latestDiagnostics.counts || { error: 0, warning: 0, info: 0 };
  const total = counts.error + counts.warning + counts.info;
  summary.className = `diagnostics-summary ${counts.error ? "diag-error" : "diag-ok"}`;
  summary.innerHTML = counts.error
    ? `<b>${counts.error} error${counts.error === 1 ? "" : "s"}</b> · ${counts.warning} warning${counts.warning === 1 ? "" : "s"} · ${counts.info} info`
    : `<b>Project is valid</b> · ${counts.warning} warning${counts.warning === 1 ? "" : "s"} · ${counts.info} info`;

  if (!total) {
    list.innerHTML = '<div class="mapping-card diagnostic-card diag-info"><div class="diagnostic-message">No diagnostic issues found.</div></div>';
    return;
  }

  list.innerHTML = (latestDiagnostics.issues || []).map(issue => `
    <div class="mapping-card diagnostic-card diag-${escapeHtml(issue.level || "info")}">
      <div class="diagnostic-head">
        <span class="diagnostic-level">${escapeHtml(String(issue.level || "info").toUpperCase())}</span>
        <span class="diagnostic-category">${escapeHtml(issue.category || "General")}</span>
        ${issue.object_tag ? `<b>${escapeHtml(issue.object_tag)}</b>` : ""}
      </div>
      <div class="diagnostic-message">${escapeHtml(issue.message || "")}</div>
      ${issue.detail ? `<span class="diagnostic-detail">${escapeHtml(issue.detail)}</span>` : ""}
    </div>
  `).join("");
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
    li.classList.toggle("selected", selectedTags.has(tagName));

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
  selectComponent(li.getAttribute("data-tag"), e.ctrlKey);
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
  let origins = new Map();

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;

    const obj = latestState[tagName];
    if (!obj) return;

    // Ctrl+click toggles selection. Do not start a component drag for the
    // selection gesture until the pointer actually moves.
    if (e.ctrlKey) {
      selectComponent(tagName, true);
    } else if (!selectedTags.has(tagName)) {
      selectComponent(tagName);
    }
    el.dataset.selectionHandled = "true";

    origins = new Map();
    for (const tag of selectedTags) {
      const selectedObj = latestState[tag];
      if (selectedObj) {
        origins.set(tag, { x: selectedObj.x, y: selectedObj.y });
      }
    }

    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;

    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      if (!moved) {
        if (isDesignMode()) pushHistory();
        moved = true;
      }
    }

    if (!moved) return;

    for (const [tag, origin] of origins.entries()) {
      const obj = latestState[tag];
      const component = elements[tag];
      if (!obj || !component) continue;

      const newX = Math.round(origin.x + dx / simulationZoom);
      const newY = Math.round(origin.y + dy / simulationZoom);

      component.style.left = `${newX}px`;
      component.style.top = `${newY}px`;

      sendSetProperty(tag, "x", newX);
      sendSetProperty(tag, "y", newY);
    }

    if (isDesignMode()) markDirty();
  });

  el.addEventListener("pointerup", (e) => {
    if (!dragging) return;

    dragging = false;
    el.classList.remove("dragging");

    try { el.releasePointerCapture(e.pointerId); } catch (_) {}

    if (moved) {
      e.preventDefault();
      el.dataset.justDragged = "true";
      setTimeout(() => { delete el.dataset.justDragged; }, 0);
    }
  });

  el.addEventListener("pointercancel", () => {
    dragging = false;
    el.classList.remove("dragging");
  });
}

// ---------- Arrow-key nudging (Design mode only) ----------
// Moves every selected component by 1px, or 10px with Shift held.
// Ignored while the user is typing in a text field (property panel,
// name input, etc.) so arrow keys still work for cursor movement there.

const NUDGE_STEP = 1;
const NUDGE_STEP_FAST = 10;

document.addEventListener("keydown", (e) => {
  if (!isDesignMode() || selectedTags.size === 0) return;

  const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const dir = dirs[e.key];
  if (!dir) return;

  const active = document.activeElement;
  const tag = active && active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active && active.isContentEditable)) return;

  e.preventDefault();

  const step = e.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
  const [dx, dy] = [dir[0] * step, dir[1] * step];

  pushHistory();

  for (const t of selectedTags) {
    const obj = latestState[t];
    const component = elements[t];
    if (!obj || !component) continue;

    const newX = Math.round(obj.x + dx);
    const newY = Math.round(obj.y + dy);

    component.style.left = `${newX}px`;
    component.style.top = `${newY}px`;

    sendSetProperty(t, "x", newX);
    sendSetProperty(t, "y", newY);
  }

  markDirty();
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

      if (el.dataset.selectionHandled === "true") {
        delete el.dataset.selectionHandled;
      } else {
        selectComponent(tagName, e.ctrlKey);
      }

      // Component-specific click actions may call selectComponent() themselves;
      // suppress that secondary selection change for Ctrl+click.
      suppressSelection = e.ctrlKey;
      onClick();
      suppressSelection = false;
    });

    enableComponentDragging(el, tagName);

    canvas.appendChild(el);
    elements[tagName] = el;
  }

  return el;
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

document.getElementById("alarm-add-btn")?.addEventListener("click", () => {
  if (!isDesignMode()) return;
  const id = `alarm_${Date.now()}`;
  latestAlarms.definitions = [...(latestAlarms.definitions || []), {
    id, name: `Alarm ${latestAlarms.definitions.length + 1}`, severity: "warning",
    expression: "", description: "", enabled: true, latched: false,
  }];
  markDirty();
  send({ action: "set_alarms", alarms: latestAlarms.definitions });
  renderAlarms();
});

document.getElementById("alarm-reset-btn")?.addEventListener("click", () => {
  if (!isDesignMode()) return;
  send({ action: "alarm_reset" });
});

// ---------- Machine hierarchy / engineering connections ----------

document.getElementById("hierarchy-root-btn")?.addEventListener("click", () => {
  if (!isDesignMode() || !selectedTag) {
    alert("Select a component first.");
    return;
  }
  if (!latestState[selectedTag]) return;
  if (!latestState[selectedTag].parent_tag) {
    return;
  }
  pushHistory();
  markDirty();
  send({ action: "set_parent", child: selectedTag, parent: null });
});

const hierarchyRootDrop = document.getElementById("hierarchy-root-drop");
hierarchyRootDrop?.addEventListener("dragover", (e) => {
  if (!isDesignMode() || !e.dataTransfer.types.includes("text/plain")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  hierarchyRootDrop.classList.add("drag-over");
});
hierarchyRootDrop?.addEventListener("dragleave", () => hierarchyRootDrop.classList.remove("drag-over"));
hierarchyRootDrop?.addEventListener("drop", (e) => {
  e.preventDefault();
  hierarchyRootDrop.classList.remove("drag-over");
  if (!isDesignMode()) return;
  const child = draggedHierarchyTag;
  if (!child || !latestState[child] || !latestState[child].parent_tag) return;
  moveHierarchyItem(child, null);
});



document.getElementById("connection-add-btn")?.addEventListener("click", () => {
  if (!isDesignMode()) return;
  const names = Object.keys(latestState).sort();
  if (names.length < 2) {
    alert("Create at least two components first.");
    return;
  }
  const source = prompt(`Source component:\n${names.join("\n")}`);
  if (!source || !latestState[source]) return;
  const target = prompt(`Target component:\n${names.filter(n => n !== source).join("\n")}`);
  if (!target || !latestState[target] || target === source) return;
  const kind = (prompt("Connection type: process / control / signal / mechanical / safety", "process") || "process").trim().toLowerCase();
  if (!["process", "control", "signal", "mechanical", "safety"].includes(kind)) {
    alert("Invalid connection type.");
    return;
  }
  pushHistory();
  markDirty();
  send({ action: "add_connection", source, target, kind });
});

document.getElementById("connection-validate-btn")?.addEventListener("click", () => {
  send({ action: "validate_connections" });
});

document.getElementById("diagnostics-run-btn")?.addEventListener("click", () => {
  send({ action: "run_diagnostics" });
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

  send({ action: "plc_connect", backend, params });
});

document.getElementById("plc-disconnect-btn").addEventListener("click", () => {
  send({ action: "plc_disconnect" });
});

document.getElementById("plc-pause-btn").addEventListener("click", () => {
  const action = latestPlc.paused ? "plc_resume" : "plc_pause";
  send({ action });
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

  // Runtime requires a healthy live PLC. Keep the button genuinely
  // disabled when there is no connection (or communication has been
  // lost), so the UI cannot suggest that Runtime is available.
  const runtimeAvailable = !!plc.connected && plc.comms_healthy !== false;
  runtimeModeBtn.disabled = !runtimeAvailable;
  runtimeModeBtn.classList.toggle("unavailable", !runtimeAvailable);
  runtimeModeBtn.title = runtimeAvailable
    ? ""
    : "Connect to a PLC and wait for healthy communication before switching to Runtime.";

  // A PLC loss while already in Runtime is a safety boundary: leave
  // Runtime immediately instead of keeping a stale live-operation mode.
  if (isRuntimeMode() && !runtimeAvailable) {
    omsMode = "design";
    updateModeUI();
  }

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
  if (!el) return;
  const hints = plc.address_format_hints || {};

  if (plc.connected) {
    el.textContent = hints[plc.backend] || "Connected.";
  } else if (plc.backend) {
    el.textContent = `Not connected yet — format for ${plc.backend}: ${hints[plc.backend] || ""}`;
  } else {
    el.textContent = "PLC Node column: the expected address format depends on the connection ";
  }
}

// ---------- PLC monitor ----------

function renderPlcMonitor(plc, state) {
  const tbody = document.getElementById("monitor-tbody");
  if (!tbody) return;

  const filter = (document.getElementById("monitor-filter")?.value || "")
    .toLowerCase()
    .trim();

  const mappingByKey = {};
  for (const m of plc.mapping || []) {
    mappingByKey[`${m.object_tag}|${m.io_point}`] = m;
  }

  let total = 0;
  let visible = 0;
  tbody.innerHTML = "";

  for (const tag of Object.keys(state).sort()) {
    const obj = state[tag];
    if (!obj._io_points) continue;

    for (const point of Object.keys(obj._io_points).sort()) {
      const key = `${tag}|${point}`;
      const mapping = mappingByKey[key];
      if (!mapping) continue;

      const node = mapping.plc_node || "";
      if (!node) continue;

      total++;
      const direction = obj._io_points[point] ? "PLC → OMS" : "OMS → PLC";

      // Always show a value when the signal exists.  For PLC -> OMS,
      // obj[point] is the value that the PLC polling layer has already
      // applied to the live simulation object, so it is the most
      // reliable browser-side representation of what the simulation is
      // actually receiving.  Prefer the raw PLC cache when it is present,
      // then fall back to the mapped row and finally the live object.
      const rawValue = plc.values && Object.prototype.hasOwnProperty.call(plc.values, node)
        ? plc.values[node]
        : undefined;
      const value = rawValue !== undefined
        ? rawValue
        : (mapping.live_value_available ? mapping.live_value : obj[point]);
      const haystack = `${tag} ${point} ${node} ${direction} ${value ?? ""}`.toLowerCase();

      if (filter && !haystack.includes(filter)) continue;
      visible++;

      const card = document.createElement("div");
      card.className = "monitor-card";

      const objectCell = document.createElement("div");
      const objectName = document.createElement("div");
      objectName.className = "monitor-object";
      objectName.textContent = tag;
      const pointName = document.createElement("div");
      pointName.className = "monitor-point";
      pointName.textContent = point;
      objectCell.append(objectName, pointName);

      const nodeCell = document.createElement("div");
      nodeCell.className = "monitor-node";
      nodeCell.textContent = node;

      const directionCell = document.createElement("div");
      directionCell.className = "monitor-direction";
      directionCell.textContent = direction;

      const valueCell = document.createElement("div");
      valueCell.className = "monitor-value";
      valueCell.textContent = value === undefined ? "—" : String(value);

      card.append(objectCell, nodeCell, directionCell, valueCell);
      tbody.appendChild(card);
    }
  }

  const dot = document.getElementById("monitor-status-dot");
  const status = document.getElementById("monitor-status-text");
  const count = document.getElementById("monitor-signal-count");

  dot?.classList.toggle("connected", !!plc.connected);
  dot?.classList.toggle("unhealthy", !!plc.connected && !plc.comms_healthy);
  dot?.classList.toggle("paused", !!plc.connected && !!plc.paused);

  if (status) {
    status.textContent = !plc.connected
      ? "PLC not connected"
      : plc.paused
        ? `Connected (${plc.backend}) — Paused`
        : plc.comms_healthy
          ? `Connected (${plc.backend})`
          : `Connected (${plc.backend}) — comms lost`;
  }

  if (count) {
    count.textContent = filter
      ? `${visible} / ${total} signals`
      : `${total} signals`;
  }

  if (visible === 0) {
    const empty = document.createElement("div");
    empty.className = "monitor-empty";
    empty.textContent = total === 0
      ? "No mapped signals."
      : "No signals match the filter.";
    tbody.appendChild(empty);
  }
}

document.getElementById("monitor-filter")?.addEventListener("input", () => {
  renderPlcMonitor(latestPlc, latestState);
});

// ---------- PLC mapping table ----------

let mappingRowsKey = null;
let collapsedGroups = new Set();
let mappingCells = {}; // "tag|point" -> { nodeInput, liveCell }

function mappingIdentity(row) {
  // Must produce exactly the same key as mappingEntryKey() below, which is
  // built from the *saved* mapping entry's own fields (tag_name/point for
  // internal tags, object_tag/io_point for system tags). Using row.tag here
  // is wrong for system rows: row.tag is the tag registry's compound name
  // ("Conveyor_1.running"), not the bare object tag, so `${row.tag}|${row.point}`
  // never matched a saved entry's `${object_tag}|${io_point}` key -- every
  // system-tag address showed up blank in the Mapping tab even though it
  // was saved correctly (and visible in PLC Monitor, which doesn't go
  // through this lookup).
  return row.tag_name ? `${row.tag_name}|${row.point}` : `${row.object_tag}|${row.io_point}`;
}

function allMappingRows() {
  const rows = [];
  const knownKeys = new Set();

  // Build the normal catalog rows first.
  // Keep a key set because a saved project may contain a valid PLC mapping
  // before the browser has received the refreshed component-tag catalog.
  for (const tag of latestTags) {
    if (tag.system) {
      const row = {
        tag: tag.name,
        point: tag.io_point || "value",
        object_tag: tag.object_tag,
        io_point: tag.io_point,
        tag_name: null,
        isPlcToOms: tag.direction === "PLC -> OMS",
        datatype: tag.datatype,
        source: `${tag.object_tag}.${tag.io_point}`,
        internal: false,
      };
      rows.push(row);
      knownKeys.add(`${row.object_tag}|${row.io_point}`);
    } else {
      const row = {
        tag: tag.name,
        point: tag.object_tag && tag.io_point ? `${tag.object_tag}.${tag.io_point}` : "Internal",
        object_tag: tag.object_tag || null,
        io_point: tag.io_point || null,
        tag_name: tag.name,
        isPlcToOms: tag.direction === "PLC -> OMS" || tag.direction === "Internal",
        datatype: tag.datatype,
        source: tag.object_tag && tag.io_point ? `Connected to ${tag.object_tag}.${tag.io_point}` : "Internal tag",
        internal: true,
      };
      rows.push(row);
      knownKeys.add(row.tag_name ? `tag:${row.tag_name}` : `${row.object_tag}|${row.io_point}`);
    }
  }

  // IMPORTANT: the saved project mapping is authoritative for the Mapping
  // panel. If the component tag catalog is temporarily stale (for example
  // during project-load WebSocket message ordering), still render every
  // saved object/io mapping. This prevents sensor mappings from disappearing
  // even though they are present in the .oms file and in plc.mapping.
  for (const m of (latestPlc?.mapping || [])) {
    if (!m.object_tag || !m.io_point) continue;
    const key = `${m.object_tag}|${m.io_point}`;
    if (knownKeys.has(key)) continue;

    const signal = (latestPlc?.signals || []).find(s =>
      s.object_tag === m.object_tag && s.io_point === m.io_point
    );
    rows.push({
      tag: `${m.object_tag}.${m.io_point}`,
      point: m.io_point,
      object_tag: m.object_tag,
      io_point: m.io_point,
      tag_name: null,
      isPlcToOms: signal ? signal.direction === "PLC -> OMS" : true,
      datatype: signal?.datatype || "any",
      source: `${m.object_tag}.${m.io_point}`,
      internal: false,
    });
    knownKeys.add(key);
  }

  const g = r => r.object_tag || r.tag;
  return rows.sort((a, b) => `${g(a)}|${a.tag}.${a.point}`.localeCompare(`${g(b)}|${b.tag}.${b.point}`));
}

function renderMappingTable(plc, state) {
  const tbody = document.getElementById("mapping-tbody");
  const grouping = document.getElementById("mapping-group").checked;
  const rows = allMappingRows();
  // Fingerprint uses only static fields (identity + PLC node address).
  // Do NOT stringify plc.mapping: it contains live_value, which changes
  // with every tag update and would force a full rebuild (blinking list).
  const mapKey = (plc.mapping || [])
    .map(m => mappingEntryKey(m) + "=" + (m.plc_node || ""))
    .join(",");
  const key = grouping + "|" + rows.map(mappingIdentity).join(",") + "|" + mapKey;
  if (key !== mappingRowsKey) {
    mappingRowsKey = key;
    buildMappingRows(tbody, rows, plc.mapping || [], grouping);
  }

  for (const cells of Object.values(mappingCells)) {
    const row = cells.row;
    const tag = row.tag_name
      ? latestTags.find(t => t.name === row.tag_name)
      : latestTags.find(t => t.object_tag === row.object_tag && t.io_point === row.io_point);
    const value = tag ? tag.value : undefined;
    cells.liveCell.textContent = value === undefined ? "—" : String(value);
  }
  applyMappingFilter();
}

function mappingEntryKey(m) {
  return m.tag_name ? `${m.tag_name}|${m.point || "value"}` : `${m.object_tag}|${m.io_point}`;
}

function buildMappingRows(tbody, rows, mappingList, grouping) {
  const nodeByKey = {};
  for (const m of mappingList) nodeByKey[mappingEntryKey(m)] = m.plc_node;

  tbody.innerHTML = "";
  mappingCells = {};
  let lastTag = null;

  for (const row of rows) {
    const groupKey = row.object_tag || row.tag;

    if (grouping && groupKey !== lastTag) {
      const headerRow = document.createElement("div");
      headerRow.className = "mapping-group-header";
      headerRow.dataset.groupTag = groupKey;
      
      // Check if this group was previously collapsed
      const isCollapsed = collapsedGroups.has(groupKey);
      if (isCollapsed) {
        headerRow.classList.add("collapsed");
      }
      
      // Render the correct arrow indicator based on status
      headerRow.innerHTML = `<span class="group-arrow">${isCollapsed ? "▶" : "▼"}</span><span class="group-header-label">${escapeHtml(groupKey)}</span>`;
      
      headerRow.addEventListener("click", () => {
        const collapsed = headerRow.classList.toggle("collapsed");
        headerRow.querySelector(".group-arrow").textContent = collapsed ? "▶" : "▼";
        
        // Track the persistence state inside our Set
        if (collapsed) {
          collapsedGroups.add(groupKey);
        } else {
          collapsedGroups.delete(groupKey);
        }
        
        let sib = headerRow.nextElementSibling;
        while (sib && !sib.classList.contains("mapping-group-header")) {
          sib.style.display = collapsed ? "none" : "";
          sib = sib.nextElementSibling;
        }
        applyMappingFilter();
      });
      tbody.appendChild(headerRow);
      lastTag = groupKey;
    }

    const key = mappingIdentity(row);
    const nodeValue = nodeByKey[key] || "";
    const direction = row.internal
      ? (row.isPlcToOms && row.object_tag ? row.isPlcToOms ? "PLC → OMS" : "Internal" : "Internal")
      : (row.isPlcToOms ? "PLC → OMS" : "OMS → PLC");
    const tr = document.createElement("div");
    tr.className = "mapping-card";
    tr.dataset.groupTag = groupKey;
    tr.classList.toggle("unmapped-row", !nodeValue);
    const objectLabel = row.object_tag || groupKey;
    const pointLabel = row.point.startsWith(`${objectLabel}.`) ? row.point.slice(objectLabel.length + 1) : row.point;
    tr.innerHTML = `
      <div class="mapping-card-top" title="${escapeHtml(row.source)}">
        <span class="mapping-card-object">${escapeHtml(objectLabel)}</span>
        <span class="mapping-card-point">${escapeHtml(pointLabel)}</span>
        <span class="mapping-card-direction">${direction}</span>
      </div>
      <div class="node-input-wrap">
        <input type="text" class="node-input" placeholder="PLC address / node">
        <button type="button" class="browse-node-btn" title="Search parsed PLC addresses">⌕</button>
      </div>
      <span class="mapping-card-live" title="Live value"><span class="live-value">—</span></span>
      ${row.isPlcToOms ? '<span class="force-cell"><input type="text" class="force-input" placeholder="value"></span>' : '<span class="force-cell force-empty">—</span>'}`;

    const nodeInput = tr.querySelector(".node-input");
    nodeInput.value = nodeValue;
    nodeInput.addEventListener("input", () => tr.classList.toggle("unmapped-row", !nodeInput.value.trim()));
    nodeInput.addEventListener("keydown", e => { if (e.key === "Enter") applyAllMappings(); });
    nodeInput.addEventListener("blur", applyAllMappings);
    tr.querySelector(".browse-node-btn").addEventListener("click", () => openTagPicker(nodeInput));

    if (row.isPlcToOms) {
      const forceInput = tr.querySelector(".force-input");
      const applyForce = () => {
        const value = forceInput.value.trim();
        if (!value) return;
        if (row.internal) send({ action: "plc_force_tag", name: groupKey, value });
        else send({ action: "plc_force", tag_name: row.object_tag, io_point: row.io_point, value });
      };
      forceInput.addEventListener("keydown", e => { if (e.key === "Enter") applyForce(); });
    }
    tbody.appendChild(tr);
    mappingCells[key] = { nodeInput, liveCell: tr.querySelector(".live-value"), row };
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
  // Clear all saved group states so everything opens up
  collapsedGroups.clear();

  document.querySelectorAll("#mapping-tbody .mapping-group-header").forEach((headerRow) => {
    headerRow.classList.remove("collapsed");

    const arrow = headerRow.querySelector(".group-arrow");
    arrow.textContent = "▼";

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

    // Save every group's collapsed state to memory
    if (headerRow.dataset.groupTag) {
      collapsedGroups.add(headerRow.dataset.groupTag);
    }

    const arrow = headerRow.querySelector(".group-arrow");
    arrow.textContent = "▶";

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
  for (const cells of Object.values(mappingCells)) {
    const value = cells.nodeInput.value.trim();
    if (!value) continue;
    const row = cells.row;
    mappings.push(row.internal
      ? { tag_name: row.tag, point: row.point, object_tag: row.object_tag, io_point: row.io_point, plc_node: value }
      : { object_tag: row.object_tag, io_point: row.io_point, plc_node: value });
  }
  send({ action: "plc_set_mapping", mappings });
}

document.getElementById("mapping-validate-btn").addEventListener("click", () => {
  send({ action: "plc_validate" });
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

// ---------- DB tag import (TIA Portal "Generate source" paste-in) ----------
//
// Parsing/address-generation happens server-side (plc/s7_db_import.py)
// -- the result is cached here client-side only (not persisted to the
// project file) so the tag picker below has something to offer fully
// offline, for either backend.
let importedTags = { s7: [], opcua: [] };

const dbImportModal = document.getElementById("db-import-modal");

document.getElementById("mapping-import-db-btn").addEventListener("click", () => {
  document.getElementById("s7-import-error").textContent = "";
  document.getElementById("s7-import-preview-wrap").classList.add("hidden");
  document.getElementById("db-import-source").value = "text";
  pendingXlsxBase64 = null;
  document.getElementById("xlsx-import-filename").textContent = "No file chosen.";
  // Default the target to whatever backend is currently selected, so
  // the common case (matches the PLC Connection panel) needs no extra click.
  const backend = document.getElementById("plc-backend-select").value;
  document.getElementById("db-import-target").value =
    (backend === "asyncua" || backend === "opcua") ? "opcua" : "s7";
  updateDbImportFieldsVisibility();
  dbImportModal.classList.remove("hidden");
});

document.getElementById("db-import-close").addEventListener("click", () => {
  dbImportModal.classList.add("hidden");
});

document.getElementById("db-import-target").addEventListener("change", updateDbImportFieldsVisibility);
document.getElementById("db-import-source").addEventListener("change", updateDbImportFieldsVisibility);

// Dropping a .db source file directly onto the textarea reads its text
// in-place, instead of letting the browser's default action navigate
// away to open the file.
const s7ImportTextarea = document.getElementById("s7-import-text");

s7ImportTextarea.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

s7ImportTextarea.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    s7ImportTextarea.value = reader.result;
  };
  reader.onerror = () => {
    alert("Could not read the dropped file.");
  };
  reader.readAsText(file);
});

// "Choose File" opens a native file picker. What it reads into
// depends on the Source dropdown: DB source text goes straight into
// the textarea; an .xlsx tag table is read as binary and base64-
// encoded for the backend (openpyxl) to parse -- see pendingXlsxBase64.
const s7ImportFileInput = document.getElementById("s7-import-file-input");
let pendingXlsxBase64 = null;

document.getElementById("s7-import-browse-btn").addEventListener("click", () => {
  s7ImportFileInput.click();
});

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

s7ImportFileInput.addEventListener("change", () => {
  const file = s7ImportFileInput.files && s7ImportFileInput.files[0];
  if (!file) return;

  const isXlsx = document.getElementById("db-import-source").value === "xlsx";
  const reader = new FileReader();

  if (isXlsx) {
    reader.onload = () => {
      pendingXlsxBase64 = arrayBufferToBase64(reader.result);
      document.getElementById("xlsx-import-filename").textContent = `Selected: ${file.name}`;
    };
    reader.onerror = () => {
      alert("Could not read the selected file.");
    };
    reader.readAsArrayBuffer(file);
  } else {
    reader.onload = () => {
      s7ImportTextarea.value = reader.result;
    };
    reader.onerror = () => {
      alert("Could not read the selected file.");
    };
    reader.readAsText(file);
  }

  s7ImportFileInput.value = ""; // allow re-selecting the same file later
});

function updateDbImportFieldsVisibility() {
  const target = document.getElementById("db-import-target").value;
  const source = document.getElementById("db-import-source").value;
  const isXlsx = source === "xlsx";

  // DB number only means anything for the DB-source-text path -- a
  // tag table's Logical Address is already a complete I/Q/M address.
  document.getElementById("db-import-s7-fields").classList.toggle("hidden", target !== "s7" || isXlsx);
  document.getElementById("db-import-opcua-fields").classList.toggle("hidden", target !== "opcua");

  document.getElementById("db-import-text-fields").classList.toggle("hidden", isXlsx);
  document.getElementById("db-import-xlsx-fields").classList.toggle("hidden", !isXlsx);

  s7ImportFileInput.accept = isXlsx ? ".xlsx" : ".db,.awl,.txt";
}

document.getElementById("s7-import-parse-btn").addEventListener("click", () => {
  const target = document.getElementById("db-import-target").value;
  const source = document.getElementById("db-import-source").value;

  if (source === "xlsx") {
    if (!pendingXlsxBase64) {
      document.getElementById("s7-import-error").textContent = "Choose an .xlsx file first.";
      document.getElementById("s7-import-preview-wrap").classList.add("hidden");
      return;
    }
    const payload = { action: "plc_import_db_tags", target, source: "xlsx", xlsx_base64: pendingXlsxBase64 };
    if (target === "opcua") {
      const ns = document.getElementById("opcua-import-namespace").value.trim();
      const dbName = document.getElementById("opcua-import-dbname").value.trim();
      if (ns) payload.namespace = parseInt(ns, 10);
      if (dbName) payload.db_name = dbName;
    }
    send(payload);
    return;
  }

  const text = document.getElementById("s7-import-text").value;
  const payload = { action: "plc_import_db_tags", target, source: "text", text };

  if (target === "opcua") {
    const ns = document.getElementById("opcua-import-namespace").value.trim();
    const dbName = document.getElementById("opcua-import-dbname").value.trim();
    if (ns) payload.namespace = parseInt(ns, 10);
    if (dbName) payload.db_name = dbName;
  } else {
    const dbNumRaw = document.getElementById("s7-import-dbnum").value.trim();
    if (dbNumRaw) payload.db_number = parseInt(dbNumRaw, 10);
  }

  send(payload);
});

let _pendingImportTags = [];
let _pendingImportTarget = "s7";

function handleDbImportResult(result) {
  const errorEl = document.getElementById("s7-import-error");
  const previewWrap = document.getElementById("s7-import-preview-wrap");

  if (result.error) {
    errorEl.textContent = result.error;
    previewWrap.classList.add("hidden");
    return;
  }

  errorEl.textContent = (result.warnings || []).join(" ");
  _pendingImportTags = result.tags || [];
  _pendingImportTarget = result.target || "s7";

  document.getElementById("s7-import-summary").textContent =
    `${_pendingImportTags.length} addressable tag(s) found.`;

  const tbody = document.getElementById("s7-import-preview-tbody");
  tbody.innerHTML = "";
  for (const tag of _pendingImportTags) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${tag.name}</td><td>${tag.dtype}</td><td>${tag.address}</td>`;
    tbody.appendChild(tr);
  }
  previewWrap.classList.toggle("hidden", _pendingImportTags.length === 0);
}

document.getElementById("s7-import-use-btn").addEventListener("click", () => {
  importedTags[_pendingImportTarget] = _pendingImportTags;
  dbImportModal.classList.add("hidden");

  // The picker (openTagPicker) decides s7 vs. opcua from the main PLC
  // Connection panel's Backend dropdown, not from this modal's Target
  // dropdown -- the two are independent, so importing tags for a
  // target that doesn't match the main dropdown would silently leave
  // the picker looking at the wrong (empty) bucket. Keep them in sync
  // on import so "Use These Tags" always makes the ⌕ button work with
  // what was just imported, without overriding an already-matching
  // choice (e.g. don't stomp "opcua" with "asyncua" if that's what's
  // already selected).
  const target = _pendingImportTarget;
  const currentBackend = backendSelect.value;
  const needsSync = target === "s7"
    ? currentBackend !== "s7"
    : !["asyncua", "opcua"].includes(currentBackend);
  if (needsSync) {
    backendSelect.value = target === "s7" ? "s7" : "asyncua";
    backendSelect.dispatchEvent(new Event("change"));
  }
});

// ---------- PLC tag / node picker ----------
//
// One modal serves three sources: the imported S7 tag list, the
// imported (offline, best-effort) OPC UA tag list, and a live OPC UA
// browse of the connected server's node tree. Which one opens depends
// on the currently selected backend and, for OPC UA, whether there's
// a live connection right now -- offline import always works; live
// Browse is offered as well whenever it's actually available.
const tagPickerModal = document.getElementById("tag-picker-modal");
let tagPickerTargetInput = null;
let tagPickerMode = null;          // "s7" | "opcua-offline" | "opcua-live"
let opcuaBreadcrumb = [];          // [{name, node_id}, ...]

function openTagPicker(nodeInput) {
  tagPickerTargetInput = nodeInput;
  // Prefer the server's last-connected backend once one is known (it
  // reflects reality, including a live connection for OPC UA); before
  // any connect attempt has happened, fall back to whatever's chosen
  // in the Backend dropdown -- offline tag picking doesn't need a
  // live connection at all, so there's no reason to force one just
  // to open the picker.
  const backend = document.getElementById("plc-backend-select").value;

  if (backend === "s7") {
    tagPickerMode = "s7";
    document.getElementById("tag-picker-title").textContent = "Select S7 Tag";
    document.getElementById("tag-picker-breadcrumb").classList.add("hidden");
    document.getElementById("tag-picker-filter").value = "";
    renderOfflineTagPickerList("");
    tagPickerModal.classList.remove("hidden");
    document.getElementById("tag-picker-filter").focus();
  } else if (backend === "asyncua" || backend === "opcua") {
    document.getElementById("tag-picker-filter").value = "";
    if (latestPlc.connected && importedTags.opcua.length === 0) {
      // Live browse -- always the most accurate source when it's available.
      tagPickerMode = "opcua-live";
      document.getElementById("tag-picker-title").textContent = "Browse OPC UA Server (live)";
      opcuaBreadcrumb = [{ name: "Objects", node_id: null }];
      tagPickerModal.classList.remove("hidden");
      requestOpcuaBrowse(null);
    } else {
      // Not connected -- fall back to the offline, imported-from-DB-text list.
      tagPickerMode = "opcua-offline";
      document.getElementById("tag-picker-title").textContent = "Select OPC UA Tag (offline, from import)";
      document.getElementById("tag-picker-breadcrumb").classList.add("hidden");
      renderOfflineTagPickerList("");
      tagPickerModal.classList.remove("hidden");
      document.getElementById("tag-picker-filter").focus();
    }
  } else {
    alert("Select a connection type in the PLC Connection panel first.");
  }
}

document.getElementById("tag-picker-close").addEventListener("click", () => {
  tagPickerModal.classList.add("hidden");
});

document.getElementById("tag-picker-filter").addEventListener("input", (e) => {
  if (tagPickerMode === "s7" || tagPickerMode === "opcua-offline") {
    renderOfflineTagPickerList(e.target.value.trim().toLowerCase());
  } else if (tagPickerMode === "opcua-live") {
    requestOpcuaBrowse(opcuaBreadcrumb[opcuaBreadcrumb.length - 1].node_id);
  }
});

function pickTagAddress(address) {
  if (!tagPickerTargetInput) return;
  tagPickerTargetInput.value = address;
  tagPickerTargetInput.dispatchEvent(new Event("input"));
  applyAllMappings();
  tagPickerModal.classList.add("hidden");
}

function renderOfflineTagPickerList(filterText) {
  const list = document.getElementById("tag-picker-list");
  const empty = document.getElementById("tag-picker-empty");
  list.innerHTML = "";

  const key = tagPickerMode === "s7" ? "s7" : "opcua";
  const tags = importedTags[key];

  if (tags.length === 0) {
    empty.textContent = 'No tags imported yet -- use "Import DB Tags..." below the mapping table first.';
    empty.classList.remove("hidden");
    return;
  }

  const matches = tags.filter((t) =>
    !filterText ||
    t.name.toLowerCase().includes(filterText) ||
    t.address.toLowerCase().includes(filterText)
  );

  empty.classList.toggle("hidden", matches.length > 0);
  empty.textContent = "No tags match that search.";

  for (const tag of matches) {
    const row = document.createElement("div");
    row.className = "tag-picker-row";
    row.innerHTML = `<span class="tag-picker-name">${tag.name}</span>
      <span class="tag-picker-type">${tag.dtype}</span>
      <span class="tag-picker-address">${tag.address}</span>`;
    row.addEventListener("click", () => pickTagAddress(tag.address));
    list.appendChild(row);
  }
}

function requestOpcuaBrowse(nodeId) {
  send({ action: "plc_browse_opcua", node_id: nodeId });
}

function handleOpcuaBrowseResult(result) {
  const list = document.getElementById("tag-picker-list");
  const empty = document.getElementById("tag-picker-empty");

  if (result.error) {
    list.innerHTML = "";
    empty.textContent = result.error;
    empty.classList.remove("hidden");
    return;
  }

  renderOpcuaBreadcrumb();

  const filterText = document.getElementById("tag-picker-filter").value.trim().toLowerCase();
  const children = (result.children || []).filter((c) =>
    !filterText || c.name.toLowerCase().includes(filterText)
  );

  list.innerHTML = "";
  empty.classList.toggle("hidden", children.length > 0);
  empty.textContent = "No child nodes here.";

  for (const child of children) {
    const row = document.createElement("div");
    row.className = "tag-picker-row";
    row.innerHTML = `<span class="tag-picker-name">${child.is_variable ? "🔧" : "📁"} ${child.name}</span>
      <span class="tag-picker-type">${child.node_class}</span>`;
    row.addEventListener("click", () => {
      if (child.is_variable) {
        pickTagAddress(child.node_id);
      } else {
        opcuaBreadcrumb.push({ name: child.name, node_id: child.node_id });
        requestOpcuaBrowse(child.node_id);
      }
    });
    list.appendChild(row);
  }
}

function renderOpcuaBreadcrumb() {
  const el = document.getElementById("tag-picker-breadcrumb");
  el.classList.remove("hidden");
  el.innerHTML = "";
  opcuaBreadcrumb.forEach((crumb, i) => {
    const span = document.createElement("span");
    span.className = "breadcrumb-crumb";
    span.textContent = crumb.name;
    if (i < opcuaBreadcrumb.length - 1) {
      span.addEventListener("click", () => {
        opcuaBreadcrumb = opcuaBreadcrumb.slice(0, i + 1);
        requestOpcuaBrowse(crumb.node_id);
      });
    } else {
      span.classList.add("current");
    }
    el.appendChild(span);
    if (i < opcuaBreadcrumb.length - 1) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = "›";
      el.appendChild(sep);
    }
  });
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

// ---------- Ctrl+drag multi-selection marquee ----------

function createSelectionMarquee(e) {
  const rect = canvasViewport.getBoundingClientRect();
  selectionMarquee = document.createElement("div");
  selectionMarquee.className = "selection-marquee";
  selectionMarquee.style.left = `${e.clientX - rect.left}px`;
  selectionMarquee.style.top = `${e.clientY - rect.top}px`;
  selectionMarquee.style.width = "0px";
  selectionMarquee.style.height = "0px";
  canvasViewport.appendChild(selectionMarquee);

  marqueeStartX = e.clientX;
  marqueeStartY = e.clientY;
  marqueeAdditive = true;
}

function updateSelectionMarquee(e) {
  if (!selectionMarquee) return;

  const rect = canvasViewport.getBoundingClientRect();
  const x1 = marqueeStartX - rect.left;
  const y1 = marqueeStartY - rect.top;
  const x2 = e.clientX - rect.left;
  const y2 = e.clientY - rect.top;

  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  selectionMarquee.style.left = `${left}px`;
  selectionMarquee.style.top = `${top}px`;
  selectionMarquee.style.width = `${width}px`;
  selectionMarquee.style.height = `${height}px`;
}

function finishSelectionMarquee(e) {
  if (!selectionMarquee) return;

  const box = selectionMarquee.getBoundingClientRect();
  const selected = new Set(selectedTags);

  // A Ctrl-drag is additive: every component touched by the marquee is
  // added to the current selection. Normal empty-area dragging remains pan.
  for (const [tagName, el] of Object.entries(elements)) {
    const componentBox = el.getBoundingClientRect();
    const intersects =
      componentBox.right >= box.left &&
      componentBox.left <= box.right &&
      componentBox.bottom >= box.top &&
      componentBox.top <= box.bottom;

    if (intersects) selected.add(tagName);
  }

  selectionMarquee.remove();
  selectionMarquee = null;

  selectedTags = selected;
  selectedTag = selectedTags.size === 1 ? [...selectedTags][0] : null;

  for (const [tag, el] of Object.entries(elements)) {
    el.classList.toggle("selected", selectedTags.has(tag));
  }

  renderPropertyPanel();
  renderComponentsList(latestState);
}

function cancelSelectionMarquee(e) {
  if (!selectionMarquee) return;
  selectionMarquee.remove();
  selectionMarquee = null;
}

// ---------- Simulation: pan view by dragging empty area ----------

canvasViewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;

  // Ctrl + left-drag on empty simulation space starts a selection marquee.
  // This takes precedence over panning, while Ctrl + click on a component
  // continues to toggle that individual component.
  if (e.ctrlKey && !e.target.closest(".component")) {
    createSelectionMarquee(e);
    canvasViewport.setPointerCapture(e.pointerId);
    canvasViewport.style.cursor = "crosshair";
    return;
  }

  // Clicking empty simulation space clears the current selection.
  // Keep panning behavior unchanged: the same drag can still pan the view.
  if (e.target.closest(".component")) return;
  selectedTags.clear();
  selectedTag = null;
  for (const el of Object.values(elements)) {
    el.classList.remove("selected");
  }
  renderPropertyPanel();
  renderComponentsList(latestState);

  panning = true;

  panStartX = e.clientX;
  panStartY = e.clientY;

  panOriginX = simulationPanX;
  panOriginY = simulationPanY;

  canvasViewport.setPointerCapture(e.pointerId);
  canvasViewport.style.cursor = "grabbing";
});

canvasViewport.addEventListener("pointermove", (e) => {
  if (selectionMarquee) {
    updateSelectionMarquee(e);
    return;
  }

  if (!panning) return;

  const dx = e.clientX - panStartX;
  const dy = e.clientY - panStartY;

  simulationPanX = panOriginX + dx;
  simulationPanY = panOriginY + dy;

  applySimulationTransform();
});

function stopSimulationPanning(e) {
  if (selectionMarquee) {
    finishSelectionMarquee(e);
    try {
      canvasViewport.releasePointerCapture(e.pointerId);
    } catch (_) {}
    canvasViewport.style.cursor = "grab";
    return;
  }

  if (!panning) return;

  panning = false;

  try {
    canvasViewport.releasePointerCapture(e.pointerId);
  } catch (_) {}

  canvasViewport.style.cursor = "grab";
}

function cancelSimulationInteraction(e) {
  if (selectionMarquee) {
    cancelSelectionMarquee(e);
    try {
      canvasViewport.releasePointerCapture(e.pointerId);
    } catch (_) {}
    canvasViewport.style.cursor = "grab";
  }
  if (panning) {
    panning = false;
    try {
      canvasViewport.releasePointerCapture(e.pointerId);
    } catch (_) {}
    canvasViewport.style.cursor = "grab";
  }
}

canvasViewport.addEventListener("pointerup", stopSimulationPanning);
canvasViewport.addEventListener("pointercancel", cancelSimulationInteraction);

canvasViewport.style.cursor = "grab";

applySimulationTransform();

window.addEventListener("beforeunload", (e) => {
  if (!projectDirty) return;
  e.preventDefault();
  e.returnValue = "";
});
updateRecoveryUI();
