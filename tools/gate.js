(() => {
  const CFG = window.__MPCFG;
  const KEY_LS = "mp-key-" + CFG.salt.slice(0, 8);
  if (CFG.demo) {
    // Preview mode: keep everything in memory so nothing survives a reload.
    const mem = new Map();
    const fake = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), clear: () => mem.clear(), key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    try { Object.defineProperty(window, "localStorage", { value: fake, configurable: true }); } catch (e) {}
    try { Object.defineProperty(window, "sessionStorage", { value: fake, configurable: true }); } catch (e) {}
  }
  const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const ub64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  let KEY = null;

  async function deriveKey(pass) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(CFG.salt), iterations: CFG.iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }
  async function decrypt(key, buf) {
    const u = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, key, u.slice(12));
  }
  async function fetchBin(path) {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error("load " + path + " " + r.status);
    return r.arrayBuffer();
  }

  // ---------- photos: decrypt on demand as they scroll into view ----------
  const photoCache = new Map();
  function loadPhoto(id) {
    if (!photoCache.has(id)) {
      photoCache.set(id, fetchBin("photos/" + id + ".bin").then(b => decrypt(KEY, b)).then(p => URL.createObjectURL(new Blob([p], { type: "image/webp" }))).catch(() => null));
    }
    return photoCache.get(id);
  }
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target; io.unobserve(img);
      loadPhoto(img.dataset.photo).then(u => { if (u) img.src = u; else img.remove(); });
    }
  }, { rootMargin: "400px" });
  function watch(root) {
    root.querySelectorAll?.("img[data-photo]").forEach(img => {
      if (img.__w) return; img.__w = 1;
      const id = img.dataset.photo;
      const p = photoCache.get(id);
      if (p) p.then(u => { if (u) img.src = u; }); else io.observe(img);
    });
  }
  new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(n => { if (n.nodeType === 1) { if (n.matches?.("img[data-photo]")) watch(n.parentNode); else watch(n); } }); })
    .observe(document.body, { childList: true, subtree: true });

  // ---------- device identity (no accounts) ----------
  let device = null;
  try { device = localStorage.getItem("mp-device"); } catch (e) {}
  if (!device) { device = "d" + Math.random().toString(36).slice(2, 12); try { localStorage.setItem("mp-device", device); } catch (e) {} }
  const user = { id: async () => device, can: async () => true, isOwner: () => false, canEdit: () => true };

  // ---------- Supabase-backed store with the same shape the app expects ----------
  function makeDb() {
    if (!CFG.sbUrl || !CFG.sbKey) return null;
    const headers = { apikey: CFG.sbKey, "Content-Type": "application/json" };
    if (!CFG.sbKey.startsWith("sb_")) headers.Authorization = "Bearer " + CFG.sbKey;
    const sync = () => document.getElementById("sync");
    function status(ok) {
      const el = sync(); if (!el) return;
      if (ok) { if (el.dataset.off) { el.textContent = ""; el.classList.remove("show"); delete el.dataset.off; } }
      else { el.textContent = "Can't reach the sync server right now. Changes will show up once you're back online."; el.classList.add("show"); el.dataset.off = "1"; }
    }
    async function rpc(fn, body) {
      let r;
      try { r = await fetch(CFG.sbUrl + "/rest/v1/rpc/" + fn, { method: "POST", headers, body: JSON.stringify(body) }); }
      catch (e) { status(false); throw { code: "unavailable", message: String(e) }; }
      if (!r.ok) { const t = await r.text(); if (r.status >= 500) status(false); throw { code: r.status >= 500 ? "unavailable" : "invalid_argument", message: t }; }
      status(true);
      const t = await r.text(); return t ? JSON.parse(t) : null;
    }
    const KINDS = ["picks", "checks", "recipes"];
    const H = {};
    function hh(code) {
      if (!H[code]) H[code] = { rows: Object.fromEntries(KINDS.map(k => [k, new Map()])), ls: Object.fromEntries(KINDS.map(k => [k, new Set()])), loaded: false, pending: 0, busy: false };
      return H[code];
    }
    const sortStr = m => JSON.stringify([...m].sort((x, y) => x[0] < y[0] ? -1 : 1));
    function snap(h, kind) { const docs = [...h.rows[kind]].map(([id, d]) => ({ id, exists: true, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } })); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [] }; }
    function emit(h, kind) { const s = snap(h, kind); h.ls[kind].forEach(f => { try { f(s); } catch (e) { console.error(e); } }); }
    async function refresh(code) {
      const h = hh(code); if (h.busy || h.pending) return; h.busy = true;
      try {
        const rows = (await rpc("mp_get", { hh: code })) || [];
        const mig = window.__MP.migrate;
        if (mig && mig.hh === code && rows.length === 0 && !localStorage.getItem("mp-migrated-" + code)) {
          for (const r of mig.rows) await rpc("mp_put", { hh: code, k: r.kind, ky: r.key, d: r.data });
          try { localStorage.setItem("mp-migrated-" + code, "1"); } catch (e) {}
          h.busy = false; return refresh(code);
        }
        if (h.pending) return;
        const next = Object.fromEntries(KINDS.map(k => [k, new Map()]));
        for (const r of rows) if (next[r.kind]) next[r.kind].set(r.key, r.data);
        for (const k of KINDS) { const changed = sortStr(h.rows[k]) !== sortStr(next[k]); h.rows[k] = next[k]; if (changed || !h.loaded) emit(h, k); }
        h.loaded = true;
      } catch (e) { /* keep last known state */ }
      finally { h.busy = false; }
    }
    setInterval(() => { if (document.visibilityState !== "visible") return; for (const c in H) if (KINDS.some(k => H[c].ls[k].size)) refresh(c); }, 7000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") for (const c in H) refresh(c); });
    window.addEventListener("focus", () => { for (const c in H) refresh(c); });

    function docRef(code, kind, id) {
      const h = hh(code);
      return {
        id, path: `households/${code}/${kind}/${id}`,
        async get() { await refresh(code); const d = h.rows[kind].get(id); return { id, exists: d !== undefined, data: () => d }; },
        async set(data) { h.pending++; h.rows[kind].set(id, data); emit(h, kind); try { await rpc("mp_put", { hh: code, k: kind, ky: id, d: data }); } finally { h.pending--; } },
        async update(data) { const cur = h.rows[kind].get(id) || {}; return this.set({ ...cur, ...data }); },
        async delete() { h.pending++; h.rows[kind].delete(id); emit(h, kind); try { await rpc("mp_del", { hh: code, k: kind, ky: id }); } finally { h.pending--; } },
      };
    }
    function localDoc(path) {
      const k = "mp-doc-" + path;
      return {
        async get() { let v = null; try { v = JSON.parse(localStorage.getItem(k) || "null"); } catch (e) {} return { exists: !!v, data: () => v || undefined }; },
        async set(d) { try { localStorage.setItem(k, JSON.stringify(d)); } catch (e) {} },
      };
    }
    return {
      collection(path) {
        const m = path.match(/^households\/([A-Z0-9-]+)\/(picks|checks|recipes)$/);
        if (!m) throw new TypeError("unsupported collection " + path);
        const code = m[1], kind = m[2], h = hh(code);
        return {
          path,
          doc: id => docRef(code, kind, id),
          onSnapshot(cb) {
            h.ls[kind].add(cb);
            if (h.loaded) setTimeout(() => cb(snap(h, kind)), 0); else refresh(code);
            return () => h.ls[kind].delete(cb);
          },
          async get() { await refresh(code); return snap(h, kind); },
        };
      },
      doc(path) {
        const m = path.match(/^households\/([A-Z0-9-]+)\/(picks|checks|recipes)\/(.+)$/);
        if (m) return docRef(m[1], m[2], m[3]);
        if (path === "meta/owner") return { async get() { return { exists: false, data: () => undefined }; }, async set() {} };
        return localDoc(path);
      },
    };
  }

  // ---------- unlock ----------
  async function start(key) {
    const plain = await decrypt(key, await fetchBin("data.bin"));
    const payload = JSON.parse(new TextDecoder().decode(plain));
    KEY = key;
    window.__MP = { recipes: payload.recipes, migrate: CFG.demo ? null : (payload.migrate || null), makeDb, user, blank: BLANK, demo: !!CFG.demo };
    document.getElementById("lock").hidden = true;
    document.getElementById("app").hidden = false;
    const s = document.createElement("script"); s.src = "app.js?v=" + CFG.salt.slice(0, 6); document.body.appendChild(s);
  }
  const form = document.getElementById("lockform"), err = document.getElementById("lockerr"), btn = document.getElementById("unlockbtn");
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true; btn.textContent = "Opening...";
    try {
      const key = await deriveKey(document.getElementById("pass").value.trim());
      await start(key);
      try { localStorage.setItem(KEY_LS, ub64(await crypto.subtle.exportKey("raw", key))); } catch (e2) {}
    } catch (e2) {
      err.textContent = e2 && e2.name === "OperationError" ? "That passcode didn't work. Check it and try again." : "Couldn't load the cookbooks. Check your connection and try again.";
      btn.disabled = false; btn.textContent = "Open";
    }
  });
  (async () => {
    if (CFG.demo) {
      const h = location.hash.slice(1).replace(/-/g, "+").replace(/_/g, "/");
      document.getElementById("lock").querySelector("p").textContent = "Opening the preview...";
      try { await start(await crypto.subtle.importKey("raw", b64(h + "=".repeat((4 - h.length % 4) % 4)), "AES-GCM", false, ["decrypt"])); }
      catch (e) { document.getElementById("lock").querySelector("p").textContent = "This preview link is incomplete or out of date. Ask for a new one."; document.getElementById("pass").hidden = true; document.getElementById("unlockbtn").hidden = true; }
      return;
    }
    let saved = null; try { saved = localStorage.getItem(KEY_LS); } catch (e) {}
    if (!saved) { document.getElementById("pass").focus(); return; }
    try { await start(await crypto.subtle.importKey("raw", b64(saved), "AES-GCM", false, ["decrypt"])); }
    catch (e) { try { localStorage.removeItem(KEY_LS); } catch (e2) {} }
  })();
})();
