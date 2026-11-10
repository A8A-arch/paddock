// L'abonnement calendrier est arrêté (remplacé par les notifications push).
// On publie des calendriers VIDES aux mêmes adresses : un iPhone encore abonné efface ainsi
// les anciens événements et leurs rappels, au lieu de les garder indéfiniment.
// Lancé automatiquement par GitHub Actions. Usage local : node scripts/build-ics.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildICS, SUB_ALARMS, subscriptionFile } from "../js/ics.js";

const root = new URL("../", import.meta.url);
const data = JSON.parse(readFileSync(new URL("data/events.json", root), "utf8"));
const outDir = new URL("calendar/", root);
mkdirSync(outDir, { recursive: true });

const empty = buildICS({ ...data, events: [] }, {
  name: "A8A Paddock – Courses (arrêté)",
  alarms: [],
  kinds: [],
  summary: { enabled: false, time: "20:00", tz: "Europe/Paris" },
});

let n = 0;
for (const alarmKey of Object.keys(SUB_ALARMS)) {
  for (const qualif of [true, false]) {
    for (const summary of [true, false]) {
      writeFileSync(new URL(subscriptionFile({ alarmKey, qualif, summary }), outDir), empty);
      n++;
    }
  }
}
console.log(`${n} calendriers vides publiés dans calendar/`);
