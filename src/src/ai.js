// Assistant IA intégré : relaie la conversation vers un modèle de langage.
// Les données envoyées sont préparées par le navigateur à partir de ce que l'utilisateur a le droit de voir
// (instantané filtré par acl.js) ; le serveur vérifie l'accès, limite l'usage et appelle le fournisseur.
const DEFAULT_WORKERS_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

export function aiProvider(env) {
  const forced = String(env.AI_PROVIDER || "").toLowerCase();
  const azure = env.AZURE_OPENAI_ENDPOINT && env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_DEPLOYMENT;
  const openai = env.AI_API_URL && env.AI_API_KEY;
  if (forced === "off" || forced === "aucun") return { id: "off", ready: false };
  if ((forced === "azure" || (!forced && azure)) && azure) return { id: "azure", ready: true, model: env.AZURE_OPENAI_DEPLOYMENT, label: "Azure OpenAI (Microsoft)", budget: 200000 };
  if ((forced === "openai" || (!forced && openai)) && openai) return { id: "openai", ready: true, model: env.AI_MODEL || "", label: "API compatible OpenAI", budget: +env.AI_CONTEXT_CHARS || 200000 };
  if (env.AI) return { id: "workers", ready: true, model: env.AI_MODEL || DEFAULT_WORKERS_MODEL, label: "Cloudflare Workers AI", budget: +env.AI_CONTEXT_CHARS || 60000 };
  if (env.DEV_MODE === "true") return { id: "dev", ready: true, model: "écho (test)", label: "Mode test", budget: 60000 };
  return { id: "none", ready: false };
}
const dailyLimit = env => Math.max(1, +env.AI_DAILY_LIMIT || 60);
const usageKey = (userId, day) => `ai:${userId}:${day}`;

export async function aiStatus(env, user) {
  const pv = aiProvider(env); const day = new Date().toISOString().slice(0, 10);
  const used = (await env.DB.prepare("select v from meta where k = ?1").bind(usageKey(user.id, day)).first())?.v || 0;
  return { ready: pv.ready, provider: pv.id, label: pv.label || "", model: pv.model || "", budget: pv.budget || 60000, limit: dailyLimit(env), used };
}

function clean(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
}
function pickText(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  return r.response ?? r.choices?.[0]?.message?.content ?? r.result?.response ?? r.output_text ?? r.choices?.[0]?.text ?? "";
}

export async function aiChat(env, user, body) {
  const pv = aiProvider(env);
  if (!pv.ready) { const e = new Error("L'assistant n'est pas activé sur ce serveur."); e.status = 503; throw e; }
  const sys = String(body?.system || "").slice(0, pv.budget + 8000);
  const turns = (Array.isArray(body?.messages) ? body.messages : []).filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") { const e = new Error("Message vide."); e.status = 400; throw e; }

  const day = new Date().toISOString().slice(0, 10), key = usageKey(user.id, day);
  const used = (await env.DB.prepare("select v from meta where k = ?1").bind(key).first())?.v || 0;
  if (used >= dailyLimit(env)) { const e = new Error(`Limite quotidienne atteinte (${dailyLimit(env)} questions). Elle se réinitialise demain.`); e.status = 429; throw e; }
  await env.DB.prepare("insert into meta (k, v) values (?1, 1) on conflict(k) do update set v = v + 1").bind(key).run();

  const messages = [{ role: "system", content: sys }, ...turns];
  let text = "";
  if (pv.id === "dev") {
    text = `Réponse de test (aucun modèle connecté). J'ai reçu ${sys.length.toLocaleString("fr-FR")} caractères de données et votre question : « ${turns[turns.length - 1].content.slice(0, 200)} ».`;
  } else if (pv.id === "workers") {
    const last = messages[messages.length - 1]; last.content += "\n/no_think";
    const r = await env.AI.run(pv.model, { messages, max_tokens: 2000, temperature: 0.3 });
    text = pickText(r);
  } else {
    const url = pv.id === "azure"
      ? `${env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(env.AZURE_OPENAI_DEPLOYMENT)}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION || "2024-10-21"}`
      : env.AI_API_URL;
    const headers = { "Content-Type": "application/json" };
    if (pv.id === "azure") headers["api-key"] = env.AZURE_OPENAI_API_KEY; else headers.Authorization = `Bearer ${env.AI_API_KEY}`;
    const payload = { messages, max_tokens: 2000, temperature: 0.3 }; if (pv.id === "openai" && pv.model) payload.model = pv.model;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(`Le fournisseur d'IA a répondu ${res.status}${j?.error?.message ? " : " + j.error.message : ""}`); e.status = 502; throw e; }
    text = pickText(j);
  }
  text = clean(text);
  if (!text) { const e = new Error("Le modèle n'a rien répondu. Reformulez ou réduisez la question."); e.status = 502; throw e; }
  return { text, provider: pv.id, model: pv.model, used: used + 1, limit: dailyLimit(env) };
}
