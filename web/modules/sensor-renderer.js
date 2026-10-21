export function renderSensor(tagName, s, { getOrCreate, selectComponent }) {
  const el = getOrCreate(tagName, "inductive-sensor-ui", (container) => {
    container.innerHTML = `
      <div class="inductive-range" aria-hidden="true"></div>
      <div class="inductive-sensor-body">
        <div class="inductive-sensor-face"></div>
        <div class="sensor-led"></div>
      </div>
      <div class="tag"></div>
    `;
    selectComponent(tagName);
  }, () => selectComponent(tagName));
  el.style.left = `${s.x}px`;
  el.style.top = `${s.y}px`;
  el.style.width = `${s.width}px`;
  el.style.height = `${s.height}px`;
  el.style.zIndex = s.layer || 0;
  el.style.setProperty("--sensor-rotation", `${Number(s.rotation) || 0}deg`);
  const range = Math.max(0, Number(s.detection_distance) || 0);
  const rangeEl = el.querySelector(".inductive-range");
  rangeEl.style.width = `${range * 2}px`;
  rangeEl.style.height = `${range * 2}px`;
  rangeEl.style.left = `${(Number(s.width) || 0) / 2 - range}px`;
  rangeEl.style.top = `${(Number(s.height) || 0) / 2 - range}px`;
  el.classList.toggle("detected", !!s.detected);
  el.querySelector(".tag").textContent = `${tagName}  detected=${s.detected}`;
}
