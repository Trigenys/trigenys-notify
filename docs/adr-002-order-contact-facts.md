# ADR-002 — Coordonnées client dans l'alerte « Nouvelle commande »

Statut : accepté — 2026-11-09

## Contexte

Les poussées de groupe excluaient toute donnée client. Pour une commande web, l'alerte se réduisait à
« Livraison : delivery » : l'équipe devait ouvrir l'espace pro pour savoir qui appeler et quoi préparer.
Le responsable Xeption demande le client, son téléphone, son e-mail, les articles, les quantités, les
prix, le paiement et la livraison directement dans WhatsApp.

## Décision

Dérogation explicite au principe « pas de PII client dans les groupes », limitée à `order.created` :

- champs `customerName`, `customerPhone`, `customerEmail`, `paymentMethod`, `deliveryAddress`, `items`
  (≤ 10 lignes : `name`, `quantity` 1..999, `unitPriceXaf` optionnel) ;
- `parseStaffFacts(facts, type)` ne les lit que pour `order.created` ; pour tout autre type ils sont ignorés ;
- validateurs dédiés (téléphone chiffres/espaces/+, e-mail borné) ; les autres textes gardent le filtre
  anti-contact et anti-formatage ; corps total toujours ≤ 4096 octets ;
- Notify ne persiste pas les faits : seul un hash de l'événement est stocké (anti-rejeu).

## Conséquences

- Les destinataires sont les seuls groupes staff approuvés du registre ; la donnée reste interne.
- Le producteur doit envoyer le même instantané à chaque réessai (hash immuable, sinon `409 EVENT_ID_REUSED`).
- Les autres événements (troc, marketplace, paiement…) restent sans donnée client.
