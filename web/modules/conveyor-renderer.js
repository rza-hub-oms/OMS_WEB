// Conveyor renderer: visual state is driven entirely by the backend simulation.
export function renderConveyor(tagName, c, { getOrCreate, selectComponent, isDesignMode, sendSetPoint, getLatestState }) {

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
      sendSetPoint(tagName, "running", getLatestState()?.[tagName]?.running ? 0 : 1);
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
  // Belt direction is rendered from the backend simulation phase.
  // There is deliberately no independent CSS animation: boxes, belt
  // markings, and direction therefore share one source of truth.
  el.style.setProperty("--belt-phase", `${c.belt_phase || 0}px`);

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
