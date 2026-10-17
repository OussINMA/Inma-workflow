// INMA Workflow — Cloudflare Worker (free plan): API, sign-in, invitations. Static files are served from ./public.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { context, snapshot, checkWrite, checkDelete, Denied, activeGrants } from "./acl.js";
import { sendMail, inviteEmail, otpEmail, mailMode } from "./mail.js";
import seedConfig from "../seed/config.json";
import seedDemo from "../seed/demo.json";

const COOKIE = "inma_sid";
const enc = new TextEncoder();
const now = () => new Date().toISOString();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
const normEmail = e => String(e || "").trim().toLowerCase();
const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const adminList = env => String(env.ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
const appName = env => env.APP_NAME || "INMA Workflow";

/* ---------------- crypto helpers ---------------- */
function b64u(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
const fromB64u = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg))));
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function randInt(n) { const a = new Uint32Array(1); const lim = Math.floor(0x100000000 / n) * n; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % n; }
const rid = p => p + b64u(crypto.getRandomValues(new Uint8Array(9)));
function code8() { const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 8; i++) s += A[randInt(A.length)]; return s; }

/* ---------------- database ---------------- */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("create table if not exists docs (coll text not null, id text not null, data text not null, version integer not null default 1, updated_at text, updated_by text, primary key (coll, id))"),
    env.DB.prepare("create table if not exists users (id text primary key, email text unique not null, name text, ms_oid text, member_id text, created_at text, last_login text)"),
    env.DB.prepare("create table if not exists invites (code text primary key, member_id text not null, email text not null, expires_at text not null, used_at text, created_by text, created_at text)"),
    env.DB.prepare("create table if not exists otps (email text primary key, code_hash text not null, expires_at text not null, attempts integer not null default 0, sent_at text not null)"),
    env.DB.prepare("create table if not exists outbox (id integer primary key autoincrement, to_addr text, subject text, body text, created_at text)"),
    env.DB.prepare("create table if not exists meta (k text primary key, v integer not null)"),
    env.DB.prepare("create table if not exists settings (k text primary key, v text not null)"),
    env.DB.prepare("insert or ignore into meta (k, v) values ('version', 1)"),
  ]);
  schemaReady = true;
}
const parseDoc = r => ({ ...JSON.parse(r.data), id: r.id, __v: r.version });
async function getDoc(env, coll, id) { const r = await env.DB.prepare("select id, data, version from docs where coll = ?1 and id = ?2").bind(coll, id).first(); return r ? parseDoc(r) : null; }
async function getVersion(env) { return (await env.DB.prepare("select v from meta where k = 'version'").first())?.v || 0; }
const bumpStmt = env => env.DB.prepare("update meta set v = v + 1 where k = 'version'");
function putStmt(env, coll, id, data, by) {
  const clean = { ...data, id }; delete clean.__v;
  return env.DB.prepare("insert into docs (coll, id, data, version, updated_at, updated_by) values (?1, ?2, ?3, 1, ?4, ?5) on conflict (coll, id) do update set data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
    .bind(coll, id, JSON.stringify(clean), now(), by || null);
}
async function putDoc(env, coll, id, data, by) { await env.DB.batch([putStmt(env, coll, id, data, by), bumpStmt(env)]); cache.v = -1; }

// Whole dataset, cached per isolate and reloaded only when the version changes (keeps free-plan row reads low).
const cache = { v: -1, all: null };
async function loadAll(env) {
  const v = await getVersion(env);
  if (cache.v === v && cache.all) return { all: cache.all, v };
  const { results } = await env.DB.prepare("select coll, id, data, version from docs").all();
  const all = { cfg: null, dossiers: [], tasks: [], activity: [] };
  for (const r of results) { const d = parseDoc(r); if (r.coll === "ws" && r.id === "config") all.cfg = d; else if (all[r.coll]) all[r.coll].push(d); }
  cache.v = v; cache.all = all;
  return { all, v };
}
async function getConfig(env, origin) {
  let cfg = await getDoc(env, "ws", "config");
  if (cfg) return cfg;
  cfg = JSON.parse(JSON.stringify(seedConfig));
  const adminMail = normEmail(env.SEED_OUSSEMA_EMAIL || adminList(env)[0]);
  const o = (cfg.members || []).find(m => m.id === "m_oussema"); if (o && adminMail) o.email = adminMail;
  cfg.general = { ...(cfg.general || {}), appUrl: env.APP_URL || origin, appName: appName(env) };
  const stmts = [putStmt(env, "ws", "config", cfg, "seed")];
  if (String(env.SEED_DEMO) === "true") for (const coll of ["dossiers", "tasks", "activity"]) for (const d of seedDemo[coll] || []) stmts.push(putStmt(env, coll, d.id, d, "seed"));
  stmts.push(bumpStmt(env));
  await env.DB.batch(stmts); cache.v = -1;
  return { ...cfg, id: "config" };
}

/* ---------------- sessions & users ---------------- */
// Session-signing key: SESSION_SECRET if provided, otherwise generated once and kept in the database (nothing to configure).
let SECRET = null;
async function secretOf(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (SECRET) return SECRET;
  let row = await env.DB.prepare("select v from settings where k = 'session_secret'").first();
  if (!row) {
    await env.DB.prepare("insert or ignore into settings (k, v) values ('session_secret', ?1)").bind(b64u(crypto.getRandomValues(new Uint8Array(48)))).run();
    row = await env.DB.prepare("select v from settings where k = 'session_secret'").first();
  }
  return (SECRET = row.v);
}
async function sessionCookie(env, user, secure) {
  const days = +(env.SESSION_DAYS || 14);
  const body = b64u(enc.encode(JSON.stringify({ uid: user.id, exp: Date.now() + days * 864e5 })));
  return `${COOKIE}=${body}.${await hmac(await secretOf(env), body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure ? "; Secure" : ""}`;
}
async function currentUser(env, req) {
  const raw = (req.headers.get("Cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [body, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!body || !sig || !safeEq(sig, await hmac(await secretOf(env), body))) return null;
  let p; try { p = JSON.parse(fromB64u(body)); } catch { return null; }
  if (!(p.exp > Date.now())) return null;
  return await env.DB.prepare("select * from users where id = ?1").bind(p.uid).first();
}
const boundUser = (env, memberId) => env.DB.prepare("select * from users where member_id = ?1").bind(memberId).first();
async function upsertUser(env, email, name, oid, cfg) {
  email = normEmail(email);
  let u = await env.DB.prepare("select * from users where email = ?1").bind(email).first();
  if (!u) {
    u = { id: rid("u_"), email, name: name || email, ms_oid: oid || null, member_id: null };
    await env.DB.prepare("insert into users (id, email, name, ms_oid, member_id, created_at, last_login) values (?1, ?2, ?3, ?4, null, ?5, ?5)").bind(u.id, email, u.name, u.ms_oid, now()).run();
  } else {
    await env.DB.prepare("update users set last_login = ?1, name = coalesce(?2, name), ms_oid = coalesce(?3, ms_oid) where id = ?4").bind(now(), name || null, oid || null, u.id).run();
  }
  if (!u.member_id) {
    for (const m of cfg.members || []) {
      if (normEmail(m.email) !== email) continue;
      if (await boundUser(env, m.id)) continue;
      await env.DB.prepare("update users set member_id = ?1 where id = ?2").bind(m.id, u.id).run(); u.member_id = m.id; break;
    }
  }
  return u;
}
async function bind(env, user, memberId) {
  await env.DB.batch([
    env.DB.prepare("update users set member_id = null where member_id = ?1 and id != ?2").bind(memberId, user.id),
    env.DB.prepare("update users set member_id = ?1 where id = ?2").bind(memberId, user.id),
    bumpStmt(env),
  ]);
  cache.v = -1;
}

/* ---------------- Microsoft sign-in ---------------- */
let jwks = null;
async function verifyMsIdToken(env, idToken) {
  jwks = jwks || createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/discovery/v2.0/keys`));
  const { payload } = await jwtVerify(idToken, jwks, { issuer: `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/v2.0`, audience: env.AZURE_CLIENT_ID });
  if (payload.tid !== env.AZURE_TENANT_ID) throw new Error("Compte d'une autre organisation.");
  const email = normEmail(payload.preferred_username || payload.email || payload.upn);
  if (!email) throw new Error("Adresse e-mail absente du compte Microsoft.");
  return { email, name: payload.name, oid: payload.oid };
}

/* ---------------- request handling ---------------- */
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
const OTP_TTL = 10 * 60_000;

async function api(req, env, url) {
  const p = url.pathname, method = req.method, origin = url.origin, secure = url.protocol === "https:";
  if (method !== "GET" && req.headers.get("X-INMA") !== "1") return fail(400, "Requête refusée.");
  await ensureSchema(env);
  const mailReady = mailMode(env) === "graph", dev = env.DEV_MODE === "true";
  const appUrl = (env.APP_URL || origin).replace(/\/+$/, "");

  if (p === "/api/public-config") {
    await getConfig(env, origin);
    return json({ appName: appName(env), appUrl, clientId: env.AZURE_CLIENT_ID || "", tenantId: env.AZURE_TENANT_ID || "", msEnabled: !!(env.AZURE_CLIENT_ID && env.AZURE_TENANT_ID), dev, mailReady, adminPassword: !!env.ADMIN_PASSWORD });
  }
  if (p === "/api/auth/microsoft" && method === "POST") {
    if (!env.AZURE_CLIENT_ID || !env.AZURE_TENANT_ID) return fail(400, "Connexion Microsoft non configurée.");
    let info; try { info = await verifyMsIdToken(env, String((await readJson(req)).idToken || "")); } catch (e) { return fail(401, "Connexion Microsoft refusée : " + e.message); }
    const u = await upsertUser(env, info.email, info.name, info.oid, await getConfig(env, origin));
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u, secure) });
  }
  if (p === "/api/auth/email/start" && method === "POST") {
    const email = normEmail((await readJson(req)).email);
    if (!isEmail(email)) return fail(400, "Adresse e-mail invalide.");
    if (!mailReady && !dev) return fail(503, "L'envoi des codes par e-mail n'est pas encore configuré. Connectez-vous avec Microsoft, avec votre code d'invitation ou avec le mot de passe administrateur.");
    const prev = await env.DB.prepare("select sent_at from otps where email = ?1").bind(email).first();
    if (prev && Date.now() - Date.parse(prev.sent_at) < 45_000) return json({ ok: true, wait: true });
    const cfg = await getConfig(env, origin);
    if (adminList(env).includes(email) || (cfg.members || []).some(m => normEmail(m.email) === email)) {
      const code = String(randInt(1_000_000)).padStart(6, "0");
      await env.DB.prepare("insert into otps (email, code_hash, expires_at, attempts, sent_at) values (?1, ?2, ?3, 0, ?4) on conflict (email) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at")
        .bind(email, await hmac(await secretOf(env), email + ":" + code), new Date(Date.now() + OTP_TTL).toISOString(), now()).run();
      await sendMail(env, { to: email, ...otpEmail({ code, appName: appName(env) }) });
    }
    return json({ ok: true }); // same answer whether or not the address is known
  }
  if (p === "/api/auth/email/verify" && method === "POST") {
    const b = await readJson(req); const email = normEmail(b.email), code = String(b.code || "").replace(/\D/g, "");
    const row = await env.DB.prepare("select * from otps where email = ?1").bind(email).first();
    if (!row || Date.parse(row.expires_at) < Date.now()) return fail(400, "Code incorrect ou expiré : demandez-en un nouveau.");
    if (row.attempts >= 5) return fail(429, "Trop d'essais : demandez un nouveau code.");
    if (!safeEq(row.code_hash, await hmac(await secretOf(env), email + ":" + code))) { await env.DB.prepare("update otps set attempts = attempts + 1 where email = ?1").bind(email).run(); return fail(400, "Code incorrect."); }
    await env.DB.prepare("delete from otps where email = ?1").bind(email).run();
    const u = await upsertUser(env, email, null, null, await getConfig(env, origin));
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u, secure) });
  }
  if (p === "/api/auth/invite" && method === "POST") {
    const code = String((await readJson(req)).code || "").trim().toUpperCase();
    const inv = await env.DB.prepare("select * from invites where code = ?1").bind(code).first();
    if (!inv || Date.parse(inv.expires_at) < Date.now()) return fail(400, "Code d'invitation invalide ou expiré. Demandez une nouvelle invitation ou un code par e-mail.");
    if (inv.used_at) return fail(400, "Ce code a déjà été utilisé. Connectez-vous avec un code reçu par e-mail ou avec Microsoft.");
    const cfg = await getConfig(env, origin);
    if (!(cfg.members || []).some(m => m.id === inv.member_id)) return fail(400, "Cette invitation n'est plus valable.");
    const u = await upsertUser(env, inv.email, null, null, cfg);
    await bind(env, u, inv.member_id);
    await env.DB.prepare("update invites set used_at = ?1 where code = ?2").bind(now(), code).run();
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u, secure) });
  }
  if (p === "/api/auth/admin" && method === "POST") {
    if (!env.ADMIN_PASSWORD) return fail(400, "Connexion par mot de passe désactivée.");
    const b = await readJson(req); const email = normEmail(b.email);
    const key = "admin:" + email;
    const lock = await env.DB.prepare("select * from otps where email = ?1").bind(key).first();
    if (lock && lock.attempts >= 8 && Date.parse(lock.expires_at) > Date.now()) return fail(429, "Trop d'essais : réessayez dans 15 minutes.");
    const sec = await secretOf(env);
    const ok = adminList(env).includes(email) && safeEq(await hmac(sec, String(b.password || "")), await hmac(sec, String(env.ADMIN_PASSWORD)));
    if (!ok) {
      await env.DB.prepare("insert into otps (email, code_hash, expires_at, attempts, sent_at) values (?1, '-', ?2, 1, ?3) on conflict (email) do update set attempts = case when otps.expires_at < ?3 then 1 else otps.attempts + 1 end, expires_at = ?2")
        .bind(key, new Date(Date.now() + 15 * 60_000).toISOString(), now()).run();
      return fail(401, "E-mail ou mot de passe incorrect.");
    }
    await env.DB.prepare("delete from otps where email = ?1").bind(key).run();
    const u = await upsertUser(env, email, null, null, await getConfig(env, origin));
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u, secure) });
  }
  if (p === "/api/auth/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}` });
  if (p === "/api/dev/outbox" && env.DEV_MODE === "true") return json((await env.DB.prepare("select * from outbox order by id desc limit 20").all()).results);

  // ---- signed-in routes ----
  const user = await currentUser(env, req);
  if (!user) return fail(401, "Session expirée : reconnectez-vous.");
  if (p === "/api/version") return json({ v: await getVersion(env) });
  await getConfig(env, origin);
  const { all, v } = await loadAll(env);
  const c = context(user, all.cfg, adminList(env));
  if (p === "/api/me") return json(snapshot(c, { dossiers: [], tasks: [], activity: [] }, v).me);
  if (p === "/api/snapshot") return json(snapshot(c, all, v));

  const doc = p.match(/^\/api\/docs\/([\w-]+)\/([\w.:@+~-]{1,200})$/);
  if (doc && (method === "PUT" || method === "DELETE")) {
    const [, coll, id] = doc;
    if (!["ws", "dossiers", "tasks", "activity", "claims"].includes(coll)) return fail(400, "Document inconnu.");
    const dossierOf = did => all.dossiers.find(d => d.id === did);
    if (coll === "claims") {
      if (method === "DELETE") {
        if (!(id === user.id || c.isAdmin || c.can("members") || c.can("externals"))) throw new Denied();
        await env.DB.batch([env.DB.prepare("update users set member_id = null where id = ?1").bind(id), bumpStmt(env)]); cache.v = -1;
        return json({ ok: true });
      }
      if (id !== user.id) throw new Denied();
      const data = (await readJson(req)).data || {};
      const m = (all.cfg.members || []).find(x => x.id === data.memberId);
      if (!m) return fail(400, "Profil introuvable.");
      if (!(c.isAdmin || (m.code && String(data.code || "").toUpperCase() === String(m.code).toUpperCase()))) return fail(403, "Code incorrect.");
      const other = await boundUser(env, m.id);
      if (other && other.id !== user.id && !c.isAdmin) return fail(409, "Ce profil est déjà associé à un autre compte.");
      await bind(env, user, m.id); return json({ ok: true });
    }
    const existing = coll === "ws" ? all.cfg : await getDoc(env, coll, id);
    if (method === "DELETE") {
      checkDelete(c, coll, existing, dossierOf);
      await env.DB.batch([env.DB.prepare("delete from docs where coll = ?1 and id = ?2").bind(coll, id), bumpStmt(env)]); cache.v = -1;
      return json({ ok: true });
    }
    const data = (await readJson(req)).data;
    if (!data || typeof data !== "object") return fail(400, "Contenu manquant.");
    const stored = checkWrite(c, coll, id, data, existing, dossierOf);
    await putDoc(env, coll, id, stored, user.id);
    if (coll === "activity" && Math.random() < 0.05) {
      await env.DB.prepare("delete from docs where coll = 'activity' and id in (select id from docs where coll = 'activity' order by updated_at desc limit -1 offset 500)").run();
    }
    return json({ ok: true });
  }

  const inv = p.match(/^\/api\/invite\/([\w-]+)$/);
  if (inv && method === "POST") {
    const cfg = JSON.parse(JSON.stringify(all.cfg)); delete cfg.__v;
    const m = (cfg.members || []).find(x => x.id === inv[1]);
    if (!m) return fail(404, "Membre introuvable.");
    if (!(c.isAdmin || (m.external ? c.can("externals") : c.can("members")))) throw new Denied("Votre rôle ne permet pas d'envoyer cette invitation.");
    const email = normEmail(m.email);
    if (!isEmail(email)) return fail(400, `Renseignez d'abord l'e-mail de ${m.name}.`);
    const code = code8();
    m.code = code; m.invitedAt = now();
    await env.DB.batch([
      env.DB.prepare("insert into invites (code, member_id, email, expires_at, created_by, created_at) values (?1, ?2, ?3, ?4, ?5, ?6)").bind(code, m.id, email, new Date(Date.now() + 14 * 864e5).toISOString(), user.id, now()),
      putStmt(env, "ws", "config", cfg, user.id), bumpStmt(env),
    ]);
    cache.v = -1;
    const items = [];
    if (m.external) for (const g of activeGrants(m)) {
      if (g.kind === "dossier") { const d = all.dossiers.find(x => x.id === g.id); if (d) items.push(`${d.code} · ${d.name}`); }
      else { const f = (cfg.funds || []).find(x => x.id === g.fundId); let name = null; (function walk(ns) { for (const n of ns || []) { if (n.id === g.id) name = n.name; walk(n.children); } })(f?.tree); if (f && name) items.push(`${f.name} › ${name}`); }
    }
    const role = (cfg.roles || []).find(r => r.id === m.roleId);
    try {
      await sendMail(env, { to: email, ...inviteEmail({ name: m.name, inviter: c.member?.name || user.name || "L'équipe INMA", roleLabel: role?.name, code, appUrl, appName: appName(env), external: !!m.external, items }) });
      return json({ ok: true, sentTo: email, code, mode: env.DEV_MODE === "true" ? "dev" : mailMode(env) });
    } catch (e) { return fail(502, "Invitation créée mais e-mail non envoyé : " + e.message, { code }); }
  }
  return fail(404, "Adresse inconnue.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(req, env, url); }
      catch (e) { if (e.status) return fail(e.status, e.message); console.error(e); return fail(500, "Erreur serveur : " + e.message); }
    }
    return env.ASSETS.fetch(req);
  },
};
