# Accès VPS limité à Caddy

Mis en service le 22 octobre 2026 : connexion SSH et clé hôte vérifiées, correctif Caddy appliqué, puis découverte automatique des deux groupes confirmée dans D1. La clé privée doit être copiée intégralement dans le secret GitHub, avec ses lignes BEGIN/END ; le workflow normalise les retours à la ligne Windows et refuse les valeurs incomplètes avant toute connexion.

Le workflow `WAHA VPS operations` utilise un compte `notify-ops` dédié. Sa clé force un wrapper qui n'accepte que `inspect` et `enable-discovery`. Il ne fournit ni shell interactif, ni forwarding, ni accès Docker ou aux secrets WAHA. Les deux commandes sudo autorisées sont explicites ; le script et les clés autorisées appartiennent à root.

## Installation ponctuelle

1. Télécharger `scripts/vps/notify_ops.py` depuis GitHub et le copier sur le VPS.
2. Depuis le compte habituel `ubuntu`, exécuter `sudo python3 ~/notify_ops.py install`. Le script crée une clé dédiée dans `~/.ssh/trigenys_notify_actions` et écrit la clé publique du serveur dans `~/.ssh/trigenys_notify_known_hosts`. La clé privée n'est jamais affichée par l'installateur.
3. Dans les secrets **Actions** du dépôt, créer `VPS_SSH_PRIVATE_KEY` avec le contenu du premier fichier, puis `VPS_SSH_KNOWN_HOSTS` avec le contenu du second. Ne jamais envoyer la clé privée dans une conversation ou la committer.
4. Relancer le premier job `WAHA VPS operations` après configuration des secrets. Le lancement initial par push applique `enable-discovery` ; les déclenchements manuels proposent `inspect` par défaut.

Le VPS actuel est `15.235.90.215`, port 22. Si son adresse change, renseigner la variable Actions `NOTIFY_VPS_HOST` et régénérer le fichier de confiance sur le serveur avec `install --host NOUVELLE_IP`. La connexion exige la clé hôte exacte ; aucun `ssh-keyscan` réseau n'est utilisé comme source de confiance.

## Effet du correctif

Seul le bloc pour `notify.trigenys.com` est étendu avec les deux routes GET de découverte de la session `trigenys-test`. L'envoi POST existant et les autres sites sont conservés. Une disposition Caddy inconnue est refusée. Le fichier candidat est validé avant remplacement, une sauvegarde root est conservée dans `/var/backups/trigenys-notify`, et un échec de rechargement restaure le fichier précédent. Les journaux n'affichent ni la configuration complète ni les sorties Caddy pouvant contenir des secrets.

Le job n'exécute rien tant que les deux secrets ne sont pas configurés. Il utilise seulement le client OpenSSH du runner, sans action tierce ni permission GitHub API.

## Révoquer l'accès

Supprimer les deux secrets Actions puis exécuter sur le VPS :

```sh
sudo rm -f /home/notify-ops/.ssh/authorized_keys /etc/sudoers.d/trigenys-notify-ops
rm -f ~/.ssh/trigenys_notify_actions ~/.ssh/trigenys_notify_actions.pub ~/.ssh/trigenys_notify_known_hosts
```

La suppression de la clé autorisée et des droits sudo n'altère pas le correctif Caddy déjà appliqué. Aucun message WhatsApp n'est envoyé par ces opérations.

Références : https://man.openbsd.org/sshd.8 ; https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
