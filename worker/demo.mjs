// Envoie une notification d'exemple « course dans 15 min » à tous les appareils abonnés.
// Usage (dans GitHub Actions) : node demo.mjs subs.json vapid.json
import { readFileSync } from "node:fs";
import { sendPush } from "./src/webpush.js";
import { flatten } from "./src/index.js";

const [subsFile, vapidFile] = process.argv.slice(2);
const subs = JSON.parse(readFileSync(subsFile, "utf8"));
const vapid = JSON.parse(readFileSync(vapidFile, "utf8"));
const data = await (await fetch(`https://a8a-arch.github.io/paddock/data/events.json?t=${Date.now()}`)).json();

const now = Date.now();
const races = flatten(data).filter((s) => s.kind === "course" && Number.isFinite(s.startMs) && s.startMs > now)
  .sort((a, b) => a.startMs - b.startMs);

const cache = {};
let sent = 0;
for (const sub of Object.values(subs)) {
  const tz = sub.settings.tz || "Europe/Paris";
  const mine = races.find((s) => sub.settings.notif?.[s.series]) || races[0];
  const start = now + 15 * 60_000;
  const time = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(start);
  const status = await sendPush(vapid, sub.sub, {
    title: `${mine.short} · ${mine.label}`,
    body: `${mine.event} — dans 15 min, départ à ${time}`,
    tag: "demo",
    url: "https://a8a-arch.github.io/paddock/",
  }, cache);
  console.log(`appareil : réponse ${status}`);
  if (status >= 200 && status < 300) sent++;
}
console.log(`${sent} notification(s) envoyée(s)`);
