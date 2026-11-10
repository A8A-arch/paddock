# A8A Paddock

Web app (PWA) qui regroupe les courses auto et moto de la semaine : horaires à l'heure de ton téléphone, chaînes TV France et streaming, rappels via le Calendrier iPhone.

- **App** : `index.html`, `css/`, `js/` (aucune compilation nécessaire)
- **Données** : `data/events.json`, mis à jour par la routine Claude (voir `ROUTINE.md`)
- **Calendriers d'abonnement** : générés par `scripts/build-ics.mjs` lors de la publication GitHub
- **Test local** : `powershell -ExecutionPolicy Bypass -File scripts/serve.ps1`, puis ouvrir http://localhost:8080
- **En ligne** : https://a8a-arch.github.io/paddock/
