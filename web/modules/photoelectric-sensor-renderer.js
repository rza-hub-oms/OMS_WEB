export function renderPhotoelectricSensor(tagName, s, { getOrCreate, selectComponent }) {
  const el = getOrCreate(tagName, "photoelectric-sensor-ui", (container) => {
    container.innerHTML = `
      <div class="photoelectric-beam" aria-hidden="true"></div>
      <div class="photoelectric-body">
        <div class="photoelectric-lens"></div>
        <div class="sensor-led"></div>
      </div>
      <div class="tag"></div>
    `;
    selectComponent(tagName);
  }, () => selectComponent(tagName));
  const width = Number(s.width) || 0;
  const height = Number(s.height) || 0;
  const rotation = Number(s.rotation) || 0;
  const angle = rotation * Math.PI / 180;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const half = Math.min(
    Math.abs(dx) > 1e-9 ? width / 2 / Math.abs(dx) : Infinity,
    Math.abs(dy) > 1e-9 ? height / 2 / Math.abs(dy) : Infinity,
  );
  Object.assign(el.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${width}px`, height: `${height}px`, zIndex: s.layer || 0 });
  el.style.setProperty("--sensor-rotation", `${rotation}deg`);
  const beam = el.querySelector(".photoelectric-beam");
  beam.style.left = `${width / 2 + dx * half}px`;
  beam.style.top = `${height / 2 + dy * half}px`;
  beam.style.width = `${Math.max(0, Number(s.detection_distance) || 0)}px`;
  beam.style.transform = `rotate(${rotation}deg)`;
  el.classList.toggle("detected", !!s.detected);
  el.querySelector(".tag").textContent = `${tagName}  detected=${s.detected}`;
}
