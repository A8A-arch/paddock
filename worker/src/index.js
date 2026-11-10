// Serveur de notifications A8A Paddock (Cloudflare Worker).
// - L'app enregistre ici son abonnement push et ses réglages (séries 🔔, délai, résumé, fuseau).
// - Chaque minute : rappels avant les sessions, résumé la veille du week-end,
//   alertes quand un horaire change dans events.json, messages de la direction de course F1 (OpenF1).
import { getVapid, sendPush } from "./webpush.js";

const DATA_URL = "https://a8a-arch.github.io/paddock/data/events.json";
const APP_URL = "https://a8a-arch.github.io/paddock/";
const ALLOWED_ORIGINS = ["https://a8a-arch.github.io", "http://localhost:8080"];
const DELAYS = { "15": [15], "30": [30], "60": [60], "60-15": [60, 15], "120-30": [120, 30] };
const MAX_SUBS = 300;
const MIN = 60_000;

// ---------- Fuseaux horaires ----------
const partsFmt = {};
function zonedParts(ms, tz) {
  partsFmt[tz] ||= new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
  });
  const p = Object.fromEntries(partsFmt[tz].formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) };
}
function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ms = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(ms, tz);
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / MIN) * MIN;
    ms = guess - offset;
  }
  return ms;
}
const fr = (opts, tz) => new Intl.DateTimeFormat("fr-FR", { timeZone: tz, ...opts });
const hhmm = (ms, tz) => fr({ hour: "2-digit", minute: "2-digit" }, tz).format(ms);
const dayHhmm = (ms, tz) => `${fr({ weekday: "short" }, tz).format(ms)} ${hhmm(ms, tz)}`;
const validTz = (tz) => { try { fr({}, tz); return tz; } catch { return "Europe/Paris"; } };

// ---------- Données ----------
async function loadData() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`events.json ${res.status}`);
  return res.json();
}

function flatten(data) {
  const series = Object.fromEntries((data.series || []).map((s) => [s.id, s]));
  const out = [];
  for (const ev of data.events || []) {
    for (const s of ev.sessions || []) {
      const startMs = s.start ? Date.parse(s.start) : NaN;
      out.push({
        uid: `${ev.id}-${s.id}`, series: ev.series, short: series[ev.series]?.short || ev.series,
        event: ev.name, kind: s.kind, label: s.label, status: s.status, startMs, note: s.note || ev.note || "",
      });
    }
  }
  return out;
}

// La notification de quelle case du 🔔 ? (le sprint suit « Courses »)
const notifKind = (kind) => (kind === "sprint" ? "course" : kind);
const wants = (sub, s) => {
  const n = sub.settings.notif?.[s.series];
  return !!(n && n[notifKind(s.kind)]);
};
const delayText = (min) => (min >= 60 ? `${min / 60} h` : `${min} min`);

// ---------- Abonnés ----------
const loadSubs = async (env) => (await env.KV.get("subs", "json")) || {};
const saveSubs = (env, subs) => env.KV.put("subs", JSON.stringify(subs));
async function subId(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanSettings(s = {}) {
  const notif = {};
  for (const [id, v] of Object.entries(s.notif || {}).slice(0, 60)) {
    notif[String(id).slice(0, 40)] = { qualif: !!v?.qualif, course: !!v?.course, essais: !!v?.essais };
  }
  return {
    notif,
    delay: DELAYS[s.delay] ? s.delay : "60-15",
    summary: s.summary !== false,
    summaryTime: /^\d{2}:\d{2}$/.test(s.summaryTime || "") ? s.summaryTime : "20:00",
    tz: validTz(s.tz || "Europe/Paris"),
  };
}

// ---------- Ce qu'on envoie pendant la minute [t0, t0 + 1 min[ ----------
function reminders(sub, sessions, t0) {
  const out = [];
  const tz = sub.settings.tz;
  for (const s of sessions) {
    if (!Number.isFinite(s.startMs) || s.status === "annule" || !wants(sub, s)) continue;
    for (const d of DELAYS[sub.settings.delay]) {
      const at = s.startMs - d * MIN;
      if (at >= t0 && at < t0 + MIN) {
        out.push({
          title: `${s.short} · ${s.label}`,
          body: `${s.event} — dans ${delayText(d)}, départ à ${hhmm(s.startMs, tz)}${s.status === "provisoire" ? " (horaire provisoire)" : ""}`,
          tag: `${s.uid}-${d}`,
        });
      }
    }
  }
  return out;
}

function summary(sub, sessions, t0) {
  if (!sub.settings.summary) return [];
  const tz = sub.settings.tz;
  const mine = sessions.filter((s) => Number.isFinite(s.startMs) && s.status !== "annule" && sub.settings.notif?.[s.series]);
  // Regroupe par semaine (lundi → dimanche, heure locale de l'abonné)
  const weeks = {};
  for (const s of mine) {
    const p = zonedParts(s.startMs, tz);
    const monday = Date.UTC(p.y, p.m - 1, p.d) - p.wd * 86_400_000;
    (weeks[monday] ||= []).push(s);
  }
  const [hh, mm] = sub.settings.summaryTime.split(":").map(Number);
  const out = [];
  for (const [monday, list] of Object.entries(weeks)) {
    list.sort((a, b) => a.startMs - b.startMs);
    const p = zonedParts(list[0].startMs, tz);
    const eve = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86_400_000);
    const at = zonedToUtc(eve.getUTCFullYear(), eve.getUTCMonth() + 1, eve.getUTCDate(), hh, mm, tz);
    if (at < t0 || at >= t0 + MIN) continue;
    const byEvent = new Map();
    for (const s of list.filter((x) => x.kind !== "essais")) {
      const k = `${s.short} ${s.event}`;
      byEvent.set(k, [...(byEvent.get(k) || []), `${s.kind === "qualif" ? "Q" : s.label} ${dayHhmm(s.startMs, tz)}`]);
    }
    const lines = [...byEvent].map(([k, v]) => `${k} : ${v.join(", ")}`);
    out.push({
      title: "Le week-end au Paddock",
      body: lines.length ? lines.join("\n") : "Essais au programme demain.",
      tag: `resume-${monday}`,
    });
  }
  return out;
}

// Horaires modifiés depuis la dernière version de events.json
async function changes(env, data, sessions, now) {
  const snap = (await env.KV.get("snap", "json")) || null;
  if (snap && snap.updatedAt === data.updatedAt) return null;
  const next = {
    updatedAt: data.updatedAt,
    sessions: Object.fromEntries(sessions.map((s) => [s.uid, [s.startMs || null, s.status]])),
    alerts: (data.alerts || []).map((a) => a.id),
  };
  await env.KV.put("snap", JSON.stringify(next));
  if (!snap) return null; // première fois : on mémorise seulement

  const perSession = [];
  for (const s of sessions) {
    const before = snap.sessions[s.uid];
    if (!before) continue;
    const [oldStart, oldStatus] = before;
    const future = (Number.isFinite(s.startMs) ? s.startMs : oldStart || 0) > now;
    if (!future) continue;
    if (s.status === "annule" && oldStatus !== "annule") {
      perSession.push({ s, kind: "annule" });
    } else if (oldStart && Number.isFinite(s.startMs) && Math.abs(s.startMs - oldStart) >= 5 * MIN) {
      perSession.push({ s, kind: "horaire", oldStart });
    } else if (s.status === "retarde" && oldStatus !== "retarde") {
      perSession.push({ s, kind: "retarde" });
    }
  }
  const newAlerts = (data.alerts || []).filter((a) => !snap.alerts.includes(a.id));
  return { perSession, newAlerts };
}

function changeMessages(sub, ch) {
  const tz = sub.settings.tz;
  const out = [];
  for (const { s, kind, oldStart } of ch.perSession) {
    if (!wants(sub, s)) continue;
    const head = `${s.short} · ${s.event}`;
    if (kind === "annule") out.push({ title: `${head} : annulé`, body: `${s.label} annulé(e).${s.note ? " " + s.note : ""}`, tag: `chg-${s.uid}` });
    else if (kind === "retarde") out.push({ title: `${head} : retardé`, body: `${s.label} : nouveau départ ${dayHhmm(s.startMs, tz)}.${s.note ? " " + s.note : ""}`, tag: `chg-${s.uid}` });
    else out.push({ title: `${head} : nouvel horaire`, body: `${s.label} : ${dayHhmm(s.startMs, tz)} (au lieu de ${dayHhmm(oldStart, tz)}).`, tag: `chg-${s.uid}` });
  }
  if (Object.keys(sub.settings.notif || {}).length) {
    for (const a of ch.newAlerts) out.push({ title: a.title, body: a.text || "", tag: `alert-${a.id}` });
  }
  return out;
}

// Direction de course F1 en direct (OpenF1), pendant les qualifs, sprints et courses
const RC_KEEP = /DELAYED|SUSPENDED|RED FLAG|RESUME|POSTPONED|ABANDONED|NEW START TIME|START BEHIND THE SAFETY CAR|STANDING START|ROLLING START|WILL NOT BE RESTARTED/i;
async function f1Live(sessions, t0) {
  const live = sessions.find((s) => s.series === "f1" && s.kind !== "essais" && Number.isFinite(s.startMs)
    && t0 >= s.startMs - 30 * MIN && t0 <= s.startMs + 4 * 60 * MIN);
  if (!live) return null;
  const res = await fetch("https://api.openf1.org/v1/race_control?session_key=latest", { cf: { cacheTtl: 0 } });
  if (!res.ok) return null;
  const msgs = (await res.json()).filter((m) => {
    const d = Date.parse(m.date);
    return d >= t0 - 2 * MIN && d < t0 - MIN && (RC_KEEP.test(m.message || "") || m.flag === "RED");
  });
  if (!msgs.length) return null;
  return {
    session: live,
    messages: msgs.map((m) => ({
      title: `F1 · ${live.event} : ${m.flag === "RED" || /RED FLAG/i.test(m.message) ? "drapeau rouge" : "direction de course"}`,
      body: m.message,
      tag: `f1rc-${m.date}`,
    })),
  };
}

// ---------- Envoi ----------
async function deliver(env, subs, perSub) {
  const vapid = await getVapid(env.KV);
  const cache = {};
  let dead = false;
  await Promise.all(Object.entries(perSub).map(async ([id, msgs]) => {
    for (const m of msgs) {
      try {
        const status = await sendPush(vapid, subs[id].sub, { ...m, url: APP_URL });
        if (status === 404 || status === 410) { delete subs[id]; dead = true; break; }
      } catch (e) { console.log("push", id, e.message); }
    }
  }));
  if (dead) await saveSubs(env, subs);
}

async function tick(env, t0) {
  const subs = await loadSubs(env);
  const data = await loadData();
  const sessions = flatten(data);
  const ch = await changes(env, data, sessions, t0);
  const live = await f1Live(sessions, t0).catch(() => null);
  const perSub = {};
  for (const [id, sub] of Object.entries(subs)) {
    const msgs = [...reminders(sub, sessions, t0), ...summary(sub, sessions, t0)];
    if (ch) msgs.push(...changeMessages(sub, ch));
    if (live && wants(sub, live.session)) msgs.push(...live.messages);
    if (msgs.length) perSub[id] = msgs.slice(0, 6);
  }
  if (Object.keys(perSub).length) await deliver(env, subs, perSub);
  return perSub;
}

// ---------- API pour l'app ----------
function cors(req) {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const json = (req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req) } });

function validSub(sub) {
  try {
    return sub && new URL(sub.endpoint).protocol === "https:" && sub.keys?.p256dh && sub.keys?.auth;
  } catch { return false; }
}

async function handle(req, env) {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method === "GET" && url.pathname === "/vapid") return json(req, { key: (await getVapid(env.KV)).publicKey });
  if (req.method === "GET" && url.pathname === "/") return json(req, { ok: true, service: "A8A Paddock push" });
  if (req.method !== "POST") return json(req, { error: "not found" }, 404);

  const text = await req.text();
  if (text.length > 20_000) return json(req, { error: "too large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json(req, { error: "bad json" }, 400); }

  if (url.pathname === "/subscribe") {
    if (!validSub(body.sub)) return json(req, { error: "bad subscription" }, 400);
    const subs = await loadSubs(env);
    const id = await subId(body.sub.endpoint);
    if (!subs[id] && Object.keys(subs).length >= MAX_SUBS) return json(req, { error: "full" }, 503);
    subs[id] = {
      sub: { endpoint: body.sub.endpoint, keys: { p256dh: body.sub.keys.p256dh, auth: body.sub.keys.auth } },
      settings: cleanSettings(body.settings),
      created: subs[id]?.created || new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    await saveSubs(env, subs);
    return json(req, { ok: true });
  }
  if (url.pathname === "/unsubscribe" || url.pathname === "/test") {
    const subs = await loadSubs(env);
    const id = body.endpoint ? await subId(body.endpoint) : "";
    if (!subs[id]) return json(req, { error: "unknown" }, 404);
    if (url.pathname === "/unsubscribe") {
      delete subs[id];
      await saveSubs(env, subs);
      return json(req, { ok: true });
    }
    const status = await sendPush(await getVapid(env.KV), subs[id].sub, {
      title: "A8A Paddock", body: "Les notifications fonctionnent sur cet appareil 🏁", tag: "test", url: APP_URL,
    });
    return json(req, { ok: status >= 200 && status < 300, status });
  }
  return json(req, { error: "not found" }, 404);
}

export default {
  fetch: (req, env) => handle(req, env).catch((e) => json(req, { error: e.message }, 500)),
  async scheduled(event, env, ctx) {
    const t0 = Math.floor(event.scheduledTime / MIN) * MIN;
    ctx.waitUntil(tick(env, t0).catch((e) => console.log("tick", e.message)));
  },
};

// Exporté pour les tests locaux
export { flatten, reminders, summary, zonedToUtc, zonedParts, cleanSettings };
