export function renderCylinder(tagName, cyl, { getOrCreate, selectComponent, isDesignMode, sendSetPoint, getLatestState }) {
  const el = getOrCreate(
    tagName,
    "cylinder-ui",
    (container) => {
      const body = document.createElement("div");
      body.className = "body-ui";
      container.appendChild(body);

      const rod = document.createElement("div");
      rod.className = "rod-ui";
      container.appendChild(rod);

      const tag = document.createElement("div");
      tag.className = "tag";
      container.appendChild(tag);
    },
    () => {
      selectComponent(tagName);
      if (isDesignMode()) return;
      sendSetPoint(tagName, "extend", getLatestState()?.[tagName]?.extended ? 0 : 1);
    }
  );

  const bodyWidth = cyl.width * 0.62;

  // Container spans the full item footprint (body + rod travel) so
  // rotation pivots around the whole item's center, matching the
  // original CylinderItem's setTransformOriginPoint(rect.center()).
  el.style.left = `${cyl.x}px`;
  el.style.top = `${cyl.y}px`;
  el.style.width = `${cyl.width}px`;
  el.style.height = `${cyl.height}px`;
  el.style.transform = `rotate(${cyl.rotation || 0}deg)`;
  el.style.zIndex = cyl.layer || 0;

  el.querySelector(".body-ui").style.width = `${bodyWidth}px`;

  const rodMaxLen = cyl.width - bodyWidth;
  const rodLen = rodMaxLen * cyl.progress;

  const rod = el.querySelector(".rod-ui");
  rod.style.left = `${bodyWidth}px`;
  rod.style.width = `${rodLen}px`;

  el.querySelector(".tag").textContent =
    `${tagName}  progress=${cyl.progress.toFixed(2)}`;
}
