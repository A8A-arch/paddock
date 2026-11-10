import { flattenSessions, KIND_LABEL } from "./ics.js";

// ---------- État & réglages ----------
const DEFAULTS = {
  view: "weekend",
  kinds: { essais: true, qualif: true, sprint: true, course: true },
  tvFr: true,
  tvStream: true,
  summary: true,
  summaryTime: "20:00",  // résumé la veille au soir de la 1re session du week-end
  series: null,          // null = toutes les séries suivies
  filter: null,          // filtre rapide de la liste : null = toutes, sinon liste d'ids
  notif: {},             // notifications par série : { f1: { qualif: true, course: true, essais: false } }
  notifDelay: "60-15",   // délai des rappels push
};
const NOTIF_DEFAULT = { qualif: true, course: true, essais: false };
const NOTIF_KINDS = [["qualif", "Qualifs"], ["course", "Courses"], ["essais", "Essais"]];
const ALARM_PRESETS = [
  { key: "15", label: "15 minutes" },
  { key: "30", label: "30 minutes" },
  { key: "60", label: "1 heure" },
  { key: "60-15", label: "1 heure et 15 minutes", hint: "Deux rappels : 1 heure avant, puis 15 minutes avant." },
  { key: "120-30", label: "2 heures et 30 minutes", hint: "Deux rappels : 2 heures avant, puis 30 minutes avant." },
];

const store = {
  get() {
    try {
      const saved = JSON.parse(localStorage.getItem("paddock:settings") || "{}");
      if (saved.chip && saved.chip !== "all" && !saved.filter) saved.filter = [saved.chip]; // ancien filtre à choix unique
      delete saved.chip;
      if (saved.summaryTime === "18:00") saved.summaryTime = "20:00"; // ancien « vendredi 18h »
      if (saved.alarmKey && !saved.notifDelay) saved.notifDelay = saved.alarmKey;
      delete saved.alarmKey; delete saved.series;
      return { ...DEFAULTS, ...saved, kinds: { ...DEFAULTS.kinds, ...(saved.kinds || {}) } };
    }
    catch { return { ...DEFAULTS }; }
  },
  set(s) { try { localStorage.setItem("paddock:settings", JSON.stringify(s)); } catch { /* mode privé */ } },
};

let settings = store.get();
let data = null;
let sessions = [];
const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const $ = (sel) => document.querySelector(sel);
const save = () => store.set(settings);

// ---------- Formatage ----------
const fmt = (opts, tz) => new Intl.DateTimeFormat("fr-FR", { ...opts, ...(tz ? { timeZone: tz } : {}) });
const fTime = fmt({ hour: "2-digit", minute: "2-digit" });
const fDay = fmt({ weekday: "long", day: "numeric", month: "long" });
const fDayShort = fmt({ weekday: "short", day: "numeric", month: "short" });
const dayKey = (ms) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function relDay(ms) {
  const today = dayKey(Date.now());
  const tomorrow = dayKey(Date.now() + 86400000);
  const k = dayKey(ms);
  if (k === today) return "Aujourd'hui";
  if (k === tomorrow) return "Demain";
  return null;
}

// ---------- Fenêtres de temps (heure locale du téléphone) ----------
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function weekBounds(now = Date.now()) {
  const d = new Date(startOfDay(now));
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  const start = d.getTime();
  const end = new Date(d); end.setDate(end.getDate() + 7);
  return [start, end.getTime()];
}
function weekendBounds(now = Date.now()) {
  // Le week-end en cours ou le prochain : vendredi 00h -> lundi 06h
  const [mon] = weekBounds(now);
  const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
  const end = new Date(mon); end.setDate(end.getDate() + 7); end.setHours(6);
  if (now >= end.getTime()) return weekendBounds(now + 3 * 86400000);
  return [fri.getTime(), end.getTime()];
}

// ---------- Filtrage ----------
function followed(s) {
  if (settings.series && !settings.series.includes(s.series.id)) return false;
  if (!settings.kinds[s.kind]) return false;
  if (settings.filter && !settings.filter.includes(s.series.id)) return false;
  return true;
}

function visibleSessions() {
  const now = Date.now();
  let [from, to] = [0, Infinity];
  if (settings.view === "week") [from, to] = weekBounds(now);
  else if (settings.view === "weekend") [from, to] = weekendBounds(now);
  else {
    // À venir : jusqu'à la fin de la semaine prochaine (lundi 6h suivant le prochain week-end)
    // Plus tard : tout ce qui vient après.
    const end = new Date(weekBounds(now)[1]); end.setDate(end.getDate() + 7); end.setHours(6);
    if (settings.view === "later") from = end.getTime();
    else { from = startOfDay(now); to = end.getTime(); }
  }
  return sessions.filter((s) => followed(s) && s.sortMs >= from && s.sortMs < to);
}

function nextSession() {
  const now = Date.now();
  return sessions.find((s) => followed({ ...s }) && s.startMs && s.status !== "annule" && (s.endMs > now));
}

// ---------- Rendu ----------
function streamLink(x, cls = "tv-badge stream") {
  const label = `${escapeHtml(x.name)}${x.url ? ' <span class="ext">↗</span>' : ""}`;
  return x.url
    ? `<a class="${cls}" href="${escapeHtml(x.url)}" target="_blank" rel="noopener" title="${escapeHtml(x.platform || "")}">${label}</a>`
    : `<span class="${cls}">${label}</span>`;
}

function tvBadges(s) {
  const fr = settings.tvFr ? s.tv.fr || [] : [];
  const st = settings.tvStream ? s.streams : [];
  if (!fr.length && !st.length) return `<span class="tv-badge none">TV à confirmer</span>`;
  return fr.map((c) => `<span class="tv-badge">${escapeHtml(c)}</span>`).join("") + st.map((x) => streamLink(x)).join("");
}

function statusBadge(s) {
  const now = Date.now();
  if (s.startMs && now >= s.startMs && now < s.endMs && s.status !== "annule") return `<span class="status live">En direct</span>`;
  const map = { provisoire: ["provisoire", "Provisoire"], tbc: ["tbc", "À confirmer"], retarde: ["retarde", "Retardé"], annule: ["annule", "Annulé"] };
  const m = map[s.status];
  return m ? `<span class="status ${m[0]}">${m[1]}</span>` : "";
}

function renderHero() {
  const hero = $("#hero");
  const s = nextSession();
  if (!s) {
    hero.style.removeProperty("--series");
    const msg = settings.filter
      ? "Aucun horaire confirmé pour les séries choisies pour l'instant."
      : "Rien de prévu pour l'instant dans tes séries. Le programme est vérifié chaque jeudi.";
    hero.innerHTML = `<div class="hero-label">Prochaine session</div><p class="hero-empty">${msg}</p>`;
    hero.onclick = null;
    return;
  }
  const live = Date.now() >= s.startMs;
  hero.classList.toggle("live", live);
  hero.style.setProperty("--series", s.series.color);
  hero.innerHTML = `
    <div class="hero-label">${live ? "● En direct" : "Prochaine session"} · ${escapeHtml(s.series.name)}</div>
    <div class="hero-title">${escapeHtml(s.event.name)}</div>
    <div class="hero-sub">${escapeHtml(s.label || KIND_LABEL[s.kind])} · ${cap(fDay.format(s.startMs))} à ${fTime.format(s.startMs)}</div>
    <div class="countdown" id="countdown"></div>
    <div class="tv">${tvBadges(s)}</div>`;
  hero.onclick = () => openDetail(s.uid);
  tick(s);
}

let tickTimer = null;
function tick(s) {
  clearInterval(tickTimer);
  const el = () => document.getElementById("countdown");
  const draw = () => {
    const c = el(); if (!c) return;
    let diff = s.startMs - Date.now();
    if (diff <= 0) {
      if (Date.now() > s.endMs) { clearInterval(tickTimer); render(); return; }
      c.innerHTML = `<div><b>LIVE</b><span>maintenant</span></div>`; return;
    }
    const d = Math.floor(diff / 86400000); diff -= d * 86400000;
    const h = Math.floor(diff / 3600000); diff -= h * 3600000;
    const m = Math.floor(diff / 60000); diff -= m * 60000;
    const sec = Math.floor(diff / 1000);
    const cell = (v, l) => `<div><b>${String(v).padStart(2, "0")}</b><span>${l}</span></div>`;
    c.innerHTML = (d ? cell(d, "jours") : "") + cell(h, "h") + cell(m, "min") + (d ? "" : cell(sec, "s"));
  };
  draw();
  tickTimer = setInterval(draw, 1000);
}

function filterableSeries() {
  return data.series.filter((s) => !settings.series || settings.series.includes(s.id));
}

function renderFilter() {
  const list = filterableSeries();
  if (settings.filter) {
    settings.filter = settings.filter.filter((id) => list.some((s) => s.id === id));
    if (!settings.filter.length) settings.filter = null;
  }
  const chosen = settings.filter ? list.filter((s) => settings.filter.includes(s.id)) : [];
  let label = "Toutes les séries";
  if (chosen.length === 1) label = chosen[0].name;
  else if (chosen.length > 1) {
    label = chosen.slice(0, 2).map((s) => s.short).join(", ") + (chosen.length > 2 ? ` +${chosen.length - 2}` : "");
  }
  $("#filter-label").textContent = label;
  $("#filter-dots").innerHTML = chosen.length
    ? chosen.slice(0, 4).map((s) => `<i style="--c:${s.color}"></i>`).join("")
    : `<i style="--c:var(--muted)"></i>`;
  $("#filter").classList.toggle("active", chosen.length > 0);
}

function renderFilterSheet() {
  const list = filterableSeries();
  const groups = [...new Set(list.map((s) => s.group))];
  const sel = new Set(settings.filter || []);
  const bell = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>`;
  $("#filter-list").innerHTML =
    `<div class="f-cols"><span>Voir</span><span>Notifs</span></div>` +
    groups.map((g) => {
      const items = list.filter((s) => s.group === g);
      const all = items.every((s) => sel.has(s.id));
      return `<div class="f-group">
        <div class="f-group-head"><h3>${escapeHtml(g)}</h3>
          <button data-group="${escapeHtml(g)}">${all ? "Tout décocher" : "Tout cocher"}</button></div>
        ${items.map((s) => {
          const n = settings.notif[s.id];
          return `<div class="f-item" style="--c:${s.color}">
            <div class="f-row">
              <i></i><span>${escapeHtml(s.name)}</span>
              <input type="checkbox" data-fseries="${s.id}" ${sel.has(s.id) ? "checked" : ""} aria-label="Afficher ${escapeHtml(s.name)}">
              <button class="bell" data-bell="${s.id}" aria-pressed="${!!n}" aria-label="Notifications ${escapeHtml(s.name)}">${bell}</button>
            </div>
            ${n ? `<div class="f-kinds">${NOTIF_KINDS.map(([k, l]) =>
              `<button class="pill small" data-nkind="${k}" data-nseries="${s.id}" aria-pressed="${!!n[k]}">${n[k] ? "✓ " : ""}${l}</button>`).join("")}</div>` : ""}
          </div>`;
        }).join("")}
      </div>`;
    }).join("");
}

function renderNotifSummary() {
  const on = data.series.filter((s) => settings.notif[s.id]);
  $("#notif-summary").innerHTML = on.length
    ? on.map((s) => {
        const n = settings.notif[s.id];
        const kinds = NOTIF_KINDS.filter(([k]) => n[k]).map(([, l]) => l).join(", ") || "aucune session";
        return `<div class="ns-row" style="--c:${s.color}"><i></i><b>${escapeHtml(s.short)}</b><span>${escapeHtml(kinds)}</span></div>`;
      }).join("")
    : `<p class="hint">Aucune série avec 🔔 pour l'instant.</p>`;
  $("#set-notif-delay").innerHTML = ALARM_PRESETS.map((p) =>
    `<button class="pill" data-ndelay="${p.key}" aria-pressed="${settings.notifDelay === p.key}">${p.label}</button>`).join("");
  $("#notif-delay-hint").textContent = ALARM_PRESETS.find((p) => p.key === settings.notifDelay)?.hint || "";

  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let status = "Bientôt disponible : le serveur de notifications est en cours d'installation. Tes choix sont déjà enregistrés.";
  if (ios && !standalone) status = "Sur iPhone, ajoute d'abord l'app à l'écran d'accueil (Safari → Partager → Sur l'écran d'accueil), puis ouvre-la depuis l'icône.";
  $("#notif-status").textContent = status;
}

function setFilter(ids) {
  settings.filter = ids.length ? ids : null;
  save(); render(); renderFilterSheet();
}

function renderList() {
  const list = visibleSessions();
  const now = Date.now();
  if (!list.length) {
    const msg = {
      weekend: ["Pas de course ce week-end", "dans les séries que tu suis. Regarde l'onglet « À venir »."],
      week: ["Semaine calme", "aucune session prévue dans tes séries cette semaine."],
      upcoming: ["Rien à venir", "le calendrier sera complété lors de la prochaine vérification."],
      later: ["Rien de prévu plus tard", "les prochaines dates sont ajoutées à chaque vérification du jeudi."],
    }[settings.view];
    $("#list").innerHTML = `<div class="empty"><b>${msg[0]}</b>${msg[1]}</div>`;
    return;
  }
  const groups = new Map();
  for (const s of list) {
    const k = dayKey(s.sortMs);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  let html = "";
  for (const [, items] of groups) {
    const ms = items[0].sortMs;
    const rel = relDay(ms);
    html += `<div class="day"><div class="day-head ${rel === "Aujourd'hui" ? "today" : ""}">
      <span>${rel ? rel : cap(fDay.format(ms))}</span>${rel ? `<small>${fDayShort.format(ms)}</small>` : ""}</div>`;
    for (const s of items) {
      const past = s.endMs && s.endMs < now;
      const time = s.startMs ? fTime.format(s.startMs) : "--:--";
      html += `
        <article class="session ${past ? "past" : ""}" data-uid="${s.uid}" style="--c:${s.series.color}">
          <div class="s-time">${time}${s.startMs ? "" : "<small>à conf.</small>"}</div>
          <div class="s-main">
            <div class="s-top"><span class="s-series">${escapeHtml(s.series.short)}</span>${statusBadge(s)}</div>
            <div class="s-title">${escapeHtml(s.event.name)}</div>
            <div class="s-kind">${escapeHtml(s.label || KIND_LABEL[s.kind])}</div>
            <div class="tv">${tvBadges(s)}</div>
          </div>
        </article>`;
    }
    html += `</div>`;
  }
  $("#list").innerHTML = html;
}

function renderAlerts() {
  const now = Date.now();
  const active = (data.alerts || []).filter((a) => !a.until || Date.parse(a.until) > now);
  $("#alerts").innerHTML = active.map((a) => `<div class="alert"><span>⚠️</span><div><b>${escapeHtml(a.title)}</b><br>${escapeHtml(a.text)}</div></div>`).join("");
}

function renderFoot() {
  const upd = data.updatedAt ? new Date(data.updatedAt) : null;
  $("#foot").innerHTML = `Horaires à l'heure de ton téléphone (${escapeHtml(deviceTz)})` +
    (upd ? `<br>Dernière vérification : ${cap(fDayShort.format(upd))} à ${fTime.format(upd)}` : "");
}

function render() {
  document.querySelectorAll(".seg").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === settings.view));
  renderAlerts();
  renderHero();
  renderFilter();
  renderList();
  renderFoot();
}

// ---------- Détail ----------
function openDetail(uid) {
  const s = sessions.find((x) => x.uid === uid);
  if (!s) return;
  const ev = s.event;
  const circuitTime = s.startMs
    ? `${fmt({ weekday: "short", hour: "2-digit", minute: "2-digit" }, ev.tz).format(s.startMs)} (heure locale)`
    : "—";
  const when = s.startMs ? `${cap(fDay.format(s.startMs))} à ${fTime.format(s.startMs)}` : `${cap(fDay.format(s.sortMs))} · horaire à confirmer`;
  const tvFr = (s.tv.fr || []).join(", ") || "Aucune chaîne annoncée";
  const tvSt = s.streams.length
    ? `<ul class="links">${s.streams.map((x) => `<li>${x.url
        ? `<a href="${escapeHtml(x.url)}" target="_blank" rel="noopener"><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.platform || "")} ↗</span></a>`
        : `<b>${escapeHtml(x.name)}</b>`}</li>`).join("")}</ul>`
    : "—";
  const sheet = $("#sheet-detail");
  sheet.style.setProperty("--c", s.series.color);
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-head"><span class="detail-series">${escapeHtml(s.series.name)}</span><button class="text-btn" data-close>Fermer</button></div>
    <h2 class="detail-title" id="detail-title">${escapeHtml(ev.name)}</h2>
    <div class="detail-kind">${escapeHtml(s.label || KIND_LABEL[s.kind])} ${statusBadge(s)}</div>
    <dl class="kv">
      <dt>Chez toi</dt><dd>${when}</dd>
      <dt>Sur place</dt><dd>${circuitTime}</dd>
      <dt>Circuit</dt><dd>${escapeHtml([ev.circuit, ev.country].filter(Boolean).join(", "))}</dd>
      ${settings.tvFr ? `<dt>TV France</dt><dd>${escapeHtml(tvFr)}</dd>` : ""}
      ${settings.tvStream ? `<dt>En ligne</dt><dd>${tvSt}</dd>` : ""}
    </dl>
    ${s.note || ev.note ? `<div class="note">${escapeHtml([s.note, ev.note].filter(Boolean).join(" · "))}</div>` : ""}`;
  openSheet(sheet);
}

// ---------- Sheets ----------
function openSheet(el) {
  closeSheets();
  $("#sheet-backdrop").hidden = false;
  el.hidden = false;
}
function closeSheets() {
  $("#sheet-backdrop").hidden = true;
  document.querySelectorAll(".sheet").forEach((s) => (s.hidden = true));
}

// ---------- Réglages ----------
function renderSettings() {
  renderNotifSummary();
  $("#set-essais").checked = settings.kinds.essais;
  $("#set-qualif").checked = settings.kinds.qualif;
  $("#set-sprint").checked = settings.kinds.sprint;
  $("#set-course").checked = true;
  $("#set-tv-fr").checked = settings.tvFr;
  $("#set-tv-stream").checked = settings.tvStream;
  $("#set-summary").checked = settings.summary;
  $("#set-summary-time").value = settings.summaryTime;
  $("#row-summary-time").hidden = !settings.summary;
  $("#settings-meta").textContent = `Données : ${data.events.length} événements · mise à jour ${data.updatedAt ? new Date(data.updatedAt).toLocaleString("fr-FR") : "—"}`;
}

function bindSettings() {
  const onToggle = (id, fn) => $(id).addEventListener("change", (e) => { fn(e.target.checked); save(); renderSettings(); render(); });
  onToggle("#set-essais", (v) => (settings.kinds = { ...settings.kinds, essais: v }));
  onToggle("#set-qualif", (v) => (settings.kinds = { ...settings.kinds, qualif: v }));
  onToggle("#set-sprint", (v) => (settings.kinds = { ...settings.kinds, sprint: v }));
  onToggle("#set-tv-fr", (v) => (settings.tvFr = v));
  onToggle("#set-tv-stream", (v) => (settings.tvStream = v));
  onToggle("#set-summary", (v) => (settings.summary = v));
  $("#set-summary-time").addEventListener("change", (e) => { settings.summaryTime = e.target.value || "20:00"; save(); });
  $("#set-notif-delay").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ndelay]"); if (!b) return;
    settings.notifDelay = b.dataset.ndelay; save(); renderSettings();
  });
  $("#btn-notif-series").addEventListener("click", () => { renderFilterSheet(); openSheet($("#sheet-filter")); });
  $("#btn-notif-enable").addEventListener("click", () => toast("Serveur de notifications pas encore installé"));
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400);
}

// ---------- Démarrage ----------
async function load() {
  try {
    const res = await fetch("data/events.json", { cache: "no-cache" });
    data = await res.json();
  } catch {
    $("#list").innerHTML = `<div class="empty"><b>Hors ligne</b>Impossible de charger le programme.</div>`;
    return;
  }
  sessions = flattenSessions(data);
  render();
  renderSettings();
}

document.querySelector(".segmented").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]"); if (!b) return;
  settings.view = b.dataset.view; save(); render();
});
$("#filter-open").addEventListener("click", () => { renderFilterSheet(); openSheet($("#sheet-filter")); });
$("#filter-clear").addEventListener("click", () => setFilter([]));
$("#filter-reset").addEventListener("click", () => setFilter([]));
$("#filter-list").addEventListener("change", () => {
  setFilter([...document.querySelectorAll("[data-fseries]")].filter((i) => i.checked).map((i) => i.dataset.fseries));
});
$("#filter-list").addEventListener("click", (e) => {
  const bellBtn = e.target.closest("[data-bell]");
  if (bellBtn) {
    const id = bellBtn.dataset.bell;
    const n = { ...settings.notif };
    if (n[id]) delete n[id]; else n[id] = { ...NOTIF_DEFAULT };
    settings.notif = n; save(); renderFilterSheet(); renderNotifSummary();
    return;
  }
  const kindBtn = e.target.closest("[data-nkind]");
  if (kindBtn) {
    const { nseries, nkind } = kindBtn.dataset;
    const cur = { ...settings.notif[nseries], [nkind]: !settings.notif[nseries][nkind] };
    settings.notif = { ...settings.notif, [nseries]: cur };
    save(); renderFilterSheet(); renderNotifSummary();
    return;
  }
  const b = e.target.closest("[data-group]"); if (!b) return;
  const ids = filterableSeries().filter((s) => s.group === b.dataset.group).map((s) => s.id);
  const cur = new Set(settings.filter || []);
  const allOn = ids.every((id) => cur.has(id));
  ids.forEach((id) => (allOn ? cur.delete(id) : cur.add(id)));
  setFilter([...cur]);
});
$("#list").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // lien de diffusion : on le laisse s'ouvrir
  const a = e.target.closest("[data-uid]"); if (a) openDetail(a.dataset.uid);
});
$("#btn-settings").addEventListener("click", () => { renderSettings(); openSheet($("#sheet-settings")); });
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target.id === "sheet-backdrop") closeSheets(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && data) load(); });

bindSettings();
load();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
