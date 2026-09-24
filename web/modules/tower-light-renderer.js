// Each lamp is independently clickable -- unlike push_button/
// emergency_push_button/toggle_switch, red/blue/green/yellow are
// PLC-writable points (setters exist), so clicks go through
// sendSetPoint (-> apply_command), same as conveyor/cylinder, not
// sendSetProperty.
export function renderTowerLight(tagName, tl, { getOrCreate, selectComponent, lampOrder, litColors, dimColors }) {
  const el = getOrCreate(
    tagName,
    "tower-ui",
    (container) => {
      for (const color of lampOrder) {
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

  for (const color of lampOrder) {
    const lamp = el.querySelector(`.tower-lamp[data-color="${color}"]`);
    const lit = !!tl[color];
    lamp.classList.toggle("lit", lit);
    lamp.style.setProperty(
      "--lamp-color",
      lit ? litColors[color] : dimColors[color]
    );
  }

  el.querySelector(".tag").textContent =
    `${tagName}  ${lampOrder.map((c) => `${c}=${tl[c]}`).join(" ")}`;
}
