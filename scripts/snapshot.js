(async () => {
  const LIB =
    "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js";
  const FN = `ai-panel-shot-${Date.now()}.png`;
  const req = typeof require === "function" ? require : window.require;
  const fs = req?.("fs");
  const path = req?.("path");
  const $all = (r, s = "*") => [...(r.querySelectorAll?.(s) || [])];
  const css = (e, o) => Object.assign(e.style, o);
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const b64 = (u) => u.replace(/^data:image\/png;base64,/, "");
  const nm = (e) =>
    `${e.tagName?.toLowerCase() || "node"}${e.id ? `#${e.id}` : ""}${
      typeof e.className === "string" && e.className.trim()
        ? `.${e.className.trim().replace(/\s+/g, ".")}`
        : ""
    }`;

  if (!window.htmlToImage) {
    document.head.appendChild(
      Object.assign(document.createElement("script"), {
        id: "__hti",
        src: LIB
      })
    );
    await new Promise((ok, no) => {
      __hti.onload = ok;
      __hti.onerror = no;
    });
  }

  const mode = await new Promise((ok) => {
    const d = document.createElement("div");
    css(d, {
      position: "fixed",
      inset: 0,
      zIndex: 2147483647,
      background: "rgba(0,0,0,.35)",
      display: "grid",
      placeItems: "center",
      font: '13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });
    d.innerHTML = `
      <div style="width:310px;padding:16px;border-radius:12px;background:#252525;color:#eee;box-shadow:0 18px 60px #0008">
        <b style="font-size:15px">Capture screenshot</b>
        <p style="opacity:.7;margin:6px 0 10px">Full page, $0, or click-pick.</p>
        ${[
          ["page", "All page"],
          ["selected", "Selected $0"],
          ["pick", "Pick element"],
          ["cancel", "Cancel"]
        ]
          .map(
            ([m, t]) =>
              `<button data-m="${m}" style="width:100%;margin-top:8px;padding:10px;border:1px solid #ffffff24;border-radius:8px;background:#ffffff14;color:white;text-align:left;font:inherit;cursor:pointer">${t}</button>`
          )
          .join("")}
      </div>`;
    d.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      d.remove();
      ok(b.dataset.m);
    };
    document.body.appendChild(d);
  });

  if (mode === "cancel") return console.log("Cancelled.");

  const pick = () =>
    new Promise((ok, no) => {
      let cur;
      const o = document.createElement("div");
      const l = document.createElement("div");

      css(o, {
        position: "fixed",
        zIndex: 2147483647,
        pointerEvents: "none",
        border: "2px solid #0af",
        background: "rgba(0,170,255,.14)"
      });
      css(l, {
        position: "fixed",
        zIndex: 2147483647,
        pointerEvents: "none",
        padding: "4px 7px",
        borderRadius: "4px",
        background: "#0af",
        color: "#fff",
        font: "11px sans-serif"
      });

      const done = () => {
        document.removeEventListener("mousemove", mv, true);
        document.removeEventListener("click", ck, true);
        document.removeEventListener("keydown", esc, true);
        o.remove();
        l.remove();
      };

      const mv = (e) => {
        cur = e.target;
        const r = cur.getBoundingClientRect();
        css(o, {
          left: `${r.left}px`,
          top: `${r.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`
        });
        css(l, {
          left: `${Math.max(0, r.left)}px`,
          top: `${Math.max(0, r.top - 24)}px`
        });
        l.textContent = nm(cur);
      };

      const ck = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        done();
        cur ? ok(cur) : no(Error("No element selected."));
      };

      const esc = (e) => {
        if (e.key !== "Escape") return;
        done();
        no(Error("Cancelled."));
      };

      document.body.append(o, l);
      document.addEventListener("mousemove", mv, true);
      document.addEventListener("click", ck, true);
      document.addEventListener("keydown", esc, true);
      console.log("Hover + click. Esc cancels.");
    });

  const target =
    mode === "page"
      ? document.body
      : mode === "selected"
      ? typeof $0 !== "undefined" && $0 instanceof Element
        ? $0
        : (() => {
            alert("No DevTools $0 selected.");
            throw Error("No $0 selected.");
          })()
      : await pick();

  const isPage = target === document.body;
  const restore = [];
  const keep = (el, props, extra) => {
    restore.push([el, props.map((p) => [p, el.style[p]]), extra]);
  };

  for (const el of isPage ? $all(document) : [target, ...$all(target)]) {
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    if (
      ["overflow", "overflowX", "overflowY"].some((p) =>
        ["hidden", "auto", "scroll"].includes(s[p])
      )
    ) {
      keep(el, ["overflow", "overflowX", "overflowY"]);
      css(el, {
        overflow: "visible",
        overflowX: "visible",
        overflowY: "visible"
      });
    }

    const m = (
      s.webkitMaskImage ||
      s.maskImage ||
      el.style.webkitMaskImage ||
      el.style.maskImage
    )?.match(/url\((["']?)(.*?)\1\)/)?.[2];

    if (!m || !rect.width || !rect.height) continue;

    let txt = null;

    if (m.startsWith("data:image/svg+xml")) {
      const raw = m.slice(m.indexOf(",") + 1);
      txt = m.includes(";base64,") ? atob(raw) : decodeURIComponent(raw);
    } else {
      try {
        const r = await fetch(m);
        if (r.ok) txt = await r.text();
      } catch (_) {}

      if (!txt && fs && path) {
        try {
          txt = fs.readFileSync(
            m.startsWith("file://")
              ? decodeURI(m.replace(/^file:\/\//, ""))
              : path.isAbsolute(m)
              ? m
              : path.resolve(
                  path.dirname(decodeURIComponent(location.pathname)),
                  m
                ),
            "utf8"
          );
        } catch (_) {}
      }
    }

    const svg =
      txt &&
      new DOMParser().parseFromString(txt, "image/svg+xml").documentElement;
    if (!svg || svg.tagName.toLowerCase() !== "svg") continue;

    const color =
      s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)"
        ? s.backgroundColor
        : s.color;

    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.style.color = color;

    $all(svg).forEach((n) => {
      if (
        !/^(path|rect|circle|ellipse|polygon|polyline|line|g|use)$/i.test(
          n.tagName
        )
      )
        return;
      if (
        [null, "", "black", "#000", "#000000", "currentColor"].includes(
          n.getAttribute("fill")
        )
      )
        n.setAttribute("fill", color);
      if (
        ["black", "#000", "#000000", "currentColor"].includes(
          n.getAttribute("stroke")
        )
      )
        n.setAttribute("stroke", color);
    });

    const c = document.importNode(svg, true);

    keep(
      el,
      [
        "position",
        "webkitMaskImage",
        "maskImage",
        "webkitMask",
        "mask",
        "background",
        "backgroundColor"
      ],
      c
    );

    if (s.position === "static") el.style.position = "relative";
    css(el, {
      webkitMaskImage: "none",
      maskImage: "none",
      webkitMask: "none",
      mask: "none",
      background: "transparent",
      backgroundColor: "transparent"
    });
    css(c, {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      display: "block"
    });
    el.appendChild(c);
  }

  $all(target, "svg").forEach((svg) =>
    $all(svg).forEach((e) => {
      if (/^currentcolor$/i.test(e.getAttribute("fill") || ""))
        e.setAttribute("fill", getComputedStyle(svg).color);
      if (/^currentcolor$/i.test(e.getAttribute("stroke") || ""))
        e.setAttribute("stroke", getComputedStyle(svg).color);
    })
  );

  await raf();

  const r = target.getBoundingClientRect();
  const size = isPage
    ? {
        width: Math.ceil(
          Math.max(
            document.body.scrollWidth,
            document.body.offsetWidth,
            document.documentElement.scrollWidth
          )
        ),
        height: Math.ceil(
          Math.max(
            document.body.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.scrollHeight
          )
        )
      }
    : {
        width: Math.ceil(
          Math.max(target.scrollWidth, target.offsetWidth, r.width)
        ),
        height: Math.ceil(
          Math.max(target.scrollHeight, target.offsetHeight, r.height)
        )
      };

  for (const el of isPage
    ? [document.documentElement, document.body]
    : [target]) {
    keep(el, ["width", "height", "minWidth", "minHeight"]);
    css(el, {
      width: `${size.width}px`,
      height: `${size.height}px`,
      minWidth: `${size.width}px`,
      minHeight: `${size.height}px`
    });
  }
  await raf();
  let img;
  try {
    img = await htmlToImage.toPng(target, {
      width: size.width,
      height: size.height,
      pixelRatio: Math.min(devicePixelRatio || 2, 3),
      backgroundColor:
        getComputedStyle(target).backgroundColor ||
        getComputedStyle(document.body).backgroundColor ||
        "#fff",
      cacheBust: true,
      skipAutoScale: true,
      style: { transform: "none", transformOrigin: "top left" }
    });
  } finally {
    restore.reverse().forEach(([el, styles, child]) => {
      child?.remove();
      styles.forEach(([k, v]) => (el.style[k] = v));
    });
  }
  const dlg =
    window.cep?.fs &&
    (window.cep.fs.showSaveDialogEx?.(
      "Save screenshot",
      "",
      ["PNG file:*.png"],
      FN
    ) ||
      window.cep.fs.showSaveDialog?.("", FN, "Save screenshot", ["png"]));
  let out = Array.isArray(dlg?.data)
    ? dlg.data[0]
    : typeof dlg?.data === "string"
    ? dlg.data
    : null;
  if (!out) {
    const a = Object.assign(document.createElement("a"), {
      href: img,
      download: FN
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    return console.warn("Saved with browser fallback:", FN);
  }
  if (out === "/" || out.endsWith("/")) out += FN;
  if (fs?.existsSync(out) && fs.statSync(out).isDirectory())
    out = path.join(out, FN);
  if (!/\.png$/i.test(out)) out += ".png";
  fs
    ? (fs.mkdirSync(path.dirname(out), { recursive: true }),
      fs.writeFileSync(out, Buffer.from(b64(img), "base64")))
    : window.cep.fs.writeFile(
        out,
        b64(img),
        window.cep.encoding?.Base64 || "Base64"
      );
  console.log("Screenshot saved:");
  console.log("Target:", nm(target));
  console.log("Path:", out);
  console.log("URL:", `file://${encodeURI(String(out).replace(/\\/g, "/"))}`);
  try {
    new window.CSInterface().evalScript(`
      (function () {
        var f = new File("${String(out)
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')}");
        if (f.exists) f.parent.execute();
      }());
    `);
  } catch (_) {}
})();
