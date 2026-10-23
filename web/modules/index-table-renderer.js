const NS = "http://www.w3.org/2000/svg";

export function renderIndexTable(tagName, c, { getOrCreate, selectComponent, isDesignMode, sendSetPoint, getLatestState }) {
  const el = getOrCreate(
    tagName,
    "index-table-ui",
    (container) => {
      container.innerHTML = `
        <svg class="it-svg" viewBox="-100 -100 200 200">
          <circle class="it-base" r="96"></circle>
          <g class="it-plate"></g>
          <path class="it-pointer" d="M0 -98 L7 -86 L-7 -86 Z"></path>
          <circle class="it-hub" r="22"></circle>
          <text class="it-step" y="6" text-anchor="middle"></text>
        </svg>
        <div class="it-badge"></div>
        <div class="tag"></div>`;
      selectComponent(tagName);
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
  el.style.zIndex = c.layer || 0;
  el.classList.toggle("running", !!c.running_status);
  el.classList.toggle("moving", !!c.moving);

  const plate = el.querySelector(".it-plate");
  const n = c.stations || 6;
  if (plate.dataset.stations !== String(n)) {
    plate.dataset.stations = String(n);
    plate.innerHTML = "";
    const r = 68;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI - Math.PI / 2;
      const g = document.createElementNS(NS, "g");
      g.dataset.i = i;
      const sep = document.createElementNS(NS, "line");
      const sa = a + Math.PI / n;
      sep.setAttribute("x1", 28 * Math.cos(sa)); sep.setAttribute("y1", 28 * Math.sin(sa));
      sep.setAttribute("x2", 94 * Math.cos(sa)); sep.setAttribute("y2", 94 * Math.sin(sa));
      sep.setAttribute("class", "it-sep");
      const pocket = document.createElementNS(NS, "circle");
      pocket.setAttribute("cx", r * Math.cos(a)); pocket.setAttribute("cy", r * Math.sin(a));
      pocket.setAttribute("r", Math.max(6, Math.min(16, 90 / n)));
      pocket.setAttribute("class", "it-pocket");
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", 50 * Math.cos(a)); t.setAttribute("y", 50 * Math.sin(a) + 3);
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "it-num");
      t.textContent = i + 1;
      g.append(sep, pocket, t);
      plate.appendChild(g);
    }
  }
  plate.setAttribute("transform", `rotate(${c.angle || 0})`);
  // Highlight the pocket under the fixed pointer (the current station).
  plate.querySelectorAll("g").forEach((g) =>
    {
      const i = Number(g.dataset.i);
      // The table rotates clockwise in the 2D view, so the pocket under the
      // fixed top pointer is the inverse of the current step offset.
      g.classList.toggle("active", i === (n - (((c.step || 1) - 1) % n)) % n);
      g.classList.toggle("occupied", !!c.station_parts?.[i]);
    });

  el.querySelector(".it-step").textContent = `${c.step || 1}/${n}`;
  el.querySelector(".it-badge").textContent = c.running_status ? (c.moving ? "INDEXING" : "RUN") : "STOP";
  el.querySelector(".tag").textContent = tagName;
}
