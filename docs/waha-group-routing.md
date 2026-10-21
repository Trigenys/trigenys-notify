# Routage WhatsApp multitenant — Trigenys Notify

## Fonctionnement

1. Le compte WhatsApp WAHA NOWEB rejoint un groupe.
2. WAHA émet **group.v2.join**, **group.v2.leave**, **group.v2.update** via webhook SHA-512 HMAC.
3. Trigenys Notify vérifie signature, horodatage (< 5 minutes), session et identifiant de groupe, puis conserve ce groupe dans **D1**.
4. Le groupe est uniquement **découvert** (aucun envoi automatique). Un administrateur Trigenys l'associe explicitement à un projet via API admin. Le nom ne fait pas foi : il peut changer ou être imité.
5. Les événements de chaque projet recherchent le groupe approuvé, par identifiant technique. À la sortie d'un groupe, le routage associé est immédiatement désactivé.
6. Xeption conserve provisoirement sa boîte d'envoi et transmet à Trigenys Notify comme avant.

**Important :** le routage D1 prend autorité pour Xeption dès que le binding NOTIFY_DB est branché. Préparer et approuver la route du groupe historique avant d'activer D1 en production, sinon les notifications Xeption renverront \`GROUP_ROUTE_UNASSIGNED\` (aucun envoi au mauvais groupe).

Le fournisseur et la clé WAHA restent du côté **Trigenys Notify Cloudflare Worker** ; Xeption ne reçoit que son secret d'ingestion.

## Pré-requis d'infrastructure (non automatisés par ce code)

- Une base Cloudflare D1 dédiée, p.ex. \`trigenys-notify-routing\`, créée sur le compte où tourne le Worker.
- La lier au Worker avec le binding exact **NOTIFY_DB** et \`migrations_dir: "migrations"\` dans \`backend/wrangler.production.jsonc\`. Ne jamais écrire un faux UUID ni l'inventer.
- Appliquer \`backend/migrations/0001_whatsapp_groups.sql\` à **la D1 de Trigenys**, jamais à Supabase Xeption. Commandes après avoir ajouté les vrais identifiants D1 :

  \`\`\`sh
  cd backend
  npx wrangler d1 migrations apply trigenys-notify-routing --remote --config wrangler.production.jsonc
  \`\`\`

- Secrets Cloudflare Worker :
  - \`WAHA_WEBHOOK_HMAC_KEY\` (chaîne aléatoire >= 32 caractères, différente de WAHA_API_KEY et XEPTION_NOTIFY_INGEST_KEY)
  - \`NOTIFY_ADMIN_KEY\` (chaîne aléatoire >= 32 caractères, différente des autres)
  - \`WAHA_API_KEY\` = exactement la clé actuelle dans le \`.env\` du VPS
  - \`WAHA_BASE_URL=https://notify.trigenys.com\` et \`WAHA_SESSION=trigenys-test\` déjà dans le fichier Wrangler.

**Avant cela :** la vérification sur VPS \`POST /api/sendText\` avec session inexistante retourne **422** (clé VPS valide) mais la clé utilisée dans le Worker renvoyait **401**. Corriger WAHA_API_KEY côté Cloudflare, sans le mélanger à XEPTION_NOTIFY_INGEST_KEY. Aucun secret en GitHub, chat, ou variable publique.

## Configuration webhook WAHA (sur VPS, pas dans Caddy)

WAHA peut envoyer directement des requêtes HTTPS sortantes vers le Worker, même si sa propre API reste fermée au public (Caddy n'autorise que POST /api/sendText).

Pour recevoir les événements de toutes les sessions, ajouter au \`compose.yaml\` de WAHA les variables **global webhooks** suivantes, avec la clé HMAC enregistrée séparément dans le \`.env\` local :

\`\`\`yaml
environment:
  WHATSAPP_HOOK_URL: https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev/v1/whatsapp/groups/webhook
  WHATSAPP_HOOK_EVENTS: group.v2.join,group.v2.leave,group.v2.update
  WHATSAPP_HOOK_HMAC_KEY: \${WAHA_WEBHOOK_HMAC_KEY}
  WHATSAPP_HOOK_RETRIES_POLICY: exponential
  WHATSAPP_HOOK_RETRIES_ATTEMPTS: "4"
\`\`\`

Ces paramètres s'ajoutent aux variables déjà existantes, ils ne les remplacent pas. Avant \`docker compose up -d\`, vérifier la persistance de la session WAHA (volumes) et sauvegarder la configuration. Le redémarrage peut déconnecter le compte si la session n'est pas persistée.

Source WAHA : https://waha.devlike.pro/docs/how-to/events/ (group.v2.join, HMAC X-Webhook-Hmac sha512, timestamps).

## Import initial de TRIGENYS GROUP

La découverte par événement ne récupère pas nécessairement les groupes rejoints **avant** l'installation du webhook. Pour importer une fois la liste sans générer de messages :

- Lire **localement** \`GET /api/trigenys-test/groups?limit=100&exclude=participants\` sur \`127.0.0.1:3000\` avec la clé WAHA locale.
- Transformer la réponse NOWEB (liste ou objet indexé par IDs) en tableau \`{id,subject}\`.
- \`POST /v1/whatsapp/groups/import\` (Worker) avec \`x-notify-admin-key\`, JSON \`{"session":"trigenys-test","groups":[{"id":"...@g.us","subject":"TRIGENYS GROUP"}]}\`.
- Confirmer dans \`GET /v1/whatsapp/groups\` que la liste existe. **L'import ne configure aucun destinataire.**

## Administration des affectations

API de gestion exclusivement serveur, protégée par \`x-notify-admin-key\` (ne jamais lancer dans le navigateur avec ce secret exposé).

\`\`\`
GET  /v1/whatsapp/groups
POST /v1/whatsapp/groups/import
POST /v1/whatsapp/routes
\`\`\`

Pour affecter à Xeption après import :

\`\`\`json
{
  "project":"xeption",
  "session":"trigenys-test",
  "groupId":"ID_OFFICIEL_TRIGENYS_GROUP@g.us"
}
\`\`\`

Les projets initialement autorisés pour l'association sont \`xeption\`, \`atelier-maitre\` et \`commerce-factory\`. L'association n'ajoute PAS de nouvel expéditeur ni de destination arbitraire par message. L'API de dispatch active est actuellement celle de Xeption : chaque nouveau produit aura son propre connecteur authentifié et sa politique de validation d'événements.

## Tests

- Une signature incorrecte, expirée ou une session différente doit obtenir 401/400 ; aucun groupe ajouté.
- L'ajout d'un groupe signé crée une découverte non associée.
- Sans approbation, aucun envoi ; Xeption ne doit jamais basculer sur le groupe d'Atelier Maître.
- L'approbation de Xeption active son ID de groupe ; le départ de ce groupe désactive le routage.
- Les anciens événements ne sont pas rejoués ; le module de routage n'altère pas la boîte d'envoi Xeption.

Ne pas exposer la gestion des sessions, des QR codes ou la liste de groupes WAHA par Caddy. La liaison groupe-projet exige une décision administrateur, même si la découverte est automatique.
