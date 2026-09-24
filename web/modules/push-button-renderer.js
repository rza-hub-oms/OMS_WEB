// A momentary control: pressed must follow the mouse being held down,
// not a click-to-toggle like conveyor/cylinder/motor. So it's sent via
// "set_property" (-> Scene.apply_property -> set_pressed()), not
// "set_point" (-> apply_command, restricted to PLC-writable points) --
// a real pushbutton's state is operator input, never written by the PLC.
// pointer capture (from enableComponentDragging) means pointerup still
// fires on this element even if the mouse is released after moving off it.
export function renderPushButton(tagName, b, { getOrCreate, selectComponent, sendSetProperty, getLatestState, colors }) {
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
        if (getLatestState()?.[tagName]?.pressed) sendSetProperty(tagName, "pressed", 0);
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
  el.style.setProperty("--btn-color", colors[b.color] || colors.Red);

  el.classList.toggle("pressed", !!b.pressed);

  el.querySelector(".tag").textContent = `${tagName}  pressed=${b.pressed}`;
}
