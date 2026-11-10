// Génère les calendriers d'abonnement (calendar/*.ics) à partir de data/events.json.
// Lancé automatiquement par GitHub Actions à chaque mise à jour du dépôt.
// Usage local : node scripts/build-ics.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildICS, SUB_ALARMS, subscriptionFile } from "../js/ics.js";

const root = new URL("../", import.meta.url);
const data = JSON.parse(readFileSync(new URL("data/events.json", root), "utf8"));
const outDir = new URL("calendar/", root);
mkdirSync(outDir, { recursive: true });

let n = 0;
for (const alarmKey of Object.keys(SUB_ALARMS)) {
  for (const qualif of [true, false]) {
    for (const summary of [true, false]) {
      const ics = buildICS(data, {
        name: "A8A Paddock – Courses",
        alarms: SUB_ALARMS[alarmKey],
        kinds: qualif ? ["qualif", "sprint", "course"] : ["sprint", "course"],
        summary: { enabled: summary, time: "18:00", tz: "Europe/Paris" },
      });
      writeFileSync(new URL(subscriptionFile({ alarmKey, qualif, summary }), outDir), ics);
      n++;
    }
  }
}
console.log(`${n} calendriers générés dans calendar/`);
