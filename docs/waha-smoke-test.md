# Test WhatsApp WAHA — Trigenys Notify

**Actuellement :** transport WAHA codé et testé. Aucune instance ni session WAHA n'a été établie dans ce dépôt. Les procédures ci-dessous envoient seulement un message d'essai à un groupe de test lorsque l'opérateur l'autorise explicitement.

## 1. Avoir une instance WAHA prête

WAHA utilise un moteur WhatsApp connecté par QR code et doit fonctionner dans un conteneur Docker avec stockage persistant. Se référer aux instructions officielles : https://waha.devlike.pro/docs/overview/quick-start/

Tester d'abord sur un numéro et un groupe de test dont les membres sont informés, pas directement dans un groupe client. Une instance locale peut suffire pour le diagnostic via Dashboard, mais **l'adaptateur Trigenys Notify exige une URL HTTPS**, sans port non standard, paramètres ni chemins. Utiliser un nom de domaine avec reverse proxy HTTPS si l'adaptateur doit joindre WAHA sur un serveur.

Dans le Dashboard WAHA, créer la session (par ex. `trigenys-test`), scanner le QR via WhatsApp → Appareils connectés, puis attendre le statut **WORKING**. Identifier un groupe de test avec son chat ID WAHA finissant par `@g.us`.

## 2. Configurer sans publier les secrets

Définir les variables d'environnement dans un terminal sécurisé ou dans le secret store de l'hôte (ne pas committer de fichier secret) :

- `WAHA_BASE_URL` : origine HTTPS, ex. `https://waha.example.com`
- `WAHA_API_KEY` : clé du serveur WAHA
- `WAHA_SESSION` : session liée, ex. `trigenys-test`
- `WAHA_STAFF_GROUP_ID` : identifiant WAHA du groupe qui consent au test, format `123456@g.us`

Les détails de connexion ne doivent pas être envoyés dans GitHub Issues, dans le groupe public ou en capture d'écran contenant des clés.

## 3. Trois commandes, avec ou sans WhatsApp

Exécuter depuis la racine du dépôt, avec Node.js 24+ :

```sh
npm install
npm run waha:mock
npm run waha:check
npm run waha:send-test
```

- `waha:mock` : **aucune connexion WhatsApp**. Simule une unique livraison et vérifie son format.
- `waha:check` : appelle uniquement GET `/api/sessions/{session}` pour confirmer que la session est `WORKING` ; **aucun message envoyé**.
- `waha:send-test` : envoie **un seul message** fixe intitulé `[TEST] Trigenys Notify` via `POST /api/sendText`, puis rapporte si WAHA l'a accepté. Vérifier l'arrivée dans le groupe manuellement : succès HTTP ne garantit pas la lecture.

Aucune de ces commandes ne modifie Xeption, ni la file `notification_deliveries`, ni le bot Telegram.

## 4. Après le test ponctuel

Pour exploiter WhatsApp comme canal officiel de Xeption, ajouter uniquement un destinataire WAHA au relais existant `notify-staff`, avec son propre statut de livraison, les relances et un interrupteur d'activation par application. Le connecteur du dépôt **n'est pas encore branché à une outbox active**. Activer les alertes automatiquement uniquement après un test WhatsApp positif et une vérification des risques de restriction des comptes WhatsApp.

Ne pas héberger un moteur WhatsApp Web dans un Cloudflare Worker. Ce dernier peut servir de façade HTTPS, mais WAHA a besoin d'un processus et d'une session persistants.

Sources officielles : https://waha.devlike.pro/docs/overview/quick-start/ et https://waha.devlike.pro/docs/how-to/sessions/
