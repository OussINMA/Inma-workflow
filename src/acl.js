// Access control: what each signed-in person may read and write. Pure functions (no I/O).
export const ALL_PERMS = ["settings", "roles", "members", "workflows", "automations", "view_all", "view_amounts", "dossier_create", "dossier_edit_all",
  "dossier_delete", "stage_advance", "stage_approve", "task_create", "task_edit_all", "onedrive", "funds", "externals", "export", "deadlines", "projects", "meetings", "ai", "kpis", "compliance", "guide", "portfolio", "meetings_view", "projects_view"];
// Droits de consultation accordés par défaut : un rôle existant qui ne les mentionne pas les conserve.
export const DEFAULT_ON = ["meetings_view", "projects_view"];
const today = () => new Date().toISOString().slice(0, 10);

export class Denied extends Error { constructor(msg) { super(msg || "Action non autorisée pour votre rôle."); this.status = 403; } }

export function context(user, cfg, adminEmails) {
  const isAdmin = adminEmails.includes(String(user.email || "").toLowerCase());
  const member = user.member_id ? (cfg.members || []).find(m => m.id === user.member_id) || null : null;
  const role = (cfg.roles || []).find(r => r.id === (member ? member.roleId : cfg.general?.defaultRoleId));
  const perms = isAdmin ? Object.fromEntries(ALL_PERMS.map(p => [p, true])) : { ...(role?.perms || {}) };
  const isExt = !isAdmin && !!member?.external;
  return { cfg, user, member, perms, isAdmin, isExt, can: k => !!(k in perms ? perms[k] : DEFAULT_ON.includes(k)) };
}

export const canReview = c => c.isAdmin || c.can("compliance") || ((c.cfg.compliance?.reviewers || []).includes(c.member?.id));
export const activeGrants = m => (m?.grants || []).filter(g => !g.until || g.until >= today());
const grantFor = (c, kind, id) => activeGrants(c.member).find(g => g.kind === kind && g.id === id) || null;

export function canSeeMeeting(c, m) {
  if (!m || c.isExt) return false;
  if (c.isAdmin) return true;
  const id = c.member?.id; if (!id) return false;
  if (m.createdBy === id || m.secretaryId === id || (m.participants || []).includes(id)) return true;
  if (!c.can("meetings_view")) return false; // rôle limité : seulement les réunions auxquelles il a participé
  if (!m.visibility || m.visibility === "all") return true;
  if (m.visibility === "roles") return (m.roles || []).includes(c.member.roleId);
  return false;
}
const canEditMeeting = (c, m) => canSeeMeeting(c, m) && (c.isAdmin || c.can("meetings") || m.createdBy === c.member?.id || m.secretaryId === c.member?.id);
export function canSeeProject(c, p) {
  if (!p || c.isExt) return false;
  if (c.isAdmin || c.can("projects_view") || c.can("projects")) return true;
  const id = c.member?.id; return !!id && (p.ownerId === id || (p.members || []).includes(id));
}
export function canSeeDossier(c, d) {
  if (!d) return false;
  if (c.isExt) return !!grantFor(c, "dossier", d.id);
  if (c.can("view_all")) return true;
  const m = c.member;
  return !!m && (d.ownerId === m.id || (d.coOwners || []).includes(m.id) || (d.members || []).includes(m.id));
}
function canEditDossier(c, d) {
  if (c.isExt) return false;
  if (c.can("dossier_edit_all")) return true;
  const m = c.member;
  return !!m && (d.ownerId === m.id || (d.coOwners || []).includes(m.id) || (d.members || []).includes(m.id));
}
function canSeeTask(c, t, dossierOf) {
  if (!c.isExt && c.can("view_all")) return true;
  const m = c.member;
  if (t.projectId && m && !c.isExt && (c.can("projects_view") || c.can("projects"))) return true;
  if (m && (t.assignees || []).includes(m.id)) return true;
  if (t.dossierId) return canSeeDossier(c, dossierOf(t.dossierId));
  return !c.isExt && !!m && t.createdBy === m.id;
}
const currencyFields = cfg => new Set((cfg.customFields || []).filter(f => f.type === "currency").map(f => f.id));
function hideAmounts(c, d) {
  if (c.can("view_amounts")) return d;
  const out = { ...d }; delete out.amount;
  if (out.custom) { out.custom = { ...out.custom }; for (const k of currencyFields(c.cfg)) delete out.custom[k]; }
  return out;
}
function pruneTree(nodes, granted) {
  const out = [];
  for (const n of nodes || []) {
    if (granted.has(n.id)) { out.push(n); continue; }
    const kids = pruneTree(n.children, granted);
    if (kids.length) out.push({ ...n, url: "", note: "", children: kids });
  }
  return out;
}
// Fiches des participations : montants (investi, capital, accordé, restant dû, prochaine échéance) soumis à « view_amounts ».
const FICHE_MONEY = ["id_montant", "cap_capital", "fi_montant", "rb_crd", "rb_next_amt"];
function stripFicheAmounts(p0) {
  const { valos, ...p } = p0; // les valorisations sont entièrement soumises à « view_amounts »
  if (!p.fiche?.v) return p;
  const v = { ...p.fiche.v }; for (const k of FICHE_MONEY) delete v[k];
  return { ...p, fiche: { ...p.fiche, v } };
}
function sanitizeConfig(c) {
  const cfg = JSON.parse(JSON.stringify(c.cfg)); delete cfg.__v;
  const seesCodes = c.isAdmin || c.can("members") || c.can("externals");
  if (c.isExt) {
    const me = c.member;
    cfg.members = (cfg.members || []).filter(m => !m.external || m.id === me.id).map(m => m.id === me.id
      ? (({ code, ...rest }) => rest)(m)
      : { id: m.id, name: m.name, title: m.title, color: m.color, roleId: m.roleId, team: m.team });
    const granted = new Set(activeGrants(me).filter(g => g.kind === "node").map(g => g.id));
    cfg.funds = (cfg.funds || []).map(f => ({ ...f, url: "", tree: pruneTree(f.tree, granted) })).filter(f => f.tree.length);
    cfg.automations = [];
    if (cfg.fundRoot) cfg.fundRoot = { ...cfg.fundRoot, url: "" };
    if (cfg.onedrive) cfg.onedrive = { ...cfg.onedrive, rootUrl: "", perWorkflowRoot: {} };
    cfg.funds = cfg.funds.map(f => ({ ...f, positions: [] }));
  }
  if (!c.can("view_amounts")) cfg.funds = (cfg.funds || []).map(f => ({ ...f, positions: (f.positions || []).map(({ amount, outstanding, ...rest }) => stripFicheAmounts(rest)) }));
  if (!c.isExt && !seesCodes) {
    cfg.members = (cfg.members || []).map(m => { const x = { ...m }; delete x.code; if (m.external) delete x.grants; return x; });
  }
  return cfg;
}

// Échéanciers : les montants (capital, intérêts, conditions du prêt, montants payés) suivent le droit « view_amounts ».
function stripDeadlineAmounts(o) {
  const { amount, ...rest } = o;
  if (rest.rule?.type === "schedule") rest.rule = { ...rest.rule, items: (rest.rule.items || []).map(({ p, i, v, ...it }) => it), loan: {}, ca: [] };
  if (rest.done) rest.done = Object.fromEntries(Object.entries(rest.done).map(([k, v]) => [k, (({ paid, ...r }) => r)(v || {})]));
  return rest;
}
function keepDeadlineAmounts(data, existing) {
  if (!existing) return data;
  const out = { ...data, amount: existing.amount };
  if (existing.rule?.type === "schedule") out.rule = existing.rule;
  const done = { ...(out.done || {}) };
  for (const [k, v] of Object.entries(existing.done || {})) if (v && v.paid !== undefined) done[k] = { ...(done[k] || {}), paid: v.paid };
  out.done = done; return out;
}
export function snapshot(c, all, version) {
  const dmap = Object.fromEntries(all.dossiers.map(d => [d.id, d]));
  const dossiers = all.dossiers.filter(d => canSeeDossier(c, d)).map(d => hideAmounts(c, d));
  const tasks = all.tasks.filter(t => canSeeTask(c, t, id => dmap[id]));
  const visible = new Set(dossiers.map(d => d.id));
  const seenMeetings = new Set((all.meetings || []).filter(m => canSeeMeeting(c, m)).map(m => m.id));
  const activity = all.activity.filter(e => (e.dossierId ? visible.has(e.dossierId) : !c.isExt) && (!e.meetingId || seenMeetings.has(e.meetingId)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300);
  const seesCodes = c.isAdmin || c.can("members") || c.can("externals");
  return {
    version,
    config: sanitizeConfig(c),
    dossiers, tasks, activity,
    projects: c.isExt ? [] : (all.projects || []).filter(p => canSeeProject(c, p)),
    meetings: (all.meetings || []).filter(m => canSeeMeeting(c, m)),
    events: (all.events || []).map(e => eventView(c, e)).filter(Boolean),
    prefs: (all.prefs || []).filter(p => p.id === c.member?.id),
    deadlines: c.isExt ? [] : (all.deadlines || []).map(o => c.can("view_amounts") ? o : stripDeadlineAmounts(o)),
    claims: c.member ? [{ id: c.user.id, memberId: c.member.id, code: seesCodes ? (c.member.code || "") : "" }] : [],
    me: { userId: c.user.id, email: c.user.email, name: c.user.name, isAdmin: c.isAdmin, memberId: c.member?.id || null, external: c.isExt },
  };
}

// Conformité : seuls les vérificateurs valident un document ou la conformité d'un dossier.
function guardValidation(out, existing) {
  const old = Object.fromEntries((existing.docReqs || []).map(x => [x.id, x]));
  if (Array.isArray(out.docReqs)) out.docReqs = out.docReqs.map(x => x && x.status === "validated" && old[x.id]?.status !== "validated" ? { ...x, status: old[x.id]?.status || "received" } : x);
  if (out.compliance?.status === "validated" && existing.compliance?.status !== "validated") out.compliance = existing.compliance;
}
// Invités externes (accès « contribution ») : ils peuvent seulement déposer un lien sur un document demandé.
function extDocReqs(existing, data) {
  const inc = Object.fromEntries((Array.isArray(data.docReqs) ? data.docReqs : []).map(x => [x?.id, x]));
  return (existing.docReqs || []).map(x => { const n = inc[x.id]; if (!n || x.status === "validated" || n.status !== "received" || !/^https:\/\//i.test(String(n.url || ""))) return x;
    return { ...x, status: "received", url: String(n.url).slice(0, 2000), receivedAt: new Date().toISOString(), history: [...(x.history || []), ...(Array.isArray(n.history) ? n.history.slice(-1) : [])].slice(-30) }; });
}
// Commentaires de tâche : chacun ne modifie ou ne supprime que les siens (les administrateurs, tous).
function guardComments(c, data, existing) {
  const inc = Array.isArray(data.comments) ? data.comments : existing.comments || [];
  if (c.isAdmin) return inc;
  const mine = x => x && x.by === c.member?.id;
  const keep = (existing.comments || []).filter(x => !mine(x)); // ceux des autres restent tels quels
  return [...keep, ...inc.filter(mine)].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
// Agenda : réunions planifiées. Une réunion privée n'est visible en détail que de l'organisateur et des participants.
const evInvolved = (c, e) => c.isAdmin || [e.organizerId, e.createdBy, ...(e.attendees || [])].includes(c.member?.id);
export function eventView(c, e) {
  if (c.isExt) return null;
  if (!e.private || evInvolved(c, e)) return e;
  return { id: e.id, title: "Occupé", private: true, masked: true, date: e.date, start: e.start, end: e.end, allDay: e.allDay, organizerId: e.organizerId, attendees: e.attendees || [] };
}
const NOTIF_KEYS = ["assign", "mention", "stage", "compliance", "block", "deadline", "meeting", "project", "other"];
// Returns the document to store (possibly narrowed), or throws Denied.
// existing: current stored doc or null; dossierOf(id): stored dossier lookup (tasks only).
export function checkWrite(c, coll, id, data, existing, dossierOf) {
  if (coll === "ws") {
    if (id !== "config") throw new Denied();
    // Chaque rubrique des paramètres est protégée par le droit qui la gère ; le reste est conservé tel qu'enregistré.
    const stored = c.cfg, inc = data && typeof data === "object" ? data : {};
    const review = canReview(c) || c.can("settings");
    const SECTION = {
      general: "settings", notify: "settings", copilot: "settings", dashKpis: "settings", fundRoot: "funds",
      compliance: () => review, blockReasons: () => review, guide: () => c.can("guide") || c.can("settings"),
      roles: "roles", teams: "members",
      funds: "funds", fundView: "funds", fundStatuses: "funds", fundTypes: "funds", fundFields: "funds", fundTemplate: "funds",
      workflows: "workflows", customFields: "workflows", statuses: "workflows", priorities: "workflows", tags: "workflows", sectors: "workflows",
      vehicles: "workflows", deadlineTypes: "workflows", meetingTypes: "workflows", projectCategories: "workflows",
      automations: "automations", onedrive: "onedrive", customKpis: "kpis", tmm: "deadlines", meetingBoards: "meetings",
    };
    const allowed = k => c.isAdmin || (typeof SECTION[k] === "function" ? SECTION[k]() : SECTION[k] ? c.can(SECTION[k]) : c.can("settings"));
    const out = { ...stored }; let any = c.isAdmin;
    for (const k of Object.keys(inc)) {
      if (k === "members") continue;
      if (!allowed(k)) continue;
      any = true;
      if (k === "tmm" && !c.isAdmin) { if (Array.isArray(inc.tmm)) out.tmm = inc.tmm.filter(x => x && /^\d{4}-\d{2}$/.test(x.m)).map(x => ({ m: x.m, v: +x.v })); continue; }
      if (k === "customKpis" && !c.isAdmin) { if (Array.isArray(inc.customKpis)) out.customKpis = inc.customKpis.filter(x => x && typeof x === "object" && /^ck_/.test(String(x.id || ""))).slice(0, 200); continue; }
      if (k === "blockReasons") { if (Array.isArray(inc.blockReasons)) out.blockReasons = inc.blockReasons.map(String).slice(0, 40); continue; }
      out[k] = inc[k];
    }
    // Portefeuille : mise à jour des participations (positions) sans toucher à l'architecture des fonds.
    if (!allowed("funds") && c.can("portfolio") && Array.isArray(inc.funds)) {
      any = true;
      const byId = Object.fromEntries(inc.funds.map(f => [f.id, f]));
      out.funds = (stored.funds || []).map(f => byId[f.id] && Array.isArray(byId[f.id].positions) ? { ...f, positions: byId[f.id].positions } : f);
    }
    if (Array.isArray(out.funds) && out.funds !== stored.funds && !(c.isAdmin || c.can("funds") || c.can("stage_approve"))) {
      // seule une personne habilitée (Fonds ou validation des étapes) peut valider une valorisation
      const oldV = Object.fromEntries((stored.funds || []).flatMap(f => (f.positions || []).flatMap(p => (p.valos || []).map(v => [v.id, v]))));
      out.funds = out.funds.map(f => ({ ...f, positions: (f.positions || []).map(p => !Array.isArray(p.valos) ? p : { ...p, valos: p.valos.map(v => {
        const o = oldV[v.id]; if (v.status === "validated" && o?.status !== "validated") return { ...v, status: "draft", validatedBy: undefined, validatedAt: undefined };
        if (o?.status === "validated" && JSON.stringify(o) !== JSON.stringify(v)) return o; // une valorisation validée ne se modifie plus sans habilitation
        return v; }).concat(Object.values(oldV).filter(o => o.status === "validated" && o && !p.valos.some(v => v.id === o.id) && (stored.funds || []).some(sf => sf.id === f.id && (sf.positions || []).some(sp => sp.id === p.id && (sp.valos || []).some(x => x.id === o.id))))) }) }));
    }
    if (Array.isArray(out.funds) && out.funds !== stored.funds) { // tout élément du portefeuille reste rattaché à un dossier
      const before = Object.fromEntries((stored.funds || []).flatMap(f => (f.positions || []).map(p => [f.id + "|" + p.id, p])));
      for (const f of out.funds) for (const p of f.positions || []) {
        const o = before[f.id + "|" + p.id];
        if (!p.dossierId && (!o || o.dossierId)) throw new Denied(`« ${p.name || "Élément"} » doit être rattaché à un dossier.`);
      }
    }
    if (Array.isArray(out.funds) && out.funds !== stored.funds && !c.can("view_amounts")) {
      const old = Object.fromEntries((stored.funds || []).flatMap(f => (f.positions || []).map(p => [f.id + "|" + p.id, p])));
      out.funds = out.funds.map(f => ({ ...f, positions: (f.positions || []).map(p => { const o = old[f.id + "|" + p.id];
        const r = { ...p, amount: o?.amount ?? "", outstanding: o?.outstanding ?? "" };
        if (r.fiche) { const v = { ...(r.fiche.v || {}) }; for (const k of FICHE_MONEY) { if (o?.fiche?.v?.[k] !== undefined) v[k] = o.fiche.v[k]; else delete v[k]; } r.fiche = { ...r.fiche, v }; }
        if (o?.valos) r.valos = o.valos; else delete r.valos;
        return r; }) }));
    }
    // Membres : internes (droit Membres) et externes (droit Accès externes) ; les codes d'invitation ne sont jamais écrits par le navigateur.
    const canInt = c.isAdmin || c.can("members"), canExt = c.isAdmin || c.can("externals");
    if (canInt || canExt) any = true;
    const incMembers = Array.isArray(inc.members) ? inc.members : stored.members || [];
    const result = [];
    for (const s0 of stored.members || []) {
      const ok = s0.external ? canExt : canInt;
      const m = incMembers.find(x => x.id === s0.id);
      if (!ok) { result.push(s0); continue; }
      if (!m) continue;
      result.push({ ...m, code: s0.code ?? null, invitedAt: s0.invitedAt ?? null });
    }
    for (const m of incMembers) {
      if ((stored.members || []).some(s0 => s0.id === m.id)) continue;
      if (m.external ? canExt : canInt) result.push({ ...m, code: null, invitedAt: null });
    }
    out.members = result;
    if (!any) throw new Denied("Seuls les administrateurs peuvent modifier les paramètres.");
    return out;
  }
  if (coll === "dossiers") {
    if (!existing) {
      if (c.isExt || !c.can("dossier_create")) throw new Denied("Votre rôle ne permet pas de créer des dossiers.");
      return data;
    }
    if (!canSeeDossier(c, existing)) throw new Denied();
    if (c.isExt) {
      if (grantFor(c, "dossier", id)?.level !== "contribute") throw new Denied("Votre accès à ce dossier est en lecture seule.");
      return { ...existing, docs: Array.isArray(data.docs) ? data.docs : existing.docs, docReqs: extDocReqs(existing, data) };
    }
    if (!(canEditDossier(c, existing) || c.can("stage_advance") || c.can("onedrive") || c.can("dossier_delete") || c.can("stage_approve"))) {
      if (canReview(c)) return { ...existing, docReqs: Array.isArray(data.docReqs) ? data.docReqs : existing.docReqs, compliance: data.compliance ?? existing.compliance };
      throw new Denied("Votre rôle ne permet pas de modifier ce dossier.");
    }
    const out = { ...data };
    if (!canReview(c)) guardValidation(out, existing);
    if (!c.can("view_amounts")) {
      out.amount = existing.amount;
      out.custom = { ...(data.custom || {}) };
      for (const k of currencyFields(c.cfg)) { if (existing.custom && k in existing.custom) out.custom[k] = existing.custom[k]; else delete out.custom[k]; }
    }
    return out;
  }
  if (coll === "tasks") {
    if (!existing) {
      if (c.isExt || !c.can("task_create")) throw new Denied("Votre rôle ne permet pas de créer des tâches.");
      return data;
    }
    if (!canSeeTask(c, existing, dossierOf)) throw new Denied();
    if (c.isExt) {
      const out = { ...existing, comments: guardComments(c, data, existing) };
      if ((existing.assignees || []).includes(c.member.id)) Object.assign(out, { status: data.status, checklist: data.checklist, completedAt: data.completedAt });
      return out;
    }
    return { ...data, comments: guardComments(c, data, existing) };
  }
  if (coll === "events") {
    if (c.isExt || !c.member) throw new Denied("Seuls les membres de l'équipe peuvent planifier des réunions.");
    if (!existing) return { ...data, createdBy: c.member.id, organizerId: data.organizerId || c.member.id };
    if (c.isAdmin || existing.organizerId === c.member.id || existing.createdBy === c.member.id) return { ...data, createdBy: existing.createdBy };
    if ((existing.attendees || []).includes(c.member.id)) {
      const r = data.responses && typeof data.responses === "object" ? data.responses[c.member.id] : undefined;
      return { ...existing, responses: { ...(existing.responses || {}), ...(r ? { [c.member.id]: String(r).slice(0, 20) } : {}) }, crId: data.crId ?? existing.crId };
    }
    throw new Denied("Seul l'organisateur peut modifier cette réunion.");
  }
  if (coll === "deadlines") {
    if (c.isExt) throw new Denied();
    if (c.isAdmin || c.can("deadlines")) { if (c.isAdmin || c.can("view_amounts")) return { ...data }; if (!existing && data.rule?.type === "schedule" && (data.rule.items || []).some(it => it.p || it.i)) throw new Denied("Votre rôle ne gère pas les montants."); return keepDeadlineAmounts({ ...data }, existing); }
    if (!existing) throw new Denied("Votre rôle ne permet pas de créer des échéances.");
    if ((existing.owners || []).includes(c.member?.id)) { const out = { ...existing, done: data.done || existing.done }; return c.can("view_amounts") ? out : keepDeadlineAmounts(out, existing); }
    throw new Denied("Seuls les responsables de cette échéance peuvent la mettre à jour.");
  }
  if (coll === "meetings") {
    if (c.isExt) throw new Denied();
    if (!existing) {
      if (!(c.isAdmin || c.can("meetings"))) throw new Denied("Votre rôle ne permet pas de rédiger des comptes rendus.");
      return { ...data, createdBy: c.member?.id || data.createdBy || null };
    }
    if (!canEditMeeting(c, existing)) throw new Denied("Vous ne pouvez pas modifier ce compte rendu.");
    return { ...data, createdBy: existing.createdBy };
  }
  if (coll === "projects") {
    if (c.isExt) throw new Denied();
    if (c.isAdmin || c.can("projects")) return data;
    if (!existing) throw new Denied("Votre rôle ne permet pas de créer des projets.");
    const mid = c.member?.id;
    if (mid && (existing.ownerId === mid || (existing.members || []).includes(mid)))
      return { ...existing, status: data.status, health: data.health, progress: data.progress, nextStep: data.nextStep, description: data.description, url: data.url, milestones: data.milestones, docs: Array.isArray(data.docs) ? data.docs : existing.docs, odNames: data.odNames ?? existing.odNames, updatedAt: data.updatedAt };
    throw new Denied("Seuls le responsable et l'équipe du projet peuvent le mettre à jour.");
  }
  if (coll === "prefs") {
    if (!c.member || (id !== c.member.id && !c.isAdmin)) throw new Denied("Vous ne pouvez modifier que vos propres préférences.");
    const pick = o => Object.fromEntries(NOTIF_KEYS.map(k => [k, !!(o || {})[k]]));
    return { inapp: pick(data.inapp), reminders: data.reminders !== false, email: { on: !!data.email?.on, kinds: pick(data.email?.kinds) }, updatedAt: new Date().toISOString() };
  }
  if (coll === "activity") {
    if (existing) throw new Denied();
    return { ...data, by: c.member?.id || null };
  }
  throw new Denied();
}

export function checkDelete(c, coll, existing, dossierOf) {
  if (coll === "prefs") { if (!c.member || (existing && existing.id !== c.member.id && !c.isAdmin)) throw new Denied(); return; }
  if (coll === "deadlines") { if (c.isExt || !(c.isAdmin || c.can("deadlines"))) throw new Denied("Votre rôle ne permet pas de supprimer des échéances."); return; }
  if (coll === "events") { if (c.isExt || !(c.isAdmin || existing?.organizerId === c.member?.id || existing?.createdBy === c.member?.id)) throw new Denied("Seul l'organisateur peut supprimer cette réunion."); return; }
  if (coll === "meetings") { if (c.isExt || !(c.isAdmin || (c.can("meetings") && canSeeMeeting(c, existing)))) throw new Denied("Votre rôle ne permet pas de supprimer ce compte rendu."); return; }
  if (coll === "projects") { if (c.isExt || !(c.isAdmin || c.can("projects"))) throw new Denied("Votre rôle ne permet pas de supprimer des projets."); return; }
  if (coll === "dossiers") { if (c.isExt || !c.can("dossier_delete")) throw new Denied("Votre rôle ne permet pas de supprimer des dossiers."); return; }
  if (coll === "tasks") {
    if (!existing) return;
    if (c.isExt) throw new Denied();
    const d = existing.dossierId && dossierOf(existing.dossierId);
    if (c.can("task_edit_all") || existing.createdBy === c.member?.id || (d && d.ownerId === c.member?.id)) return;
    throw new Denied("Seul le créateur de la tâche ou un responsable peut la supprimer.");
  }
  throw new Denied();
}
