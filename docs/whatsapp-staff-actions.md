# Actions du staff depuis WhatsApp — Trigenys Notify

Étape 3 de l'ADR-003 de Xeption (issue #68). Une réaction ou une réponse citée sous une alerte, dans un groupe approuvé, est relayée signée au projet qui a émis l'alerte. Le projet décide. Notify ne fait que transporter le geste et publier la ligne de suivi.

## Comportement

- Le webhook `/v1/whatsapp/groups/webhook` accepte aussi `message.reaction` et `message`. La signature WAHA (`x-webhook-hmac`, sha512) et la session sont vérifiées comme pour les événements de groupe.
- Seuls les groupes ayant une route **approuvée et active** sont lus. Les messages envoyés par Notify lui-même (`fromMe`) et les discussions directes sont ignorés.
- Corrélation : `reaction.messageId` ou le message cité → clé courte `(session, provider_message_id)` → reçu `accepted` du même groupe → `(project, event_id)`. Une réponse qui cite une ligne de suivi est retrouvée par la table de la migration 0007. Un geste non corrélé est ignoré sans réponse.
- Seules deux formes de texte sont relayées : une réponse citée qui correspond à `replyPattern` (défaut `^[1-9]$`) et un code de liaison qui correspond à `linkPattern` (défaut `XL-XXXX-XXXX`, insensible à la casse, relayé en majuscules, `gesture:"link"`, `eventId` vide). Le texte libre n'est jamais transmis.
- Corps relayé (≤ 4 Ko, `value` ≤ 64 caractères, `id` ≤ 128) :
  `{"version":1,"id","eventId","groupKey","actor":{"fingerprint"},"gesture","value"}`.
  - `id` : clé courte du geste WhatsApp, sans numéro.
  - `actor.fingerprint` : HMAC-SHA256 (clé d'empreinte du projet) de l'auteur normalisé (`<chiffres>@c.us` sans suffixe d'appareil, ou `<id>@lid`).
  - `groupKey` : HMAC-SHA256 de `group:<session>:<groupId>`, opaque.
- En-têtes : `x-notify-timestamp` (ms) et `x-notify-signature` = HMAC-SHA512 hexadécimal (clé de signature du projet, espaces retirés) de `${timestamp}.${corps brut}`. Vecteur partagé avec Xeption : `test/core/whatsapp-staff-actions.test.ts`.

## Réponses du projet et réessais

| Réponse du projet | Effet côté Notify |
|---|---|
| 200 avec `outcome` | Ligne de suivi publiée si l'issue en prévoit une, aucun réessai |
| 429, 5xx sauf 503, erreur réseau, délai de 10 s | Le webhook répond 503 : WAHA redélivre, le projet déduplique sur `id` |
| 401, 400, 503 ou autre | Aucun réessai, seul le code est journalisé |

## Ligne de suivi `order.action_recorded`

Publiée en réponse citée sous l'alerte (sous rien pour une liaison), titre `*Suivi commande*`, sans emoji. Seuls le prénom (40 caractères max, mise en forme retirée), le motif (80), la tentative et l'heure locale (`timeZone`, défaut `Africa/Douala`) sont repris. Issues avec message : `delivered`, `cash_delivered`, `unreachable`, `cancelled`, `reason_required` (« répondez à ce message par un chiffre de 1 à 5 »), `needs_payment`, `closed`, `not_linked` (au plus une fois par jour et par auteur), `cancel_forbidden`, `linked`, `invalid_code`. `duplicate`, `ignored` et toute issue inconnue restent silencieuses.

## Configuration (déclarative, aucun nom de projet dans le code)

Variables du Worker :

```jsonc
"WHATSAPP_ACTIONS_ENABLED": "false",
"WHATSAPP_ACTION_RELAYS_JSON": "{\"xeption\":{\"url\":\"https://…/functions/v1/notify-staff-action\"}}"
```

Champs facultatifs par projet : `signingKeySecret`, `fingerprintKeySecret`, `replyPattern`, `linkPattern`, `timeZone`. URL HTTPS obligatoire ; une entrée invalide est ignorée avec un avertissement.

Secrets (noms seulement, valeurs transmises en privé par l'opérateur, jamais dans une issue, un commit ou un journal) :

- `<PROJET>_NOTIFY_ACTION_KEY` — clé de signature partagée avec le projet (≥ 32 caractères). Pour Xeption : `XEPTION_NOTIFY_ACTION_KEY`.
- `<PROJET>_ACTOR_FINGERPRINT_KEY` — clé d'empreinte propre à Notify (≥ 32 caractères). Le projet ne la connaît pas ; il associe une empreinte à un compte par le code de liaison.

Sans l'une des deux clés, rien n'est relayé (`notify.staff_action … not_configured`).

## Journaux

Uniquement `notify.staff_action {project, gesture, outcome}` et des codes d'erreur. Jamais de numéro, de texte, d'empreinte, de signature ni de valeur.

## Mise en service (dans cet ordre, chaque étape sur accord explicite)

1. Migration `0007_whatsapp_staff_actions.sql` (additive). Sans elle, le relais fonctionne mais les réponses à une ligne de suivi ne sont pas corrélées et le rappel `not_linked` n'est pas envoyé.
2. Côté Xeption : endpoint `notify-staff-action` déployé avec la même clé de signature.
3. Secrets du Worker, puis déploiement avec `WHATSAPP_ACTIONS_ENABLED` encore à `false`.
4. Session WAHA : abonner le webhook aux événements `message.reaction` et `message` (modification du VPS).
5. Passer `WHATSAPP_ACTIONS_ENABLED` à `true`, puis faire le test de fumée de `waha-smoke-test.md` §5.

Le cron purge les lignes expirées (suivis 7 jours, rappels 3 jours), 200 au plus par table et par passage.
