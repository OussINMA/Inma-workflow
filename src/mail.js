// E-mails: Microsoft Graph (application permission Mail.Send, free with Microsoft 365) or console (tests).
let appToken = { value: null, exp: 0 };
async function graphAppToken(env) {
  if (appToken.value && Date.now() < appToken.exp - 60_000) return appToken.value;
  const body = new URLSearchParams({ client_id: env.AZURE_CLIENT_ID, client_secret: env.AZURE_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" });
  const r = await fetch(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", body });
  const j = await r.json();
  if (!r.ok) throw new Error("Jeton Microsoft Graph refusé : " + (j.error_description || j.error));
  appToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return appToken.value;
}
// "graph" only when everything needed to send is present; otherwise invitations are shown on screen to forward by hand.
export function mailMissing(env) {
  const miss = [];
  if (!env.AZURE_TENANT_ID) miss.push("AZURE_TENANT_ID");
  if (!env.AZURE_CLIENT_ID) miss.push("AZURE_CLIENT_ID");
  if (!env.MAIL_FROM) miss.push("MAIL_FROM");
  if (!env.AZURE_CLIENT_SECRET || /^(aucun|none|-|x)$/i.test(String(env.AZURE_CLIENT_SECRET).trim())) miss.push("AZURE_CLIENT_SECRET");
  if (env.MAIL_MODE && env.MAIL_MODE.toLowerCase() !== "graph") miss.push("MAIL_MODE (doit valoir graph)");
  return miss;
}
export function mailMode(env) {
  const m = (env.MAIL_MODE || "graph").toLowerCase();
  const secretOk = env.AZURE_CLIENT_SECRET && !/^(aucun|none|-|x)$/i.test(String(env.AZURE_CLIENT_SECRET).trim());
  return m === "graph" && secretOk && env.MAIL_FROM && env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID ? "graph" : "console";
}
export async function sendMail(env, { to, subject, html, text }) {
  if (mailMode(env) === "graph") {
    if (!env.AZURE_CLIENT_SECRET || !env.MAIL_FROM) throw new Error("Envoi d'e-mails non configuré (AZURE_CLIENT_SECRET et MAIL_FROM).");
    const t = await graphAppToken(env);
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`, {
      method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
    });
    if (!r.ok) throw new Error(`Envoi via Microsoft Graph impossible (${r.status}) : ${(await r.text()).slice(0, 300)}`);
    return;
  }
  await env.DB.prepare("insert into outbox (to_addr, subject, body, created_at) values (?1, ?2, ?3, ?4)").bind(to, subject, text, new Date().toISOString()).run();
  console.log(`[mail:console] -> ${to} | ${subject}\n${text}`);
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function layout(title, inner) {
  return `<!doctype html><html><body style="margin:0;background:#F1F1F1;font-family:Montserrat,Segoe UI,Arial,sans-serif;color:#212121">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F1F1;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:8px;overflow:hidden">
<tr><td style="background:#212121;padding:20px 28px"><span style="color:#fff;font-weight:700;font-size:20px;letter-spacing:4px">INMA</span><span style="color:#E22529;font-size:11px;letter-spacing:3px;margin-left:10px">WORKFLOW</span></td></tr>
<tr><td style="padding:28px">${inner}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #E9E9E9;color:#888;font-size:12px">INMA Capital · Les Berges du Lac II, Tunis · ${esc(title)}</td></tr>
</table></td></tr></table></body></html>`;
}

export function inviteEmail({ name, inviter, roleLabel, code, appUrl, appName, external, items }) {
  const link = `${appUrl}/?invite=${encodeURIComponent(code)}`;
  const edge = `microsoft-edge:${link}`;
  const subject = `${inviter || "INMA"} vous invite sur ${appName}`;
  const list = (items || []).map(i => `<li style="margin:4px 0">${esc(i)}</li>`).join("");
  const html = layout(subject, `
    <p style="margin:0 0 14px;font-size:15px">Bonjour ${esc(name)},</p>
    <p style="margin:0 0 14px;line-height:1.5">${esc(inviter || "L'équipe INMA")} vous invite sur <b>${esc(appName)}</b>, l'outil de suivi des dossiers d'INMA${external ? "" : ` (rôle : ${esc(roleLabel || "membre")})`}.</p>
    ${list ? `<p style="margin:0 0 6px">Vous avez accès à :</p><ul style="margin:0 0 14px;padding-left:20px;line-height:1.4">${list}</ul>` : ""}
    <p style="margin:0 0 6px">Votre code d'activation :</p>
    <p style="margin:0 0 18px;font-family:Consolas,monospace;font-size:26px;letter-spacing:6px;font-weight:700;color:#E22529">${esc(code)}</p>
    <p style="margin:0 0 10px"><a href="${esc(link)}" style="display:inline-block;background:#E22529;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">Ouvrir ${esc(appName)}</a></p>
    <p style="margin:0 0 18px;font-size:13px"><a href="${esc(edge)}" style="color:#212121">Ouvrir dans Microsoft Edge</a> (Windows)</p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#555">${external
      ? "Le code est valable 14 jours et sert à votre première connexion. Ensuite, connectez-vous en recevant un nouveau code par e-mail."
      : "Ouvrez le lien dans Microsoft Edge avec votre compte INMA : choisissez « Se connecter avec Microsoft » pour lier OneDrive et SharePoint. Le code sert à votre première connexion (valable 14 jours)."}</p>`);
  const text = `Bonjour ${name},\n\n${inviter || "L'équipe INMA"} vous invite sur ${appName}.\n${(items || []).map(i => "- " + i).join("\n")}\n\nCode d'activation : ${code}\nLien : ${link}\nOuvrir dans Edge (Windows) : ${edge}\n`;
  return { subject, html, text };
}

export function otpEmail({ code, appName }) {
  const subject = `Votre code de connexion ${appName} : ${code}`;
  const html = layout(subject, `<p style="margin:0 0 14px">Votre code de connexion :</p>
    <p style="margin:0 0 18px;font-family:Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:700;color:#E22529">${esc(code)}</p>
    <p style="margin:0;font-size:13px;color:#555">Il est valable 10 minutes. Si vous n'avez pas demandé ce code, ignorez ce message.</p>`);
  return { subject, html, text: `Votre code de connexion ${appName} : ${code} (valable 10 minutes).` };
}

