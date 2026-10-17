/* INMA Workflow — standalone runtime: sign-in, server data, Microsoft Graph (OneDrive / SharePoint). */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const h = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const st = { pub: null, me: null, snap: null, msal: null, ready: null, subs: [], refreshT: null };

  async function api(path, opts = {}) {
    const init = { credentials: "same-origin", method: opts.method || "GET", headers: { "Content-Type": "application/json", "X-INMA": "1" } };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const r = await fetch(path, init);
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error((j && j.error) || ("Erreur " + r.status));
      e.status = r.status; e.code = r.status === 403 ? "not_granted" : r.status === 401 ? "unauthenticated" : "error"; e.data = j;
      if (r.status === 401 && st.me) location.reload();
      throw e;
    }
    return j;
  }

  /* ---------------- data shim (same shape as the artifact database) ---------------- */
  const clean = d => { const c = { ...d }; delete c.__v; return c; };
  function docsOf(coll) {
    if (!st.snap) return [];
    if (coll === "ws") return [{ ...st.snap.config, id: "config" }];
    if (coll === "claims") return st.snap.claims || [];
    return st.snap[coll] || [];
  }
  function deliver(s) {
    if (!st.snap) return;
    let payload, key;
    if (s.kind === "doc") {
      const d = docsOf(s.coll).find(x => x.id === s.id);
      key = JSON.stringify(d || null);
      payload = { id: s.id, exists: !!d, data: () => d ? clean(d) : undefined, metadata: { fromCache: false, hasPendingWrites: false } };
    } else {
      let arr = docsOf(s.coll).slice();
      if (s.order) { const { f, dir } = s.order; arr.sort((a, b) => (a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === "desc" ? -1 : 1)); }
      if (s.lim) arr = arr.slice(0, s.lim);
      key = JSON.stringify(arr);
      payload = { docs: arr.map(d => ({ id: d.id, exists: true, data: () => clean(d), metadata: {} })), size: arr.length, empty: !arr.length, docChanges: () => [], metadata: {} };
    }
    if (key === s.last) return; // nothing changed for this listener
    s.last = key;
    try { s.cb(payload); } catch (e) { console.error(e); }
  }
  const emit = () => st.subs.forEach(deliver);
  async function refresh() { st.snap = await api("/api/snapshot"); st.me = st.snap.me; emit(); }
  function scheduleRefresh(ms) { clearTimeout(st.refreshT); st.refreshT = setTimeout(() => refresh().catch(() => {}), ms); }
  function wrapErr(e) { const x = new Error(e.message); x.code = e.code; throw x; }
  function docRef(coll, id) {
    const ref = {
      id, path: coll + "/" + id,
      async get() { const d = docsOf(coll).find(x => x.id === id); return { id, exists: !!d, data: () => d ? clean(d) : undefined, metadata: {} }; },
      async set(data) { try { await api(`/api/docs/${encodeURIComponent(coll)}/${encodeURIComponent(id)}`, { method: "PUT", body: { data } }); } catch (e) { scheduleRefresh(50); wrapErr(e); } scheduleRefresh(60); },
      async update(data) { const cur = docsOf(coll).find(x => x.id === id) || {}; return ref.set({ ...clean(cur), ...data }); },
      async delete() { try { await api(`/api/docs/${encodeURIComponent(coll)}/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (e) { scheduleRefresh(50); wrapErr(e); } scheduleRefresh(60); },
      onSnapshot(cb) { const s = { kind: "doc", coll, id, cb }; st.subs.push(s); setTimeout(() => deliver(s), 0); return () => { st.subs = st.subs.filter(x => x !== s); }; },
      collection(sub) { return collRef(coll + "/" + id + "/" + sub); },
    };
    return ref;
  }
  function collRef(coll, order, lim) {
    return {
      path: coll,
      doc: id => docRef(coll, id || ("d" + Math.random().toString(36).slice(2, 12))),
      where: () => collRef(coll, order, lim),
      orderBy: (f, dir) => collRef(coll, { f, dir }, lim),
      limit: n => collRef(coll, order, n),
      async get() { return { docs: docsOf(coll).map(d => ({ id: d.id, exists: true, data: () => clean(d) })), size: docsOf(coll).length, empty: !docsOf(coll).length }; },
      async add(data) { const r = docRef(coll, "d" + Math.random().toString(36).slice(2, 12)); await r.set(data); return r; },
      onSnapshot(cb) { const s = { kind: "coll", coll, order, lim, cb }; st.subs.push(s); setTimeout(() => deliver(s), 0); return () => { st.subs = st.subs.filter(x => x !== s); }; },
    };
  }
  const dbShim = { doc(p) { const [c, id] = p.split("/"); return docRef(c, id); }, collection: c => collRef(c) };
  const userShim = {
    isOwner: async () => !!st.me?.isAdmin, canEdit: async () => !!st.me?.isAdmin, can: async () => true,
    id: async () => st.me?.userId || null,
    me: async () => ({ id: st.me?.userId, name: st.me?.name || "", email: st.me?.email, avatarUrl: "", color: "", isOwner: !!st.me?.isAdmin, canEdit: !!st.me?.isAdmin }),
    profiles: async () => ({}), search: async () => [],
  };
  const downloadsShim = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv;charset=utf-8" : "application/octet-stream" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return { status: "saved" };
    },
  };

  /* ---------------- Microsoft sign-in & Graph ---------------- */
  const LOGIN_SCOPES = ["openid", "profile", "email", "User.Read"];
  const DRIVE_SCOPES = ["Files.ReadWrite.All", "Sites.ReadWrite.All"];
  async function initMsal() {
    if (!st.pub.msEnabled || !window.msal) return;
    st.msal = new window.msal.PublicClientApplication({
      auth: { clientId: st.pub.clientId, authority: `https://login.microsoftonline.com/${st.pub.tenantId}`, redirectUri: location.origin + "/", navigateToLoginRequestUrl: false },
      cache: { cacheLocation: "localStorage" },
    });
    await st.msal.initialize();
    const res = await st.msal.handleRedirectPromise().catch(e => { console.warn(e); return null; });
    if (res && res.account) st.msal.setActiveAccount(res.account);
    if (res && res.idToken && sessionStorage.getItem("inma-ms-login") === "1") {
      sessionStorage.removeItem("inma-ms-login");
      await api("/api/auth/microsoft", { method: "POST", body: { idToken: res.idToken } });
    }
    if (!st.msal.getActiveAccount() && st.msal.getAllAccounts().length) st.msal.setActiveAccount(st.msal.getAllAccounts()[0]);
  }
  function msLogin() {
    sessionStorage.setItem("inma-ms-login", "1");
    const hint = st.me?.email;
    return st.msal.loginRedirect({ scopes: LOGIN_SCOPES, prompt: hint ? undefined : "select_account", loginHint: hint || undefined });
  }
  async function token(scopes) {
    if (!st.msal) throw new Error("La connexion Microsoft n'est pas configurée sur ce serveur.");
    const acc = st.msal.getActiveAccount();
    if (!acc) { await msLogin(); return new Promise(() => {}); }
    try { return (await st.msal.acquireTokenSilent({ scopes, account: acc })).accessToken; }
    catch { try { return (await st.msal.acquireTokenPopup({ scopes, account: acc })).accessToken; } catch { await st.msal.acquireTokenRedirect({ scopes, account: acc }); return new Promise(() => {}); } }
  }
  async function g(path, opts = {}) {
    const t = await token(DRIVE_SCOPES);
    const r = await fetch(path.startsWith("http") ? path : "https://graph.microsoft.com/v1.0" + path, { method: opts.method || "GET", body: opts.body ? JSON.stringify(opts.body) : undefined, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" } });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(j?.error?.message || ("Microsoft Graph : erreur " + r.status)); e.status = r.status; throw e; }
    return j;
  }
  const shareId = url => "u!" + btoa(unescape(encodeURIComponent(url))).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  const graph = {
    available: () => !!st.msal,
    signedIn: () => !!st.msal?.getActiveAccount(),
    async resolve(url) { const it = await g(`/shares/${shareId(url)}/driveItem?$select=id,name,webUrl,parentReference,folder`); return { driveId: it.parentReference.driveId, id: it.id, webUrl: it.webUrl, name: it.name }; },
    async ensureFolder(driveId, parentId, name) {
      const safe = String(name).replace(/[\\/:*?"<>|#%]/g, "-").replace(/\s+$/, "").trim() || "Dossier";
      try { return await g(`/drives/${driveId}/items/${parentId}/children`, { method: "POST", body: { name: safe, folder: {}, "@microsoft.graph.conflictBehavior": "fail" } }); }
      catch (e) { if (e.status === 409) return await g(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(safe)}`); throw e; }
    },
    async ensureTree(driveId, parentId, nodes, onNode, prefix = []) {
      for (const n of nodes || []) {
        const it = await graph.ensureFolder(driveId, parentId, n.name); const p = [...prefix, n.name];
        if (onNode) onNode(n, it, p);
        if ((n.children || []).length) await graph.ensureTree(driveId, it.id, n.children, onNode, p);
      }
    },
    async share(url, email, write, message) {
      const it = await graph.resolve(url);
      return g(`/drives/${it.driveId}/items/${it.id}/invite`, { method: "POST", body: { recipients: [{ email }], requireSignIn: true, sendInvitation: true, roles: [write ? "write" : "read"], message: message || "Accès partagé depuis INMA Workflow" } });
    },
    pick: pickFolder,
  };

  /* ---------------- folder picker ---------------- */
  function pickFolder(opts = {}) {
    return new Promise(resolve => {
      const L = document.createElement("div"); L.className = "modalwrap"; L.id = "modal-picker";
      let tab = "me", stack = [], sites = [], items = [], busy = false, err = "";
      const close = v => { L.remove(); resolve(v); };
      const cur = () => stack[stack.length - 1];
      async function load() {
        busy = true; err = ""; draw();
        try {
          const c = cur();
          if (!c) {
            if (tab === "me") { const root = await g("/me/drive/root?$select=id,name,webUrl,parentReference"); stack = [{ driveId: root.parentReference.driveId, id: root.id, name: "Mon OneDrive", webUrl: root.webUrl }]; return load(); }
            const q = ($("#pk-q", L)?.value || "").trim();
            sites = (await g(`/sites?search=${encodeURIComponent(q || "*")}&$select=id,displayName,webUrl&$top=50`)).value || [];
          } else if (c.site) {
            items = ((await g(`/sites/${c.site}/drives?$select=id,name,webUrl`)).value || []).map(d => ({ drive: true, driveId: d.id, id: "root", name: d.name, webUrl: d.webUrl }));
          } else {
            const path = c.id === "root" ? `/drives/${c.driveId}/root/children` : `/drives/${c.driveId}/items/${c.id}/children`;
            items = ((await g(`${path}?$select=id,name,webUrl,folder,file,parentReference&$top=200`)).value || []).map(x => ({ ...x, driveId: c.driveId })).sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name));
          }
        } catch (e) { err = e.message; }
        busy = false; draw();
      }
      function draw() {
        const c = cur();
        const crumbs = stack.map((s, i) => `<button class="btn sm ghost" data-pk-crumb="${i}">${h(s.name)}</button>`).join("›");
        let list = "";
        if (!c && tab === "sites") list = sites.map((s, i) => `<div class="folder" data-pk-site="${i}" style="cursor:pointer"><span class="nm">${h(s.displayName)}</span><span class="muted" style="font-size:11px">${h(s.webUrl)}</span></div>`).join("") || '<p class="muted">Aucun site trouvé.</p>';
        else list = items.map((x, i) => x.file ? `<div class="folder" style="opacity:.55"><span class="nm">${h(x.name)}</span></div>` : `<div class="folder" data-pk-item="${i}" style="cursor:pointer"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span class="nm">${h(x.name)}</span></div>`).join("") || '<p class="muted">Dossier vide.</p>';
        L.innerHTML = `<div class="modal wide" role="dialog" aria-label="Choisir un dossier"><header><h2>${h(opts.title || "Choisir un dossier OneDrive / SharePoint")}</h2><span class="spacer"></span><button class="btn sm ghost" data-pk-close="1">Fermer</button></header>
          <div class="mbody"><div class="seg"><button class="${tab === "me" ? "on" : ""}" data-pk-tab="me">Mon OneDrive</button><button class="${tab === "sites" ? "on" : ""}" data-pk-tab="sites">Sites SharePoint</button></div>
          ${!c && tab === "sites" ? `<div class="row" style="flex-wrap:nowrap"><input type="search" id="pk-q" placeholder="Rechercher un site (ex. INMA)"><button class="btn sm" data-pk-search="1">Rechercher</button></div>` : `<div class="row" style="gap:2px">${crumbs}</div>`}
          ${err ? `<div class="banner warn">${h(err)}</div>` : ""}
          <div style="max-height:46vh;overflow:auto">${busy ? '<p class="muted">Chargement…</p>' : list}</div>
          ${c && !c.site ? `<div class="row" style="flex-wrap:nowrap"><input type="text" id="pk-new" placeholder="Nouveau dossier ici…"><button class="btn sm" data-pk-new="1">Créer</button></div>` : ""}</div>
          <footer><span class="muted" style="margin-right:auto;font-size:12px">${c && !c.site ? "Dossier : " + h(c.name) : ""}</span><button class="btn" data-pk-close="1">Annuler</button><button class="btn pri" data-pk-ok="1" ${c && !c.site && c.id !== "root" ? "" : (c && !c.site ? "" : "disabled")}>Choisir ce dossier</button></footer></div>`;
      }
      L.addEventListener("click", async e => {
        const t = e.target.closest("[data-pk-close],[data-pk-tab],[data-pk-crumb],[data-pk-site],[data-pk-item],[data-pk-ok],[data-pk-search],[data-pk-new]");
        if (e.target === L) return close(null); if (!t) return; const d = t.dataset;
        if (d.pkClose) return close(null);
        if (d.pkTab) { tab = d.pkTab; stack = []; items = []; return load(); }
        if (d.pkCrumb != null) { stack = stack.slice(0, +d.pkCrumb + 1); return load(); }
        if (d.pkSearch) return load();
        if (d.pkSite != null) { const s = sites[+d.pkSite]; stack = [{ site: s.id, name: s.displayName }]; return load(); }
        if (d.pkItem != null) { const x = items[+d.pkItem]; stack.push({ driveId: x.driveId, id: x.id, name: x.name, webUrl: x.webUrl }); return load(); }
        if (d.pkNew) { const n = $("#pk-new", L).value.trim(); if (!n) return; const c = cur(); try { const it = await graph.ensureFolder(c.driveId, c.id === "root" ? (await g(`/drives/${c.driveId}/root?$select=id`)).id : c.id, n); stack.push({ driveId: c.driveId, id: it.id, name: it.name, webUrl: it.webUrl }); load(); } catch (er) { err = er.message; draw(); } return; }
        if (d.pkOk) { const c = cur(); if (!c || c.site) return; let web = c.webUrl; if (!web) { const it = await g(c.id === "root" ? `/drives/${c.driveId}/root?$select=webUrl` : `/drives/${c.driveId}/items/${c.id}?$select=webUrl`); web = it.webUrl; } close({ webUrl: web, driveId: c.driveId, id: c.id, name: c.name }); }
      });
      L.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "pk-q") load(); if (e.key === "Escape") close(null); });
      document.body.appendChild(L); load();
    });
  }
  // Add a "Parcourir" button next to every OneDrive / SharePoint link field.
  function decorate(root) {
    if (!st.msal) return;
    root.querySelectorAll('input[type="url"]:not([data-picker])').forEach(inp => {
      if (inp.dataset.cfg === "general.appUrl" || inp.disabled) return;
      inp.dataset.picker = "1";
      const wrap = document.createElement("span"); wrap.style.cssText = "display:flex;gap:6px;align-items:center;min-width:0;width:100%";
      inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
      const b = document.createElement("button"); b.type = "button"; b.className = "btn sm"; b.textContent = "Parcourir"; b.title = "Choisir un dossier OneDrive / SharePoint";
      b.addEventListener("click", async ev => { ev.preventDefault(); ev.stopPropagation(); try { const r = await pickFolder(); if (r) { inp.value = r.webUrl; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); } } catch (e) { alertBox(e.message); } });
      wrap.appendChild(b);
    });
  }
  function alertBox(msg) { let t = document.querySelector(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); } t.textContent = msg; setTimeout(() => t.remove(), 4000); }

  /* ---------------- sign-in screen ---------------- */
  const isEdge = /Edg\//.test(navigator.userAgent), isWin = /Windows/.test(navigator.userAgent);
  function loginScreen(msg) {
    return new Promise(resolve => {
      const params = new URLSearchParams(location.search); const invite = params.get("invite") || "";
      const el = document.createElement("div"); el.id = "inma-login";
      let step = "email", email = "", adminMode = false;
      const draw = (note, isErr) => {
        el.innerHTML = `<div class="lg-card">
          <div class="lg-brand"><div class="wordmark">INMA<small>${h((st.pub.appName || "").replace(/^INMA\s*/i, "") || "WORKFLOW").toUpperCase()}</small></div></div>
          <div class="lg-body">
            ${!isEdge && isWin ? `<div class="banner info" style="font-size:12.5px">Pour utiliser votre compte INMA et OneDrive, ouvrez cette page dans Microsoft Edge. <a href="microsoft-edge:${h(location.href)}">Ouvrir dans Edge</a></div>` : ""}
            ${note ? `<div class="banner ${isErr ? "warn" : "info"}" role="status">${h(note)}</div>` : ""}
            ${invite ? `<h2>Activez votre accès</h2><p class="muted">Vous avez été invité(e) sur ${h(st.pub.appName)}. Votre code d'activation est rempli ci-dessous.</p>
              <label class="f"><span>Code d'activation</span><input type="text" id="lg-inv" value="${h(invite)}" autocomplete="one-time-code" style="text-transform:uppercase;letter-spacing:.2em;font-family:var(--f-mono)"></label>
              <button class="btn pri lg-wide" id="lg-inv-ok">Activer mon accès</button><div class="lg-or"><span>ou</span></div>` : `<h2>Connexion</h2>`}
            ${st.pub.msEnabled ? `<button class="btn lg-wide lg-ms" id="lg-ms"><svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>Se connecter avec Microsoft</button>
              <p class="muted lg-hint">Équipe INMA : utilisez votre compte de l'organisation pour lier OneDrive et SharePoint.</p>${(st.pub.mailReady || st.pub.dev) ? `<div class="lg-or"><span>ou recevoir un code par e-mail</span></div>` : ""}` : ""}
            ${adminMode ? `<h2 style="font-size:16px">Connexion administrateur</h2><label class="f"><span>E-mail administrateur</span><input type="email" id="lg-aemail" autocomplete="username"></label><label class="f"><span>Mot de passe</span><input type="password" id="lg-apass" autocomplete="current-password"></label><button class="btn pri lg-wide" id="lg-admin">Se connecter</button><button class="btn ghost lg-wide" id="lg-admin-hide">Retour</button>`
              : (st.pub.mailReady || st.pub.dev) ? step === "email" ? `<label class="f"><span>Adresse e-mail</span><input type="email" id="lg-email" value="${h(email)}" autocomplete="email" placeholder="prenom.nom@exemple.com"></label><button class="btn ${st.pub.msEnabled ? "" : "pri"} lg-wide" id="lg-send">Recevoir un code</button>`
              : `<p class="muted" style="margin:0">Si cette adresse a accès à l'outil, un code vient d'être envoyé à <b>${h(email)}</b>.</p><label class="f"><span>Code reçu (6 chiffres)</span><input type="text" id="lg-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="letter-spacing:.3em;font-family:var(--f-mono);font-size:18px"></label><button class="btn pri lg-wide" id="lg-verify">Se connecter</button><button class="btn ghost lg-wide" id="lg-back">Changer d'adresse</button>`
              : `<p class="muted lg-hint">La connexion par code e-mail sera disponible une fois l'envoi d'e-mails configuré.</p>`}
            ${st.pub.adminPassword && !adminMode ? `<button class="btn ghost lg-wide" id="lg-admin-show" style="font-size:12.5px">Connexion administrateur (mot de passe)</button>` : ""}
            ${st.pub.dev ? `<p class="muted lg-hint">Mode développement : les e-mails s'affichent dans la console du serveur.</p>` : ""}
          </div></div>`;
        const f = el.querySelector("#lg-aemail") || el.querySelector("#lg-code") || el.querySelector("#lg-inv") || el.querySelector("#lg-email"); f && f.focus();
      };
      const done = async () => { history.replaceState(null, "", location.pathname + location.hash); el.remove(); resolve(); };
      el.addEventListener("click", async e => {
        const id = e.target.closest("button")?.id; if (!id) return;
        try {
          if (id === "lg-ms") return msLogin();
          if (id === "lg-inv-ok") { await api("/api/auth/invite", { method: "POST", body: { code: $("#lg-inv", el).value } }); return done(); }
          if (id === "lg-send") { email = $("#lg-email", el).value.trim(); const r = await api("/api/auth/email/start", { method: "POST", body: { email } }); step = "code"; draw(r.wait ? "Un code a été envoyé il y a moins d'une minute : vérifiez votre boîte de réception." : ""); return; }
          if (id === "lg-verify") { await api("/api/auth/email/verify", { method: "POST", body: { email, code: $("#lg-code", el).value } }); return done(); }
          if (id === "lg-back") { step = "email"; draw(); }
          if (id === "lg-admin-show") { adminMode = true; draw(); }
          if (id === "lg-admin-hide") { adminMode = false; draw(); }
          if (id === "lg-admin") { await api("/api/auth/admin", { method: "POST", body: { email: $("#lg-aemail", el).value, password: $("#lg-apass", el).value } }); return done(); }
        } catch (er) { draw(er.message, true); }
      });
      el.addEventListener("keydown", e => { if (e.key !== "Enter") return; const b = el.querySelector("#lg-admin") || el.querySelector("#lg-verify") || (e.target.id === "lg-inv" ? el.querySelector("#lg-inv-ok") : el.querySelector("#lg-send")); b && b.click(); });
      document.body.appendChild(el); draw(msg);
    });
  }
  const css = document.createElement("style");
  css.textContent = `#inma-login{position:fixed;inset:0;z-index:100;background:var(--bg);display:grid;place-items:center;padding:24px max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px));overflow:auto}
  #inma-login .lg-card{width:min(420px,100%);background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)}
  #inma-login .lg-brand{background:var(--rail);padding:22px 26px}#inma-login .lg-body{padding:22px 26px;display:flex;flex-direction:column;gap:12px}
  #inma-login h2{font-size:19px}#inma-login .lg-wide{width:100%;justify-content:center;padding-block:10px}
  #inma-login .lg-ms{gap:10px;font-size:14px}#inma-login .lg-hint{font-size:12px;margin:-4px 0 0}
  #inma-login .lg-or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px}#inma-login .lg-or::before,#inma-login .lg-or::after{content:"";flex:1;height:1px;background:var(--line)}`;
  document.head.appendChild(css);

  /* ---------------- boot ---------------- */
  st.ready = (async () => {
    st.pub = await fetch("/api/public-config").then(r => r.json());
    document.title = st.pub.appName || document.title;
    let msg = "";
    try { await initMsal(); } catch (e) { msg = "Connexion Microsoft impossible : " + e.message; }
    try { st.me = await api("/api/me"); } catch { st.me = null; }
    if (!st.me || new URLSearchParams(location.search).get("invite")) {
      await new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
      if (st.me && new URLSearchParams(location.search).get("invite")) history.replaceState(null, "", location.pathname);
      else await loginScreen(msg);
    }
    await refresh();
    await new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r) : r());
    // Light polling: one tiny request every 15 s while the tab is visible; full reload only when something changed.
    const poll = async () => { if (document.hidden) return; try { const r = await api("/api/version"); if (r.v !== st.snap.version) await refresh(); } catch {} };
    setInterval(poll, 15_000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    new MutationObserver(() => decorate(document)).observe(document.body, { childList: true, subtree: true });
    decorate(document);
  })();

  window.INMA = {
    standalone: true,
    use: async name => { await st.ready; return { db: dbShim, user: userShim, downloads: downloadsShim }[name] || null; },
    me: () => st.me,
    graph,
    invite: memberId => api(`/api/invite/${encodeURIComponent(memberId)}`, { method: "POST", body: {} }),
    logout: async () => { await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {}); try { if (st.msal?.getActiveAccount()) sessionStorage.clear(); } catch {} location.href = "/"; },
    msLogin: () => st.msal ? msLogin() : null,
  };
})();
