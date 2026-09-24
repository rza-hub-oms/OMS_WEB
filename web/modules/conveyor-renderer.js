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
  // Keep each DOM box element bound to the SAME physical box between
  // renders. Boxes can vanish from the head (belt end) OR the middle
  // (a cylinder deletes one), and new ones spawn at the tail, so
  // matching by index would hand a removed box's element to its
  // neighbour and make the neighbours visibly slide back. Instead, walk
  // the previous and new lists in order and pair a box with its previous
  // self when it moved only a small step along the belt's direction.
  const dir = c.direction_forward ? 1 : -1;
  const maxStep = Math.max(2, c.box_width / 2);
  const prev = el._boxState || [];          // [{pos, node}]
  const next = [];
  let pi = 0;
  for (const rawPos of positions) {
    let match = -1;
    for (let k = pi; k < prev.length; k++) {
      const delta = (rawPos - prev[k].pos) * dir;
      if (delta >= -0.01 && delta <= maxStep) { match = k; break; }
    }
    if (match >= 0) {
      for (let k = pi; k < match; k++) prev[k].node.remove();   // vanished
      next.push({ pos: rawPos, node: prev[match].node });
      pi = match + 1;
    } else {
      const node = document.createElement("div");                // newly spawned
      node.className = "box-ui";
      el.insertBefore(node, tagEl);
      next.push({ pos: rawPos, node });
    }
  }
  for (let k = pi; k < prev.length; k++) prev[k].node.remove();  // vanished at tail
  el._boxState = next;

  next.forEach(({ pos: rawPos, node: box }) => {
    const pos = Math.min(rawPos, travel);
    box.style.left = `${pos}px`;
    box.style.top = `${(c.height - boxHeight) / 2}px`;
    box.style.width = `${c.box_width}px`;
    box.style.height = `${boxHeight}px`;
  });

  tagEl.textContent = `${tagName}  running=${c.running}  speed=${c.speed}`;

}
