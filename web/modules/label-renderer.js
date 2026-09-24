// Visual-only annotation -- no PLC points, no click-to-toggle behavior.
// Text/font/color are all driven by the Properties panel.
export function renderLabel(tagName, l, { getOrCreate, selectComponent }) {
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
