# Routage WhatsApp multigroupe — Trigenys Notify

## Comportement

- WAHA est interrogé automatiquement toutes les cinq minutes, et avant un dispatch lorsque le cache de découverte dépasse une minute. Les webhooks signés restent utilisables.
- Les réponses WAHA sous forme de listes, d'enveloppes ou d'objets NOWEB indexés par identifiant sont prises en charge, avec pagination et contrôle du nombre de groupes.
- Les noms suggèrent un projet (casse, accents et séparateurs ignorés). **La découverte ne donne jamais le droit d'envoyer.**
- Les associations approuvées vivent dans D1, avec une clé `(project,session,group_id)` : plusieurs groupes d'un même projet coexistent. Une approbation répétée est idempotente.
- Le dispatch envoie à tous les groupes approuvés et disponibles pour Xeption. Il ne sélectionne pas le premier groupe portant le nom du projet.
- Le groupe `WAHA_STAFF_GROUP_ID` reste un secours. Il ne s'utilise que pour un projet inclus dans `WAHA_FALLBACK_PROJECTS`, après une découverte réussie, sans candidat en attente ni route existante/révoquée. Une panne WAHA ou D1 ne déclenche jamais un changement de groupe.
- Un départ désactive les associations du groupe. Un retour dans ce groupe ne rétablit pas son approbation.
- La liste des destinataires est figée par événement. Les réessais ne renvoient pas aux groupes ayant déjà accepté le message, et ne diffusent pas les anciennes alertes aux groupes approuvés entre-temps.

La source conserve son outbox actuelle. Les reçus D1 ne constituent pas une nouvelle file d'envoi et n'affectent pas Telegram. Un crash entre l'acceptation WAHA et l'enregistrement D1 peut encore produire un doublon ; aucune garantie exactly-once n'est revendiquée.

## Mise en service du Worker staging

Le fichier `backend/wrangler.production.jsonc` lie `NOTIFY_DB` à la base dédiée `trigenys-notify-routing-staging` (`f29535b5-3cea-4be9-87b5-c682bc7967bd`) et déclare la politique de secours et le cron. Les trois migrations ont été appliquées par le contrôle d'infrastructure autorisé et enregistrées dans `d1_migrations`. Aucun secret n'est écrit dans le dépôt.

Les mises à jour du Worker passent par le circuit AppFactory/OIDC et Workers Builds existant. Le build valide le code et utilise une D1 locale pour ses tests ; il ne crée pas de base distante. Cela préserve les droits existants du jeton de déploiement, qui ne possède pas les droits d'administration D1.

Le déclencheur sur `main` surveille `backend/**`, `src/**`, `web/**`, les manifestes npm racine et `.appfactory/**`, afin que les modifications du cœur partagé déclenchent aussi le déploiement.

Une évolution de schéma se prépare séparément, avant le déploiement du code qui en dépend. L'opérateur disposant du droit D1 existant peut utiliser `NOTIFY_ROUTING_PROVISION=true npm run routing:provision` dans `backend` avec son identifiant d'accès déjà configuré dans l'environnement. Cette commande retrouve la base et applique les migrations manquantes ; elle ne tourne jamais pendant `npm run check`.

Les migrations conservent les approbations existantes. La migration staging `0003_staging_xeption_route.sql` initialise uniquement l'association confirmée par Jennifer :

- `Xeption app test` : `120363432964279423@g.us`, session `trigenys-test`, projet `xeption`.
- L'ancien groupe `TRIGENYS GROUP` cesse d'être une association Xeption ; sa valeur dans les secrets reste un secours.

Cette migration staging ne doit pas être réutilisée pour amorcer une autre installation.

Secrets déjà utilisés : `WAHA_API_KEY`, `XEPTION_NOTIFY_INGEST_KEY`, `WAHA_STAFF_GROUP_ID`. L'administration utilise un unique `NOTIFY_ADMIN_KEY` indépendant, aléatoire et d'au moins 32 caractères, configuré une fois. `WAHA_WEBHOOK_HMAC_KEY` est nécessaire uniquement pour les webhooks.

Un ajout de groupe se fait via l'API d'approbation : **aucun nouveau secret Cloudflare par groupe.**

## Accès WAHA pour la découverte automatique

Les deux routes de lecture sont actives depuis le 22 octobre 2026. Le workflow `WAHA VPS operations` a validé puis rechargé Caddy ; les lectures sans clé retournent 401, avec l'authentification `X-Api-Key` conservée. La synchronisation planifiée a ensuite enregistré dans D1 `TRIGENYS GROUP` et `Xeption app test`. Seul `Xeption app test` possède une association Xeption approuvée ; le groupe général reste le secours configuré.

Le bloc suivant est installé dans le site Caddy `notify.trigenys.com`, avant le refus par défaut :

```caddyfile
@notify_group_discovery {
    method GET
    path /api/trigenys-test/groups /api/trigenys-test/groups/count
}
handle @notify_group_discovery {
    reverse_proxy 127.0.0.1:3000
}
```

Valider la configuration Caddy puis la recharger. Ne pas remplacer tout le fichier. Ce bloc n'ouvre ni QR codes, ni sessions, ni participants individuels, ni administration WAHA.

Autre option : conserver ces lectures fermées et configurer les webhooks WAHA sortants `group.v2.join`, `group.v2.leave`, `group.v2.update` vers `https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev/v1/whatsapp/groups/webhook`, signés SHA-512 avec `WAHA_WEBHOOK_HMAC_KEY`. Importer les groupes existants une seule fois via l'API d'import.

## API d'administration

Toutes les opérations suivantes exigent `x-notify-admin-key`. Le secret reste côté serveur.

```text
GET  /v1/whatsapp/groups
POST /v1/whatsapp/groups/sync
POST /v1/whatsapp/groups/import
POST /v1/whatsapp/routes
```

`groups/sync` force une découverte sans aucun message. `GET groups` expose les associations et `suggestedProjects`. Les suggestions `Xeption Clients`, `Xeption Dev`, etc. restent en attente tant qu'un administrateur ne les a pas approuvées.

Pour ajouter une association, répéter cette opération pour chaque groupe voulu ; l'association précédente est conservée :

```json
{"project":"xeption","session":"trigenys-test","groupId":"120363432964279423@g.us"}
```

Pour révoquer cette association sans retirer les autres groupes :

```json
{"project":"xeption","session":"trigenys-test","groupId":"120363432964279423@g.us","enabled":false}
```

L'import initial accepte `{"session":"trigenys-test","groups":[{"id":"...@g.us","subject":"Nom du groupe"}]}` et n'approuve rien. Les projets de l'API sont `xeption`, `atelier-maitre`, `commerce-factory` ; un nouveau connecteur d'ingestion reste nécessaire pour expédier les événements des autres produits.

## Vérification

`npm run check` exécute les tests de contrats, routage, migrations SQLite, réessais et non-régression Telegram. Dans `backend`, `npm run check` valide les types, le bundle et le parcours complet Worker/D1 avec fournisseur simulé, sans message réel.

Après déploiement : `/health` annonce `whatsappRouting=multigroup-v1` et `whatsappRegistry=d1`. Une réponse HTTP 202 du dispatch signifie que tous les destinataires restants ont accepté l'événement. Les détails fournisseur et les identifiants de groupe ne sont jamais renvoyés à la source.

Références : https://waha.devlike.pro/docs/how-to/groups/ et https://waha.devlike.pro/docs/how-to/events/

## Veille de la session WAHA

Le cron de 5 minutes du Worker synchronise les groupes, puis `src/core/waha-watchdog.ts` décide s'il faut prévenir l'opérateur. Une synchronisation réussie compte comme « session saine » ; l'heure de la dernière réussite est `notify_whatsapp_discovery.last_synced_ms`. Aucune table ni migration supplémentaire.

- Panne : une alerte Telegram après 10 minutes, puis une toutes les 6 heures tant que la panne dure. Le message donne l'état WAHA (`SCAN_QR_CODE`, `STOPPED`, `FAILED`, serveur injoignable…) et l'action à faire.
- Retour : un message « WhatsApp rétabli » avec la durée de la coupure.
- L'alerte part sur Telegram, jamais sur WhatsApp, puisque c'est ce canal qui est en panne.
- Configuration : secrets `TELEGRAM_BOT_TOKEN` (bot Xeption existant) et `OPS_TELEGRAM_CHAT_ID` (conversation privée de l'opérateur, qui doit avoir écrit `/start` au bot). Sans ces secrets, la veille reste muette et journalise `notify.waha_watchdog_alert_unconfigured`.
- Limite connue : si un envoi Xeption resynchronise les groupes avant le cron juste après le retour de la session, le message « rétabli » peut manquer. L'alerte de panne, elle, ne dépend pas de ce cas.

## Restreindre un type d'événement à certains groupes

`WAHA_EVENT_GROUPS_JSON` (variable du Worker, `backend/wrangler.production.jsonc`) associe un type à une liste de groupes : `{"report.weekly_digest":["120363...@g.us"]}`. Module `src/core/event-groups.ts`.

- Le réglage **restreint** seulement : un type listé n'atteint que les groupes listés **déjà routés** vers le projet (`notify_whatsapp_routes`, `enabled=1`). Il n'ajoute jamais de destination ; le groupe visé doit donc d'abord être une route active du projet.
- Un type absent du réglage garde tous les groupes routés (comportement inchangé).
- Réglage mal formé, ou aucun groupe restant : refus `503` (`EVENT_ROUTING_INVALID` / `GROUP_ROUTE_UNASSIGNED`), jamais une diffusion large. L'émetteur réessaie.
- Valeur actuelle : le bilan hebdomadaire Xeption (`report.weekly_digest`) part seulement dans le groupe de test. Pour l'ouvrir au groupe Administration, ajouter son identifiant à la liste (ou retirer la clé) puis redéployer le Worker.
