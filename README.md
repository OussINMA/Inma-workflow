# INMA Workflow — mise en ligne gratuite, sans rien installer

Tout se fait **dans Microsoft Edge**. Coût : **0 €**, sans abonnement ni carte bancaire.

| Brique | Service gratuit |
|---|---|
| Hébergement de l'outil et base de données | Cloudflare (offre gratuite Workers + D1) |
| Stockage du projet | GitHub (compte gratuit) |
| Connexion de l'équipe, OneDrive, SharePoint, envoi des e-mails | Votre Microsoft 365 existant |

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/VOTRE-COMPTE/inma-workflow)

---

## Étape 1 — Mettre le projet sur GitHub (5 min)
1. Créez un compte gratuit sur **https://github.com/signup**.
2. Créez un dépôt : bouton **New** › nom `inma-workflow` › **Public**, puis **Create repository**.
   *Public* est nécessaire pour le bouton de déploiement. Le dépôt ne contient aucun mot de passe ni aucune donnée réelle, et vous pourrez le supprimer après l'étape 2.
3. Sur la page du dépôt, cliquez **uploading an existing file**.
4. Décompressez `inma-workflow.zip` (clic droit › *Extraire tout*). Ouvrez le dossier `inma-workflow` et sélectionnez **tout son contenu** (Ctrl + A), y compris les fichiers commençant par un point. Glissez-le dans la page GitHub, puis cliquez **Commit changes**.

## Étape 2 — Mettre en ligne sur Cloudflare (5 min)
1. Ouvrez ce lien en remplaçant `VOTRE-COMPTE` par votre nom GitHub :
   `https://deploy.workers.cloudflare.com/?url=https://github.com/VOTRE-COMPTE/inma-workflow`
2. Créez votre compte Cloudflare gratuit (e-mail et mot de passe, sans carte bancaire) et autorisez Cloudflare à accéder à GitHub.
3. Cloudflare crée une copie privée du projet et la base de données. Il vous demande ensuite :
   - **ADMIN_EMAILS** : votre e-mail INMA ;
   - **ADMIN_PASSWORD** : un mot de passe solide que vous choisissez ;
   - **AZURE_CLIENT_SECRET** : tapez `aucun` pour l'instant ;
   - laissez vides les champs Microsoft (AZURE_TENANT_ID, AZURE_CLIENT_ID, MAIL_FROM).
4. Cliquez **Deploy**. Après une à deux minutes, l'adresse de l'outil s'affiche, du type `https://inma-workflow.<votre-compte>.workers.dev`.
5. Ouvrez-la dans Edge › **Connexion administrateur (mot de passe)**. Vous êtes administrateur.

L'outil est déjà utilisable. Sans la configuration Microsoft, « Inviter » affiche le message et le code à transmettre vous-même par Outlook ou Teams.

## Étape 3 — Brancher Microsoft 365 (avec l'administrateur Microsoft 365 d'INMA, 15 min, gratuit)
1. **https://entra.microsoft.com** › *Applications* › *Inscriptions d'applications* › **Nouvelle inscription** :
   - nom : `INMA Workflow` ;
   - comptes : **Cet annuaire organisationnel uniquement** ;
   - URI de redirection : **Application monopage (SPA)** = l'adresse de l'outil suivie de `/`.
2. Notez l'**ID d'application (client)** et l'**ID de l'annuaire (locataire)**.
3. *Autorisations d'API* › Microsoft Graph :
   - **Déléguées** : `User.Read`, `Files.ReadWrite.All`, `Sites.ReadWrite.All` ;
   - **Application** : `Mail.Send`.
   Puis **Accorder un consentement d'administrateur**.
4. *Certificats et secrets* › **Nouveau secret client** : copiez la valeur.
5. Choisissez la boîte d'envoi des invitations, par exemple une boîte partagée `workflow@votre-domaine` (sans licence).
6. Dans Cloudflare : *Workers et Pages* › `inma-workflow` › *Paramètres* › **Variables et secrets** :
   - renseignez `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` et `MAIL_FROM` ;
   - remplacez le secret `AZURE_CLIENT_SECRET` par le secret client ;
   - cliquez **Déployer**.

L'équipe peut maintenant se connecter avec **Se connecter avec Microsoft** dans Edge. Le bouton « Parcourir » OneDrive / SharePoint apparaît, et les invitations partent toutes seules par e-mail.

---

## Utilisation
- **Inviter l'équipe** : *Paramètres › Membres et équipes* › e-mail de chacun › **Inviter**. Chacun reçoit un code d'activation et un lien « Ouvrir dans Microsoft Edge ».
- **Inviter un externe** : *Équipe › Personnes externes* › *Ajouter un externe* › cochez ses dossiers › *Invitation* › **Envoyer**. L'option de partage OneDrive lui ouvre aussi les fichiers.
- **Lier OneDrive / SharePoint** : bouton *Parcourir* sur chaque champ de lien ; *Créer dans OneDrive* dans l'onglet Fonds et dans chaque dossier.
- **Installer comme application** : dans Edge, menu **⋯ › Applications › Installer ce site en tant qu'application**.
- **Reprendre les données de la version Claude** : export JSON dans la version Claude (*Paramètres › Données*), puis *Importer une sauvegarde JSON* ici.
- **Modifier un réglage** : Cloudflare › `inma-workflow` › *Paramètres › Variables et secrets*.

## Limites de l'offre gratuite
Cloudflare offre gratuitement :
- 100 000 requêtes par jour ;
- 5 millions de lignes lues et 100 000 lignes écrites par jour ;
- 5 Go de stockage.

L'outil reste très en dessous pour une équipe comme INMA. Si une limite était atteinte, l'outil s'arrêterait jusqu'à minuit (heure UTC), sans perte de données et sans facturation. Cloudflare garde aussi 7 jours d'historique restaurable de la base.

## Sécurité
- **Droits** : appliqués par le serveur. Chacun ne reçoit que ses dossiers, et les montants sont masqués sans la permission correspondante.
- **Codes** :
  - invitation : 8 caractères, valable 14 jours, utilisable une fois ;
  - connexion par e-mail : 6 chiffres, valable 10 minutes.
- **Mot de passe administrateur** : réservé aux adresses de `ADMIN_EMAILS`, bloqué 15 minutes après 8 erreurs.
- **Documents** : ils restent dans OneDrive / SharePoint, l'outil ne garde que les liens.
