export function renderSensor(tagName, s, { getOrCreate, selectComponent }) {
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
