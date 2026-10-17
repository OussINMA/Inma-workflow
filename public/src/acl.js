// Access control: what each signed-in person may read and write. Pure functions (no I/O).
export const ALL_PERMS = ["settings", "roles", "members", "workflows", "automations", "view_all", "view_amounts", "dossier_create", "dossier_edit_all",
  "dossier_delete", "stage_advance", "stage_approve", "task_create", "task_edit_all", "onedrive", "funds", "externals", "export", "deadlines", "projects", "meetings", "ai"];
const CONFIG_PERMS = ["settings", "roles", "members", "workflows", "automations", "onedrive", "funds", "externals", "export"];
const today = () => new Date().toISOString().slice(0, 10);

export class Denied extends Error { constructor(msg) { super(msg || "Action non autorisée pour votre rôle."); this.status = 403; } }

export function context(user, cfg, adminEmails) {
  const isAdmin = adminEmails.includes(String(user.email || "").toLowerCase());
  const member = user.member_id ? (cfg.members || []).find(m => m.id === user.member_id) || null : null;
  const role = (cfg.roles || []).find(r => r.id === (member ? member.roleId : cfg.general?.defaultRoleId));
  const perms = isAdmin ? Object.fromEntries(ALL_PERMS.map(p => [p, true])) : { ...(role?.perms || {}) };
  const isExt = !isAdmin && !!member?.external;
  return { cfg, user, member, perms, isAdmin, isExt, can: k => !!perms[k] };
}

export const activeGrants = m => (m?.grants || []).filter(g => !g.until || g.until >= today());
const grantFor = (c, kind, id) => activeGrants(c.member).find(g => g.kind === kind && g.id === id) || null;

export function canSeeMeeting(c, m) {
  if (!m || c.isExt) return false;
  if (c.isAdmin) return true;
  const id = c.member?.id; if (!id) return false;
  if (m.createdBy === id || m.secretaryId === id || (m.participants || []).includes(id)) return true;
  if (!m.visibility || m.visibility === "all") return true;
  if (m.visibility === "roles") return (m.roles || []).includes(c.member.roleId);
  return false;
}
const canEditMeeting = (c, m) => canSeeMeeting(c, m) && (c.isAdmin || c.can("meetings") || m.createdBy === c.member?.id || m.secretaryId === c.member?.id);
export function canSeeDossier(c, d) {
  if (!d) return false;
  if (c.isExt) return !!grantFor(c, "dossier", d.id);
  if (c.can("view_all")) return true;
  const m = c.member;
  return !!m && (d.ownerId === m.id || (d.members || []).includes(m.id));
}
function canEditDossier(c, d) {
  if (c.isExt) return false;
  if (c.can("dossier_edit_all")) return true;
  const m = c.member;
  return !!m && (d.ownerId === m.id || (d.members || []).includes(m.id));
}
function canSeeTask(c, t, dossierOf) {
  if (!c.isExt && c.can("view_all")) return true;
  const m = c.member;
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
  if (!c.can("view_amounts")) cfg.funds = (cfg.funds || []).map(f => ({ ...f, positions: (f.positions || []).map(({ amount, outstanding, ...rest }) => rest) })); else if (!seesCodes) {
    cfg.members = (cfg.members || []).map(m => { const x = { ...m }; delete x.code; if (m.external) delete x.grants; return x; });
  }
  return cfg;
}

// Échéanciers : les montants (capital, intérêts, conditions du prêt, montants payés) suivent le droit « view_amounts ».
function stripDeadlineAmounts(o) {
  const { amount, ...rest } = o;
  if (rest.rule?.type === "schedule") rest.rule = { ...rest.rule, items: (rest.rule.items || []).map(({ p, i, ...it }) => it), loan: {} };
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
  const activity = all.activity.filter(e => e.dossierId ? visible.has(e.dossierId) : !c.isExt)
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300);
  const seesCodes = c.isAdmin || c.can("members") || c.can("externals");
  return {
    version,
    config: sanitizeConfig(c),
    dossiers, tasks, activity,
    projects: c.isExt ? [] : (all.projects || []),
    meetings: (all.meetings || []).filter(m => canSeeMeeting(c, m)),
    deadlines: c.isExt ? [] : (all.deadlines || []).map(o => c.can("view_amounts") ? o : stripDeadlineAmounts(o)),
    claims: c.member ? [{ id: c.user.id, memberId: c.member.id, code: seesCodes ? (c.member.code || "") : "" }] : [],
    me: { userId: c.user.id, email: c.user.email, name: c.user.name, isAdmin: c.isAdmin, memberId: c.member?.id || null, external: c.isExt },
  };
}

// Returns the document to store (possibly narrowed), or throws Denied.
// existing: current stored doc or null; dossierOf(id): stored dossier lookup (tasks only).
export function checkWrite(c, coll, id, data, existing, dossierOf) {
  if (coll === "ws") {
    if (id !== "config") throw new Denied();
    if (!c.isAdmin && !CONFIG_PERMS.some(p => c.can(p))) throw new Denied("Seuls les administrateurs peuvent modifier les paramètres.");
    const stored = c.cfg, inc = { ...data };
    if (!c.isAdmin && !c.can("roles")) inc.roles = stored.roles;
    const canInt = c.isAdmin || c.can("members"), canExt = c.isAdmin || c.can("externals");
    const incMembers = Array.isArray(inc.members) ? inc.members : stored.members || [];
    const result = [];
    for (const s of stored.members || []) {
      const allowed = s.external ? canExt : canInt;
      const m = incMembers.find(x => x.id === s.id);
      if (!allowed) { result.push(s); continue; }
      if (!m) continue;
      result.push({ ...m, code: s.code ?? null, invitedAt: s.invitedAt ?? null });
    }
    for (const m of incMembers) {
      if ((stored.members || []).some(s => s.id === m.id)) continue;
      if (m.external ? canExt : canInt) result.push({ ...m, code: null, invitedAt: null });
    }
    inc.members = result;
    if (!c.isAdmin && !c.can("funds")) { inc.funds = stored.funds; inc.fundRoot = stored.fundRoot; }
    else if (!c.can("view_amounts") && Array.isArray(inc.funds)) {
      const old = Object.fromEntries((stored.funds || []).flatMap(f => (f.positions || []).map(p => [f.id + "|" + p.id, p])));
      inc.funds = inc.funds.map(f => ({ ...f, positions: (f.positions || []).map(p => { const o = old[f.id + "|" + p.id]; return { ...p, amount: o?.amount ?? "", outstanding: o?.outstanding ?? "" }; }) }));
    }
    if (!c.isAdmin && !c.can("workflows")) { inc.workflows = stored.workflows; inc.customFields = stored.customFields; }
    if (!c.isAdmin && !c.can("automations")) inc.automations = stored.automations;
    return inc;
  }
  if (coll === "dossiers") {
    if (!existing) {
      if (c.isExt || !c.can("dossier_create")) throw new Denied("Votre rôle ne permet pas de créer des dossiers.");
      return data;
    }
    if (!canSeeDossier(c, existing)) throw new Denied();
    if (c.isExt) {
      if (grantFor(c, "dossier", id)?.level !== "contribute") throw new Denied("Votre accès à ce dossier est en lecture seule.");
      return { ...existing, docs: Array.isArray(data.docs) ? data.docs : existing.docs };
    }
    if (!(canEditDossier(c, existing) || c.can("stage_advance") || c.can("onedrive") || c.can("dossier_delete") || c.can("stage_approve")))
      throw new Denied("Votre rôle ne permet pas de modifier ce dossier.");
    const out = { ...data };
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
      const out = { ...existing, comments: Array.isArray(data.comments) ? data.comments : existing.comments };
      if ((existing.assignees || []).includes(c.member.id)) Object.assign(out, { status: data.status, checklist: data.checklist, completedAt: data.completedAt });
      return out;
    }
    return data;
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
      return { ...existing, status: data.status, health: data.health, progress: data.progress, nextStep: data.nextStep, description: data.description, url: data.url, milestones: data.milestones, updatedAt: data.updatedAt };
    throw new Denied("Seuls le responsable et l'équipe du projet peuvent le mettre à jour.");
  }
  if (coll === "activity") {
    if (existing) throw new Denied();
    return { ...data, by: c.member?.id || null };
  }
  throw new Denied();
}

export function checkDelete(c, coll, existing, dossierOf) {
  if (coll === "deadlines") { if (c.isExt || !(c.isAdmin || c.can("deadlines"))) throw new Denied("Votre rôle ne permet pas de supprimer des échéances."); return; }
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
