# Meta Cloud API officielle — Atelier Maître via Trigenys Notify

**État : code prêt pour revue, canal désactivé par défaut. Pas de bascule d'Atelier Maître.**

## Pourquoi

Atelier Maître utilisait directement Meta Cloud API. Trigenys Notify centralise
progressivement les **adaptateurs fournisseur**, pas les événements métier.

- Atelier Maître conserve le consentement, les préférences par garage, la
  limitation des coûts, les huit modèles Utility, les files PostgreSQL/BullMQ,
  les identifiants Meta et l'historique client.
- Notify détient à terme le token API Meta et le `phone_number_id`, construit
  uniquement des modèles autorisés et renvoie l'identifiant Meta au produit.
- Le webhook **signé** `/api/webhooks/whatsapp` reste dans Atelier Maître,
  puisque les reçus `sent/delivered/read/failed` et les messages STOP y sont
  corrélés au consentement et à l'historique. Il est **interdit** d'enregistrer
  un deuxième webhook concurrent avant le plan de migration.
- Xeption et ses canaux WAHA/Telegram sont inchangés. Aucun expéditeur parallèle.

## Contrat interne (non public)

`POST /v1/dispatch/atelier/whatsapp`

`x-notify-auth` : clé distincte, aléatoire (32 caractères minimum) partagée
uniquement entre les serveurs Atelier et Notify. Pas de CORS client.

Exemple schématique **sans donnée réelle** :

```json
{
  "eventId": "cn_example_123",
  "eventType": "VEHICLE_READY",
  "to": "+2376XXXXXXXX",
  "templateName": "am_vehicle_ready_v1",
  "language": "fr",
  "variables": ["Nom destinataire", "Immatriculation", "Garage"]
}
```

Le champ `to` doit être un **vrai E.164** ; la valeur masquée ci-dessus n'est
pas une requête valide. Le produit ne transmet jamais de texte libre.

Pour `QUOTE_APPROVAL_REQUESTED`, ajouter `buttons:[{"index":0,"urlSuffix":"<jeton opaque base64url>"}]`.
La valeur doit être **uniquement** le suffixe validé du lien de devis, jamais
une URL complète.

Les huit événements et noms de modèles de
`src/core/meta-cloud.ts` reprennent le catalogue d'Atelier Maître :
`APPOINTMENT_CONFIRMED`, `APPOINTMENT_REMINDER`,
`SERVICE_ORDER_RECEIVED`, `QUOTE_APPROVAL_REQUESTED`,
`VEHICLE_READY`, `INVOICE_AVAILABLE`,
`INVOICE_PAYMENT_REMINDER`, `PAYMENT_CONFIRMED`.

L'expéditeur ne connaît **ni garage, ni consentement, ni tarifs** et ne peut
donc pas les valider : Atelier vérifie ces garde-fous *avant l'appel*.

Réponse 202 (acceptation Meta, **pas livraison**) :

```json
{
  "accepted": true,
  "status": "QUEUED",
  "provider": "whatsapp-cloud",
  "providerMessageId": "wamid.EXAMPLE",
  "accountRef": "123456789"
}
```

Atelier doit persister `providerMessageId` et `accountRef` pour raccorder
son webhook existant ; ne jamais assimiler HTTP 202 à `DELIVERED`.

Erreurs synthétiques, sans données personnelles ni texte d'erreur Meta :
401 clé incorrecte ; 503 canal désactivé, secrets manquants ou modèle non
autorisé ; 400 événement invalide ; 413 trop volumineux ; 502 fournisseur
refusé ou issue incertaine ; 503 limite/défaillance temporaire.

**Idempotence** : Meta ne propose aucune clé d'idempotence ici. L'outbox
transactionnelle d'Atelier gère les déduplications fonctionnelles ; Notify
ne possède pas de file transactionnelle. Après `UNKNOWN_OUTCOME`, ne pas
réessayer automatiquement : l'envoi a peut-être été accepté malgré l'échec.

## Configuration côté Cloudflare Worker

Secrets **dans Cloudflare**, jamais dans Git, un navigateur ou les variables
publiques de la Mini App :

- `ATELIER_NOTIFY_INGEST_KEY` : nouvelle clé dédiée à Atelier Maître.
- `META_CLOUD_ACCESS_TOKEN` : token permanent Meta, une fois le numéro validé.
- `META_CLOUD_PHONE_NUMBER_ID` : numéro émetteur Meta (ID numérique).
- `META_CLOUD_API_VERSION` : version Graph officiellement supportée.
- `ATELIER_META_APPROVED_TEMPLATES` : liste délimitée par des virgules, chaque
  entrée `nom_du_modele:langue`, ex. `am_vehicle_ready_v1:fr`.
- `ATELIER_META_DISPATCH_ENABLED=false` : **arrêt par défaut**, à conserver
  jusqu'à la recette et à la bascule contrôlée.

Le jeton de vérification et le secret d'application du webhook restent dans
SSM Atelier Maître tant que l'URL Meta pointe sur Atelier.

## Ordre de bascule sans interruption

1. Valider les tests unitaires, la compilation TypeScript et le bundle Worker.
2. Enregistrer la puce MTN choisie dans Meta, récupérer un token permanent,
   approuver les modèles **Utility** et configurer la facturation.
3. Configurer les secrets Notify côté Cloudflare sans activer l'envoi.
4. Ajouter dans Atelier un provider `TrigenysNotifyWhatsAppProvider` implémentant
   l'interface **existante** `WhatsAppProvider`, sans changer l'émetteur
   client ni le webhook Meta ; il convertira la requête de modèle en contrat
   Notify (l'événement métier étant connu de la source).
5. En staging, utiliser un seul numéro de test autorisé, avec consentement.
   Vérifier HTTP 202 et l'ID Meta, puis le webhook signé, les statuts de remise,
   STOP et le plafond de dépense. Tester les erreurs et les tentatives répétées.
6. **Seulement après** recette, activer le canal sur Notify et remplacer le
   sender direct d'Atelier par le sender Notify pour le même numéro.
   Garder un seul chemin actif à tout instant et un rollback clair.
7. Supprimer de SSM le token d'envoi Meta d'Atelier **après** validation de la
   bascule ; conserver les secrets webhook tant que Meta y livre les événements.

## Portée de ce changement

Cet ajout **ne configure ni la carte bancaire ni la SIM**, ne modifie pas les
paramètres Meta, ne déploie pas Notify et ne redirige pas le trafic d'Atelier.
Il prépare uniquement la couche officielle Meta Cloud API réutilisable.
