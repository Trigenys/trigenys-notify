# Trigenys Notify — centralisation du canal WhatsApp

**Objectif :** Trigenys Notify orchestre les fournisseurs de notifications; chaque produit Trigenys conserve ses événements métier. Le premier produit raccordé est Xeption, déjà pourvu d'une boîte d'envoi persistante.

**Mise à jour du 21 octobre :** le routage multigroupe, l'association Xeption et les reçus par destinataire sont décrits dans [waha-group-routing.md](waha-group-routing.md). Les étapes ci-dessous documentent le raccordement initial du 20 octobre ; les groupes approuvés D1 passent désormais avant le secours Cloudflare.

## État au 20 octobre 2026

- WAHA NOWEB est opérationnel sur le VPS OVH, session `trigenys-test` : `WORKING`.
- Le message de test a été reçu dans TRIGENYS GROUP.
- Caddy protège `https://notify.trigenys.com` : seul POST /api/sendText est relayé vers `127.0.0.1:3000`.
- Trigenys Notify expose `POST /v1/dispatch/xeption/whatsapp` sur son Worker Cloudflare. **L'envoi reste désactivé** jusqu'à la configuration des secrets Cloudflare et un test source contrôlé.
- Xeption a un adaptateur WAHA direct déjà mergé et un relais Supabase. **Ne jamais activer ce canal direct en parallèle.**

## Architecture retenue

`Xeption (outbox + retry)` -> (HTTPS + clé spécifique Xeption) -> `Trigenys Notify Worker` -> (clé API WAHA) -> `notify.trigenys.com` -> `Caddy -> WAHA sur OVH`.

Pour le premier raccordement, **la file persistante et la déduplication restent dans Xeption** : Trigenys Notify n'a pas encore de queue D1/Queues multi-tenant. La plate-forme centralise le choix du fournisseur, les modèles sûrs, la configuration du canal et les secrets de transport. À terme, on pourra migrer les files dans Trigenys Notify sans modifier les contrats d'événements.

## Contrat du point d'entrée

URL (staging): `https://trigenys-notify-staging-api.lawrynnjennifer.workers.dev/v1/dispatch/xeption/whatsapp`

- POST uniquement
- Header `x-notify-auth: <secret-spécifique-Xeption>`, au moins 32 caractères
- Content-Type `application/json`, body 4096 octets maximum
- Corps : `NotifyEventV1` depuis `src/core/contracts.ts`
- `project=xeption`, seuls les types officiellement mappés autorisés et origine d'action `https://www.xeptionetwork.shop`
- Mise en forme côté Trigenys Notify à partir de `facts`, un instantané métier optionnel et contrôlé : produit, stock restant, auteur connu ; état/offres/cible pour le troc et configuration/grade/prix/ville pour la marketplace. Les anciens événements sans faits gardent leur message générique. Aucun titre/message brut ni champ client n'est transmis.
- HTTP 202 = fournisseur WAHA a accepté le message. Erreur 503 = le canal est désactivé ou fournisseur temporairement indisponible, ne pas traiter comme une livraison. Erreur 400/401 = configuration/contrat incorrect.

Le point d'entrée n'est **pas une API publique de notification** et ne doit jamais être appelé depuis le navigateur, une Mini App Telegram ni un endpoint utilisateur. Le secret reste côté serveur.

Depuis le 22 octobre, le producteur Xeption utilise la date `admin_notifications.created_at`, relue en un lot pour WhatsApp, et les détails déjà enregistrés dans le message de l'événement. Il ne consulte pas le stock courant pour réécrire une ancienne alerte et ne recrée pas sa date à chaque réessai.

Les champs inconnus sont ignorés ; les champs reconnus ont des types et des tailles bornés. Les fragments client/contact sont exclus à la source, et les labels contenant des coordonnées ou des URL sont refusés à la réception. L'ancien stock n'est pas inventé : l'événement actuel ne le capture pas. Le destinataire et les règles de secours restent indépendants du contenu. Déployer le consommateur compatible avant le producteur enrichi.

## Configuration Cloudflare de Trigenys Notify

Secrets **Cloudflare Worker** (pas des variables publiques de l'application ni un commit GitHub) :

| Secret | Rôle |
|---|---|
| `XEPTION_NOTIFY_INGEST_KEY` | clé indépendante générée pour Xeption, >= 32 caractères |
| `WAHA_BASE_URL` | `https://notify.trigenys.com` |
| `WAHA_API_KEY` | clé du `.env` sur le VPS, sans la publier |
| `WAHA_SESSION` | `trigenys-test` |
| `WAHA_STAFF_GROUP_ID` | identifiant du groupe de secours suffixé par `@g.us`, jamais la route prioritaire |
| `WAHA_DISPATCH_ENABLED` | initialement `false`, puis `true` uniquement pendant le cutover contrôlé |

La clé fournisseur WAHA doit être détenue par **Trigenys Notify**, pas par Xeption à terme. Les secrets WAHA déjà saisis dans Supabase sont temporaires : les retirer **après** confirmation du transfert et de la désactivation du connecteur WAHA direct côté Xeption. Ne pas modifier Telegram.

## Cutover Xeption

1. Vérifier que le Worker Cloudflare déploie le nouveau code et retourne 401 sans authentification, 503 quand l'authentification est correcte mais que la bascule est désactivée.
2. Configurer la même `XEPTION_NOTIFY_INGEST_KEY` dans **Xeption Supabase**, seule information d'accès à Notify dont il aura besoin.
3. Changer `_shared/staffNotifyChannels/waha.ts` de Xeption pour appeler l'API Trigenys Notify via sa clé propre, **sans utiliser directement** la clé WAHA fournisseur ni l'URL du VPS. Garder son channel id stable `whatsapp_waha` pour conserver les statuts de l'outbox.
4. Avant activation, exclure les anciennes notifications de Xeption : la fonction `claim_notification_deliveries` crée automatiquement des livraisons pour les événements des 24 dernières heures. Amorcer les entrées antérieures sans spam, après inspection des données.
5. Une fois le secret valide, activer `WAHA_DISPATCH_ENABLED=true` **dans Cloudflare**, puis `WAHA_ENABLED=true` dans Xeption seulement après l'amorçage. Ne jamais conserver deux chemins actifs.
6. Générer **une seule** alerte de test et vérifier l'arrivée dans le groupe ainsi que l'enregistrement dans `notification_deliveries`.

## Sécurité et garanties

- Vérification du secret serveur (comparaison de durée constante), canal désactivé par défaut, domaines et types autorisés.
- Toute la gestion WAHA (QR, Dashboard, groupes, contacts) reste uniquement accessible par tunnel SSH.
- Les identifiants WAHA et les corps d'erreurs fournisseurs ne sont jamais exposés dans la réponse client.
- Une acceptation HTTP n'est pas une lecture WhatsApp. Les réessais de l'outbox peuvent, en cas de crash entre l'envoi et l'accusé de réception, produire exceptionnellement un doublon ; ce n'est pas une livraison strictement exactly-once.
- WAHA utilise une connexion WhatsApp non officielle ; compte WhatsApp dédié conseillé pour limiter le risque de restriction.

**Ne pas activer le canal sans confirmation explicite du moment de bascule.**

