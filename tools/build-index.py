# Builds public/index.html from the artifact source + standalone adaptations.
import re, sys
src = sys.argv[1]; out = sys.argv[2]
s = open(src).read()
def R(a, b):
    global s
    assert s.count(a) == 1, ("ANCHOR", s.count(a), a[:100])
    s = s.replace(a, b)

R('const use = window.claude && window.claude.use;', 'const use = (window.INMA && window.INMA.use) || (window.claude && window.claude.use);')
R('<button class="btn sm railbtn" data-act2="prefs">${ic("gear")}Mes préférences</button>',
  '<button class="btn sm railbtn" data-act2="prefs">${ic("gear")}Mes préférences</button>${window.INMA ? `<span style="word-break:break-all">${h(window.INMA.me()?.email || "")}</span><button class="btn sm railbtn" data-act2="logout">Se déconnecter</button>` : ""}')
# members: invite button
R('''<td>${m.code ? `<span class="row" style="flex-wrap:nowrap"><span class="mono">${h(m.code)}</span><button class="btn sm ghost" data-copy="${h(m.code)}" aria-label="Copier le code">${ic("copy")}</button></span>` : "—"}</td>''',
  '''<td><span class="row" style="flex-wrap:nowrap">${m.code ? `<span class="mono" title="Dernier code d'activation envoyé">${h(m.code)}</span>` : ""}<button class="btn sm" data-ext-invite="${m.id}">${m.invitedAt ? "Renvoyer" : "Inviter"}</button></span></td>''')
R("<th>Équipe</th><th>Code d'accès</th><th>Compte</th><th></th>", "<th>Équipe</th><th>Invitation</th><th>Compte</th><th></th>")
# invite text & modal
i0 = s.index('function inviteText(m) {'); i1 = s.index('function extModal(')
s = s[:i0] + r'''function inviteText(m) {
  const L = [`Bonjour ${m.name},`, ""];
  if (!m.external) L.push(`Vous êtes invité(e) sur INMA Workflow (rôle : ${role(m.roleId)?.name || "membre"}).`);
  else L.push("L'équipe INMA vous donne accès aux éléments suivants dans INMA Workflow :");
  for (const g of m.external ? activeGrants(m) : []) {
    if (g.kind === "dossier") { const d = dossierById(g.id); if (!d) continue; L.push(`• ${d.code} · ${d.name} (${lvlLabel(g.level).toLowerCase()})${g.until ? ` — jusqu'au ${fdate(g.until)}` : ""}`); if (isURL(d.oneDriveUrl)) L.push(`  Documents : ${d.oneDriveUrl}`); }
    else { const f = fundById(g.fundId); const r = f && findNode(f, g.id); if (!r) continue; L.push(`• ${[f.name, ...r.path.map(x => x.name), r.node.name].join(" › ")} (${lvlLabel(g.level).toLowerCase()})${g.until ? ` — jusqu'au ${fdate(g.until)}` : ""}`); if (isURL(r.node.url)) L.push(`  Documents : ${r.node.url}`); }
  }
  L.push("", `Lien de l'outil : ${S.cfg.general.appUrl || "(à compléter dans Paramètres › Général)"}`, window.INMA ? "Votre code d'activation figure dans l'e-mail d'invitation." : `Votre code d'accès : ${m.code}`, "", "Cordialement,", me()?.name || "L'équipe INMA");
  return L.join("\n");
}
function inviteModal(m) {
  if (!m) return;
  const t = inviteText(m), SA = !!window.INMA;
  const canShare = SA && window.INMA.graph.available() && m.external && activeGrants(m).some(g => g.kind === "dossier" ? isURL(dossierById(g.id)?.oneDriveUrl) : isURL(liveNode(g.fundId, g.id)?.n.url));
  modal("Invitation · " + m.name, `${SA ? `<p class="muted" style="margin:0">${h(m.name)} reçoit un e-mail avec un code d'activation et un lien vers l'outil (avec un lien « Ouvrir dans Microsoft Edge »).${m.invitedAt ? " Un nouvel envoi remplace le code précédent." : ""}</p>`
      : `<p class="muted" style="margin:0">Partagez d'abord la page INMA Workflow avec ${h(m.email || "cette personne")} (menu Partager), puis envoyez-lui ce message.</p>`}
    ${m.email ? `<div class="row"><span class="muted">E-mail :</span><span class="mono" style="user-select:all">${h(m.email)}</span></div>` : `<div class="banner warn">Renseignez d'abord l'adresse e-mail de ${h(m.name)} (${m.external ? "Gérer les accès" : "Paramètres › Membres"}).</div>`}
    ${canShare ? `<label class="chk"><input type="checkbox" id="inv-share" checked>Partager aussi les dossiers OneDrive / SharePoint concernés avec cette personne (lecture ou modification selon son niveau d'accès)</label>` : ""}
    <details ${SA ? "" : "open"}><summary style="cursor:pointer;font-weight:600">Texte du message</summary><textarea id="inv-txt" rows="12" readonly style="font-size:13px;margin-top:8px">${h(t)}</textarea></details>`,
    `<button class="btn" data-mclose="1">Fermer</button><button class="btn" data-copy="${h(t)}">${ic("copy")}Copier le texte</button>${SA ? `<button class="btn pri" data-act2="send-invite" data-mid="${m.id}" ${m.email ? "" : "disabled"}>Envoyer l'invitation</button>` : ""}`, null, true);
}
''' + s[i1:]
# externals help text
R('function sExternals() {\n  return vExternals() + `', '''function sExternals() {
  if (window.INMA) return vExternals() + `<div class="banner info" style="display:block;line-height:1.55"><b>Comment donner accès à un externe</b><br>
    1. Ajoutez la personne avec son e-mail et cochez les dossiers qu'elle peut voir (lecture ou contribution, date de fin si besoin).<br>
    2. Cliquez « Invitation » puis « Envoyer l'invitation » : elle reçoit un e-mail avec un code d'activation et le lien de l'outil.<br>
    3. Laissez cochée l'option de partage OneDrive pour lui ouvrir aussi les fichiers (le partage externe doit être autorisé par votre organisation).<br>
    Ensuite, elle se connecte avec un code reçu par e-mail. Le serveur ne lui transmet que les dossiers partagés.</div>`;
  return vExternals() + `''')
# dossier OneDrive tab button
R('<header>${ic("cloud")}<h2>Dossier OneDrive</h2><span class="spacer"></span>',
  '<header>${ic("cloud")}<h2>Dossier OneDrive</h2><span class="spacer"></span>${window.INMA?.graph?.available() && canOD ? `<button class="btn" data-act2="od-create" title="Crée le dossier et son arborescence type dans OneDrive / SharePoint et enregistre les liens">${isURL(d.oneDriveUrl) ? "Créer les sous-dossiers dans OneDrive" : "Créer le dossier dans OneDrive"}</button>` : ""}')
# fund OneDrive button
R('${ef ? `<button class="btn sm" data-act2="tree-import">Modifier en texte</button>',
  '${ef && window.INMA?.graph?.available() ? `<button class="btn sm" data-act2="fund-od" title="Crée sous le dossier racine du fonds les dossiers manquants et enregistre leurs liens">Créer dans OneDrive</button>` : ""}${ef ? `<button class="btn sm" data-act2="tree-import">Modifier en texte</button>')
# new actions
R('  if (A === "prefs") prefsModal();', r'''  if (A === "logout") { window.INMA?.logout(); return; }
  if (A === "send-invite") {
    const mid = ds.mid, share = $("#inv-share")?.checked; el.disabled = true; el.textContent = "Envoi…";
    try {
      const r = await window.INMA.invite(mid);
      if (r.mode === "console") {
        $("#modal")?.remove();
        const link = `${S.cfg.general.appUrl || location.origin}/?invite=${r.code}`;
        const txt = `Bonjour ${mname(mid)},\n\nVoici votre accès à INMA Workflow (à ouvrir de préférence dans Microsoft Edge) :\nLien : ${link}\nCode d'activation : ${r.code}\n\n${me()?.name || "L'équipe INMA"}`;
        modal("Invitation à transmettre", `<div class="banner warn">L'envoi automatique des e-mails n'est pas encore configuré. Transmettez ce message à ${h(r.sentTo)} par Outlook ou Teams.</div><textarea rows="9" readonly style="font-size:13px">${h(txt)}</textarea>`, `<button class="btn" data-mclose="1">Fermer</button><button class="btn pri" data-copy="${h(txt)}">${ic("copy")}Copier le message</button>`);
        return;
      }
      let note = `Invitation envoyée à ${r.sentTo}`;
      if (share) { const m = member(mid); let ok = 0; const ko = [];
        for (const g of activeGrants(m)) { const url = g.kind === "dossier" ? dossierById(g.id)?.oneDriveUrl : liveNode(g.fundId, g.id)?.n.url; if (!isURL(url)) continue;
          try { await window.INMA.graph.share(url, m.email, g.level === "contribute"); ok++; } catch (e) { ko.push(e.message); } }
        note += ko.length ? ` · ${ok} dossier(s) OneDrive partagé(s), ${ko.length} refusé(s) : ${ko[0]}` : ` · ${ok} dossier(s) OneDrive partagé(s)`; }
      $("#modal")?.remove(); await log(`Invitation envoyée à ${mname(mid)}`, {}); toast(note);
    } catch (e) { el.disabled = false; el.textContent = "Envoyer l'invitation"; toast(e.message + (e.data?.code ? ` · code : ${e.data.code}` : "")); }
    return;
  }
  if (A === "od-create") {
    const d = dossierById(S.openDossier); if (!d) return; const G = window.INMA.graph; const w = wfById(d.workflowId);
    el.disabled = true; el.textContent = "Création en cours…";
    try {
      let parent;
      if (isURL(d.oneDriveUrl)) parent = await G.resolve(d.oneDriveUrl);
      else {
        const f = (S.cfg.funds || []).find(x => x.name === d.vehicle); let base = null;
        walk(f?.tree || [], n => { if (!base && n.auto === "dossiers" && isURL(n.url)) base = n.url; });
        base = base || (isURL(f?.url) ? f.url : null) || (isURL(S.cfg.onedrive.perWorkflowRoot?.[w.id]) ? S.cfg.onedrive.perWorkflowRoot[w.id] : null) || (isURL(S.cfg.onedrive.rootUrl) ? S.cfg.onedrive.rootUrl : null);
        if (!base) { toast("Liez d'abord à OneDrive le dossier « Pipeline » du fonds, ou son dossier racine (onglet Fonds)."); el.disabled = false; el.textContent = "Créer le dossier dans OneDrive"; return; }
        const p = await G.resolve(base); const it = await G.ensureFolder(p.driveId, p.id, folderName(d));
        parent = { driveId: p.driveId, id: it.id }; d.oneDriveUrl = it.webUrl;
      }
      const subs = []; await G.ensureTree(parent.driveId, parent.id, rebuild(w.folders || [], {}), (n, it, path) => subs.push({ name: path.join("/"), url: it.webUrl }));
      d.subfolders = subs; await putDoc("dossiers", d); await log(`${d.code} : arborescence créée dans OneDrive (${subs.length} dossiers)`, { dossierId: d.id });
      toast(`Arborescence créée et liée : ${subs.length} dossiers`); render(); renderDrawer();
    } catch (e) { toast("OneDrive : " + e.message); el.disabled = false; el.textContent = "Réessayer la création OneDrive"; }
    return;
  }
  if (A === "fund-od" && fsel) {
    if (!isURL(fsel.url)) { toast("Liez d'abord le dossier racine du fonds (fiche du fonds › Parcourir)."); return; }
    const G = window.INMA.graph, fid = fsel.id; el.disabled = true; el.textContent = "Création…";
    try {
      const p = await G.resolve(fsel.url); const urls = {}; let k = 0;
      await G.ensureTree(p.driveId, p.id, fsel.tree || [], (n, it) => { urls[n.id] = it.webUrl; k++; });
      const f = fundById(fid); walk(f.tree, n => { if (urls[n.id] && !isURL(n.url)) n.url = urls[n.id]; });
      saveCfg(`${k} dossiers créés ou retrouvés dans OneDrive, liens enregistrés`); render();
    } catch (e) { toast("OneDrive : " + e.message); el.disabled = false; el.textContent = "Créer dans OneDrive"; }
    return;
  }
  if (A === "prefs") prefsModal();''')
R('  for (const m of S.cfg.members) if (!m.code) { m.code = genCode(); ch = true; }', '  if (!window.INMA) for (const m of S.cfg.members) if (!m.code) { m.code = genCode(); ch = true; }')
R('if (c) { const m = member(c.memberId); if (m && (!m.code || m.code === c.code)) return m; }', 'if (c) { const m = member(c.memberId); if (m && (window.INMA || !m.code || m.code === c.code)) return m; }')
# title out of body
m = re.match(r'<title>(.*?)</title>\s*<meta name="claude:viewport-fit-sides" content="cover">\s*', s)
assert m; body = s[m.end():]
head = '''<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>INMA Workflow</title>
<meta name="theme-color" content="#212121">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="/vendor/msal-browser.min.js"></script>
<script src="/inma-standalone.js"></script>
</head>
<body>
'''
open(out, 'w').write(head + body + '\n</body>\n</html>\n')
print("built", out)
