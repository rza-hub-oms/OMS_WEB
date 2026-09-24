// Latching, unlike push_button: one click presses it (and latches the
// freeze -- see Scene.is_emergency_stopped()), the next click releases
// it. Ported from EmergencyPushButtonItem.mousePressEvent, whose
// mouseReleaseEvent is commented out there too.
export function renderEmergencyPushButton(tagName, b, { getOrCreate, selectComponent, sendSetProperty, getLatestState }) {
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
        const isPressed = !!getLatestState()?.[tagName]?.pressed;
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
