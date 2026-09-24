export function renderMotor(tagName, c, { getOrCreate, selectComponent, isDesignMode, sendSetPoint, getLatestState }) {
  const el = getOrCreate(
    tagName,
    "motor-ui",
    (container) => {
      container.innerHTML = `
        <div class="motor-terminal"></div>
        <div class="motor-body">
          <div class="motor-ribs"></div>
          <div class="motor-status"></div>
        </div>
        <div class="motor-shield"></div>
        <div class="motor-fan">
          <div class="motor-fan-label">FWD</div>
          <div class="motor-direction"></div>
        </div>
        <div class="motor-shaft"></div>
        <div class="motor-coupling"></div>
        <div class="motor-foot motor-foot-left"></div>
        <div class="motor-foot motor-foot-right"></div>
        <div class="tag"></div>
      `;

      selectComponent(tagName);
    },
    () => {
      selectComponent(tagName);
      if (isDesignMode()) return;
      sendSetPoint(
        tagName,
        "running",
        getLatestState()?.[tagName]?.running ? 0 : 1
      );
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
  el.style.setProperty("--belt-phase", `${-(c.belt_phase || 0)}px`);

  const fanLabel = el.querySelector(".motor-fan-label");
  fanLabel.textContent = c.direction_forward ? "FWD" : "REV";

  const direction = el.querySelector(".motor-direction");

  if (c.running) {
    direction.style.transform =
      `rotate(${c.rotation_phase || 0}deg)`;
  } else {
    direction.style.transform = "rotate(0deg)";
  }

  el.querySelector(".tag").textContent = tagName;
}
