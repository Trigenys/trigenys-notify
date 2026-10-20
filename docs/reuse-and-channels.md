# Trigenys Notify — réutilisation multi-produits et canaux

**État (20 octobre 2026) :** le contrat V1, la conversion Xeption et les adaptateurs Telegram/WAHA sont codés et testés. Ce ne sont pas des services d'envoi actifs. L'association ERP ↔ Telegram est traitée séparément; ne pas modifier son workflow ici.

## Principes

Trigenys Notify fournit un socle de notifications **réutilisable**, mais chaque application reste responsable de ses événements, de ses autorisations et de sa file persistante. Pour Xeption, la source de vérité actuelle est la combinaison admin_notifications + notification_deliveries + Edge Function notify-staff. **Ne pas mettre en marche un autre moteur d'envoi pour les mêmes événements/canaux.**

Le découplage permet à Atelier Maître, Commerce Factory, SEO Monitor et de futurs produits de consommer le contrat sans modifier Xeption.

## Contrat canonique V1

Exemple de structure interne, sans nom, numéro ou message libre issu d'un client :

    {
      "version": 1,
      "project": "xeption",
      "id": "4e3435a9-5f0f-4b78-8c8c-0353535a0f80",
      "type": "inventory.stock_low",
      "occurredAt": "2026-10-20T12:00:00Z",
      "priority": "high",
      "resource": {"kind":"inventory","id":"product-123"},
      "audience": "staff",
      "actionUrl": "https://www.xeptionetwork.shop/admin/inventory"
    }

Code réutilisable :

- src/core/contracts.ts : validation du schéma; alias métiers; conversion de notifications Xeption.
- src/core/channels.ts : transport WAHA ou Telegram, réponse typée (accepté / réessayer / rejet permanent), sans scheduling et sans envoi automatique.
- test/core : tests de sécurité, d'absence de données personnelles et des erreurs provider.

**Correspondances des événements Xeption :**

| Événement d'origine | Type Trigenys Notify |
|---|---|
| stock_low | inventory.stock_low |
| stock_out | inventory.stock_out |
| product_missing_image | catalog.product_missing_image |
| troc_submitted | barter.requested |
| marketplace_listed | marketplace.listing_created |

Un événement inconnu retourne null au niveau du convertisseur Xeption; si un autre produit l'envoie par contrat générique, le format de notification sera neutre. Ne jamais relayer directement les champs libres d'un dossier de troc dans un groupe.

## Garanties de livraison

Le composant source doit stocker **atomiquement** les événements et réclamer les livraisons par canal. La clé d'unicité logique correspond à (project, eventId, channel). Les adaptateurs du package ne stockent pas d'état et **ne font aucune relance eux-mêmes**.

- Un succès HTTP est une **acceptation par le fournisseur**, pas une lecture par l'employé.
- Code 429 / 5xx / erreur réseau : échec temporaire; planifier une nouvelle tentative dans l'outbox.
- Code 4xx (sauf 429) : erreur permanente à investiguer (mauvais chat, clé, restrictions).
- Historiser chaque réponse de canal séparément; ne pas renvoyer Telegram parce que WAHA a échoué.
- Avoir un interrupteur par application et par canal, par défaut désactivé pour une nouvelle intégration.

## Connecteur WAHA pour WhatsApp

L'API documentée est POST /api/sendText avec session, chatId, text et X-Api-Key. Un groupe est identifié par un ID finissant par @g.us, pas un téléphone individuel.

L'adaptateur WahaAdapter accepte seulement une origine HTTPS, un nom de session, une clé API côté serveur et un identifiant de groupe. Il masque les corps d'erreur dans ses retours. Il n'existe **pas** de configuration WAHA active ni de session QR couplée au dépôt aujourd'hui.

Exemple d'usage dans un service isolé, après claim transactionnel de l'outbox :

    import {WahaAdapter} from "./src/core/channels.js";
    import {staffMessage} from "./src/core/contracts.js";

    const channel = new WahaAdapter({
      baseUrl: process.env.WAHA_BASE_URL,
      apiKey: process.env.WAHA_API_KEY,
      session: process.env.WAHA_SESSION,
      groupChatId: process.env.WAHA_STAFF_GROUP_ID
    });
    const delivery = await channel.send(staffMessage(event));
    // Persist delivery.accepted / retryable in the SOURCE outbox.

Les secrets WAHA ne doivent jamais être configurés comme variables front-end. Protéger WAHA par API key, TLS, réseau privé si possible, et sauvegarde de sa session. Éviter les envois massifs : les automatisations basées sur WhatsApp Web peuvent entraîner des restrictions du compte; pour un service client à grande échelle, envisager l'API WhatsApp Business officielle.

Documentation API WAHA : https://waha.devlike.pro/docs/overview/quick-start/

## Étapes d'intégration sans risque pour Xeption

1. Ne toucher ni au login/linking ERP ↔ Telegram ni aux migrations préparées par le développeur qui gère cette partie.
2. Dans le code métier, traduire les événements enregistrés en contrat V1; pas d'envoi supplémentaire.
3. Tester en mock le rendu des alertes et le masquage des données clients.
4. Pour WhatsApp, installer WAHA sur un hébergement dédié, associer une session, vérifier l'ID du groupe et les secrets.
5. Ajouter une livraison dans l'outbox de Xeption **uniquement pour le nouveau canal WhatsApp**; ne pas dupliquer la livraison Telegram existante.
6. Garder l'activation du canal derrière un drapeau explicite, tester un événement contrôlé, puis seulement autoriser l'usage réel.

## Cas d'usage multi-produit

Le projet porteur ne doit jamais copier un token partagé, les données clients ou les règles métier dans le package de notification. Il fournit : type d'événement versionné, destination du groupe, adaptateur de transport, URL d'action sur son domaine; il conserve lui-même l'authentification, le rôle staff, la rétention et les traces d'audit.

La Mini App Xeption est un premier client spécifique. Ne pas présumer qu'une action « modifier stock » ou « refuser troc » existe dans Commerce Factory ou Atelier Maître; chaque produit configure ses actions indépendamment.
