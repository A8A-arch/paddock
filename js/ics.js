// Génération de calendriers iCalendar (.ics).
// Module partagé : utilisé par l'app (export perso) ET par scripts/build-ics.mjs (abonnements).
// Aucune dépendance, fonctionne dans le navigateur et dans Node.

export const KIND_LABEL = { essais: "Essais libres", qualif: "Qualifications", sprint: "Sprint", course: "Course" };
/** Types de sessions qui peuvent aller dans le calendrier (jamais les essais). */
export const CALENDAR_KINDS = ["qualif", "sprint", "course"];

/** Une entrée streaming peut être une clé de data.links, un nom simple ou un objet {name, platform, url}. */
export function resolveStream(data, item) {
  if (item && typeof item === "object") return item;
  return data.links?.[item] || { name: String(item) };
}

/** Décalage (ms) d'un fuseau IANA à un instant donné. */
export function tzOffset(ms, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Heure murale dans un fuseau -> timestamp UTC. */
export function zonedToUtc(y, m, d, h, mi, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffset(guess, timeZone);
  t = guess - tzOffset(t, timeZone); // 2e passe pour les changements d'heure
  return t;
}

/** Composantes de date (année, mois, jour, jour de semaine 0=dim) d'un instant dans un fuseau. */
export function zonedParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd };
}

/** Aplatit events.json en une liste de sessions enrichies. */
export function flattenSessions(data) {
  const seriesById = Object.fromEntries(data.series.map((s) => [s.id, s]));
  const out = [];
  for (const ev of data.events) {
    for (const s of ev.sessions) {
      const startMs = s.start ? Date.parse(s.start) : null;
      // Session sans horaire : on la place à midi heure du circuit pour le tri.
      const sortMs = startMs ?? (() => {
        const [y, m, d] = s.date.split("-").map(Number);
        return zonedToUtc(y, m, d, 12, 0, ev.tz || "UTC");
      })();
      out.push({
        ...s,
        uid: `${ev.id}-${s.id}`,
        event: ev,
        series: seriesById[ev.series] || { id: ev.series, name: ev.series, short: ev.series, color: "#888" },
        startMs,
        sortMs,
        endMs: startMs ? startMs + (s.duration || 60) * 60000 : null,
        tv: s.tv || ev.tv || { fr: [], stream: [] },
      });
      const last = out[out.length - 1];
      last.streams = (last.tv.stream || []).map((x) => resolveStream(data, x));
    }
  }
  return out.sort((a, b) => a.sortMs - b.sortMs);
}

// ---------- Écriture iCalendar ----------

const esc = (t) => String(t ?? "")
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const enc = new TextEncoder();
function fold(line) {
  // RFC 5545 : lignes de 75 octets max, continuation par un espace.
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) { out.push(cur); cur = " "; bytes = 1; limit = 75; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n");
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const pad = (n) => String(n).padStart(2, "0");
const dateOnly = (iso) => iso.replace(/-/g, "");
const nextDay = (iso) => {
  const t = Date.parse(iso + "T00:00:00Z") + 86400000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
};

function tvText(s, opts) {
  const parts = [];
  if (opts.tvFr !== false && s.tv.fr?.length) parts.push("TV France : " + s.tv.fr.join(", "));
  if (opts.tvStream !== false && s.streams.length) {
    parts.push("Streaming :\n" + s.streams.map((x) =>
      `• ${x.name}${x.platform ? ` (${x.platform})` : ""}${x.url ? ` : ${x.url}` : ""}`).join("\n"));
  }
  return parts.length ? parts.join("\n") : "Diffusion : à confirmer";
}

function shortTv(s, opts) {
  const list = [...(opts.tvFr !== false ? s.tv.fr || [] : []), ...(opts.tvStream !== false ? s.streams.map((x) => x.name) : [])];
  return list.length ? list.slice(0, 2).join(" / ") : "TV à confirmer";
}

/**
 * @param {object} data   contenu de events.json
 * @param {object} opts   { name, alarms:[min], kinds:[...], seriesIds:[...]|null, tvFr, tvStream,
 *                          summary:{enabled, time:"HH:MM", tz}, now }
 */
export function buildICS(data, opts = {}) {
  const now = opts.now ?? Date.now();
  const kinds = new Set((opts.kinds || CALENDAR_KINDS).filter((k) => CALENDAR_KINDS.includes(k)));
  const seriesFilter = opts.seriesIds ? new Set(opts.seriesIds) : null;
  const alarms = (opts.alarms || []).filter((n) => n > 0);
  const sessions = flattenSessions(data).filter((s) =>
    kinds.has(s.kind) && (!seriesFilter || seriesFilter.has(s.series.id)));

  const L = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Paddock//Courses//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(opts.name || "A8A Paddock – Courses")}`,
    "X-WR-CALDESC:Courses auto et moto : horaires\\, chaînes TV et statuts",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
  ];

  for (const s of sessions) {
    const ev = s.event;
    const tbc = !s.startMs;
    const prefix = s.status === "retarde" ? "⚠️ RETARDÉ · " : s.status === "annule" ? "ANNULÉ · " : "";
    const summary = `${prefix}${s.series.short} · ${ev.name} – ${s.label || KIND_LABEL[s.kind]}${tbc ? " (horaire à confirmer)" : ""}`;
    const desc = [
      tvText(s, opts),
      s.status === "provisoire" ? "Horaire provisoire, vérifié chaque jeudi, samedi et dimanche." : "",
      s.note || "",
      ev.note || "",
    ].filter(Boolean).join("\n\n");

    L.push("BEGIN:VEVENT", `UID:${s.uid}@paddock`, `DTSTAMP:${stamp(Date.parse(data.updatedAt) || now)}`);
    if (tbc) {
      L.push(`DTSTART;VALUE=DATE:${dateOnly(s.date)}`, `DTEND;VALUE=DATE:${nextDay(s.date)}`, "TRANSP:TRANSPARENT");
    } else {
      L.push(`DTSTART:${stamp(s.startMs)}`, `DTEND:${stamp(s.endMs)}`);
    }
    L.push(
      `SUMMARY:${esc(summary)}`,
      `LOCATION:${esc([ev.circuit, ev.country].filter(Boolean).join(", "))}`,
      `DESCRIPTION:${esc(desc)}`,
      `CATEGORIES:${esc(s.series.name)}`,
    );
    if (s.status === "annule") L.push("STATUS:CANCELLED");
    if (!tbc && s.status !== "annule") {
      for (const min of alarms) {
        L.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${min}M`,
          `DESCRIPTION:${esc(`${s.series.short} ${ev.name} – ${s.label || KIND_LABEL[s.kind]} dans ${fmtDelay(min)} · ${shortTv(s, opts)}`)}`,
          "END:VALARM");
      }
    }
    L.push("END:VEVENT");
  }

  // Résumé du week-end : un événement le vendredi avec tout le programme.
  if (opts.summary?.enabled) {
    const tz = opts.summary.tz || "Europe/Paris";
    const [hh, mm] = (opts.summary.time || "18:00").split(":").map(Number);
    const weeks = new Map();
    for (const s of sessions) {
      if (s.status === "annule") continue;
      const p = zonedParts(s.sortMs, tz);
      const back = (p.wd + 6) % 7; // jours depuis lundi
      const monday = Date.UTC(p.y, p.m - 1, p.d) - back * 86400000;
      const fri = new Date(monday + 4 * 86400000);
      const key = fri.toISOString().slice(0, 10);
      if (!weeks.has(key)) weeks.set(key, []);
      weeks.get(key).push(s);
    }
    for (const [key, list] of weeks) {
      const [y, m, d] = key.split("-").map(Number);
      const at = zonedToUtc(y, m, d, hh, mm, tz);
      const lines = list.filter((s) => s.sortMs >= at - 3600000).map((s) => {
        const when = s.startMs ? fmtWhen(s.startMs, tz) : fmtDay(s.sortMs, tz) + " · horaire à confirmer";
        return `${when} — ${s.series.short} ${s.event.name} (${s.label || KIND_LABEL[s.kind]}) · ${shortTv(s, opts)}`;
      });
      if (!lines.length) continue;
      L.push("BEGIN:VEVENT", `UID:resume-${key}@paddock`, `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(at)}`, `DTEND:${stamp(at + 15 * 60000)}`,
        `SUMMARY:${esc(`🏁 Programme du week-end (${lines.length} sessions)`)}`,
        `DESCRIPTION:${esc(lines.join("\n"))}`, "TRANSP:TRANSPARENT",
        "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M",
        `DESCRIPTION:${esc(`Ce week-end : ${lines.length} sessions au programme`)}`, "END:VALARM",
        "END:VEVENT");
    }
  }

  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

function fmtDelay(min) {
  if (min % 1440 === 0) return `${min / 1440} j`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
function fmtDay(ms, tz) { const p = zonedParts(ms, tz); return `${DAYS[p.wd]} ${p.d}/${pad(p.m)}`; }
function fmtWhen(ms, tz) { const p = zonedParts(ms, tz); return `${DAYS[p.wd]} ${p.d}/${pad(p.m)} ${pad(p.h)}h${pad(p.mi)}`; }

/** Préréglages d'abonnement générés côté serveur (fichiers statiques). */
export const SUB_ALARMS = { "15": [15], "30": [30], "60": [60], "60-15": [60, 15], "120-30": [120, 30] };
export function subscriptionFile({ alarmKey, qualif, summary }) {
  return `paddock-${alarmKey}${qualif ? "-q" : ""}${summary ? "-r" : ""}.ics`;
}
