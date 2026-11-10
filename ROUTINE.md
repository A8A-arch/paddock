# Consignes de la routine « Vérif Paddock »

Planning (heure de Paris), 3 exécutions par semaine :
- **jeudi 18h** : environ 12 à 16 h avant les premières sessions du vendredi, et avant le résumé du week-end envoyé la veille à 20h ;
- **samedi 7h** et **dimanche 7h**.
Dépôt : `A8A-arch/paddock`, branche `main`.

---

Tu mets à jour le calendrier de l'app Paddock (`data/events.json`). C'est la seule source de vérité de l'app et du serveur de notifications (qui relit ce fichier chaque minute et prévient les abonnés si un horaire change). Chaque push sur `main` republie automatiquement l'app.

## Ce que tu fais selon le jour

- **Jeudi** : vérification complète du week-end à venir (vendredi à dimanche) **et** ajout des événements des 3 semaines suivantes qui manquent.
- **Samedi / dimanche matin** : recontrôle des sessions des prochaines 48 h uniquement (horaires, chaînes, retards, annulations).

## Séries à couvrir

F1, F2, F3, Formule E, IndyCar, FIA FR World Cup (Grand Prix de Macao), FIA GT World Cup, WEC (dont Le Mans), IMSA, ELMS, IGTC (Bathurst 12h, Spa 24h, Suzuka 1000 km, Indianapolis 8h…), GT World Challenge Europe, America, Asia et Australia, 24h du Nürburgring et NLS, autres classiques d'endurance (Daytona, Sebring, Gulf 12h…), DTM, Supercars, NASCAR Cup, WRC, MotoGP, Moto2, Moto3 et WorldSBK.

**Noms** : le champ `series` porte le nom exact du championnat (la liste est dans `series` de events.json, ajoute une série si besoin). Le champ `name` de l'événement porte le nom de la course ou du lieu (« Macao », « Sandown 500 », « GP du Portugal »).

## Sessions à enregistrer

`essais` (essais libres, practice, warm-up), `qualif`, `sprint` et `course`. Les essais sont affichés dans l'app ; chaque utilisateur choisit s'il veut être notifié : ne change rien.

## Vérifier chaque information

1. **Horaire** : source officielle en priorité (formula1.com, motogp.com, fiawec.com, sro-motorsports.com/gt-world-challenge, wrc.com, fiaformulae.com…). Stocke `start` en **UTC ISO** (`2026-11-22T13:00:00Z`) et vérifie la conversion avec le fuseau `tz` du circuit.
2. **Chaîne TV France** : grille officielle Canal+ / myCANAL, L'Équipe, Eurosport / HBO Max, beIN… Donne la chaîne précise quand elle est connue (« Canal+ Sport 360 » plutôt que « Canal+ »).
3. **Streaming international** : F1 TV, MotoGP VideoPass, WEC TV / FIAWEC+, chaîne YouTube GT World, Supercars Plus… Chaque diffusion en ligne doit avoir **sa plateforme et un lien direct cliquable**. Dans `links`, ajoute `{ "name", "platform": "YouTube" | "Site officiel …", "url" }`, puis référence sa clé dans `tv.stream`. Pour un direct YouTube, mets le lien de la vidéo du direct dès qu'il est publié, sinon celui de la chaîne. Vérifie que chaque lien fonctionne.
4. Croise **au moins 2 sources** pour un horaire. Si elles divergent ou qu'il n'y a pas de source officielle : `status: "provisoire"`. Si aucun horaire n'est trouvé : mets `date` (sans `start`) et `status: "tbc"`.

## Statuts

`confirme` · `provisoire` · `tbc` · `retarde` (mets à jour `start` avec la nouvelle heure et ajoute une `note`) · `annule`.

## Alertes

En cas de retard, d'annulation ou de changement de chaîne de dernière minute, ajoute une alerte dans `alerts` :

```json
{ "id": "2026-11-22-vegas-retard", "title": "GP de Las Vegas retardé", "text": "Départ décalé à 06h30 (heure FR) à cause de la pluie.", "until": "2026-11-23T00:00:00Z" }
```

Supprime les alertes dont la date `until` est passée.

## Règles

- Ne supprime jamais un événement passé de moins de 7 jours. Tu peux supprimer ceux de plus de 30 jours.
- Garde des `id` stables : un `id` modifié fait perdre le suivi des changements d'horaire (et donc les alertes). Format : `AAAA-serie-lieu`.
- Mets à jour `updatedAt` (UTC) et `checkedBy` (par exemple « Routine jeudi »).
- Vérifie que le JSON est valide avant de committer.
- Message de commit : `Vérif <jour> : <résumé des changements>`. S'il n'y a aucun changement, mets seulement `updatedAt` à jour et commite quand même.
- Termine par un résumé court : événements ajoutés, horaires modifiés, points incertains.
