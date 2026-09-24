// Click (press+release without a drag) flips the state -- getOrCreate's
// own "click" listener already ignores clicks that followed a drag
// (el.dataset.justDragged), so ToggleSwitchItem's move-vs-click check
// doesn't need to be reimplemented here.
export function renderToggleSwitch(tagName, t, { getOrCreate, selectComponent, sendSetProperty, getLatestState }) {
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
      const isOn = !!getLatestState()?.[tagName]?.on;
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
