# HellCorp Motion Studio V1

Application locale gratuite pour transformer un VRM humanoide et deux videos de reference en sprites 2D coherents.

## Entrees

- un fichier `.vrm` VRM 0.x ou VRM 1.0 avec squelette humanoide ;
- un dossier `body/` contenant des videos de mouvements corporels ;
- un dossier `face/` contenant des videos d'expressions faciales.

Le mode batch associe automatiquement `body/walk.mp4` avec `face/walk.mp4`. Si aucune video du meme nom n'existe, `face/default.*`, `face/neutral.*` ou `face/neutre.*` est utilisee. Sans cela, le visage reste neutre.

## Sorties

Pour chaque clip :

```
<character>/<clip>/
  body_motion.json
  face_motion.json
  clip.json
  front/
    frames/frame_000000.png ...
    atlases/atlas_000.png ...
    atlas_manifest.json
  threequarter/
  side/
  back/
```

Chaque atlas est une grille 8x8 afin de ne pas creer de texture unique gigantesque. Le manifest contient FPS, ordre des frames et coordonnees des cellules.

## Lancement

Windows : double-cliquer `start.bat`.

Linux/macOS : `./start.sh`.

Le lanceur utilise uniquement Python 3 pour ouvrir un serveur `localhost`. Le traitement 3D/ML se fait dans Chrome/Edge/Chromium.

La premiere utilisation necessite Internet : les bibliotheques et modeles gratuits sont charges depuis jsDelivr et Google MediaPipe. Les videos choisies sont traitees localement dans le navigateur.

## Workflow

1. Charger le VRM.
2. Selectionner le dossier body.
3. Selectionner le dossier face.
4. Choisir un couple body/face ou laisser l'association automatique.
5. Garder FPS a `0` pour detection automatique, ou renseigner le FPS exact de la video.
6. Cliquer `Analyser le clip selectionne`.
7. Cliquer `Rendre les sprites` et choisir un dossier de sortie.
8. Pour toute la bibliotheque de mouvements, utiliser `Batch : toutes les videos body`.

## Notes techniques importantes

- Le FPS d'export peut suivre le body, le maximum body/face ou une valeur personnalisee.
- `Animation in-place` est active par defaut : Godot deplace le personnage, les sprites ne glissent pas dans leur propre frame.
- Le rendu utilise les materiaux VRM/MToon d'origine avec camera orthographique et transparence.
- La video face pilote tete, yeux, clignement, visemes et expressions standard disponibles dans le VRM.
- Un VRM qui expose des expressions custom de type ARKit/MediaPipe les recoit directement lorsque les noms correspondent.
- Les doigts sont animes via un second pass MediaPipe Hand Landmarker (jusqu'a 2 mains), rigge avec Kalidokit `Hand.solve`, en plus du Pose Landmarker pour le corps. La detection des mains peut rater sur des mouvements rapides/flous ou des mains hors-cadre ; dans ce cas les doigts gardent leur derniere pose connue (comme le reste du corps).
- `n'importe quel VRM` signifie tout VRM humanoide standard. Un modele sans bones humanoides obligatoires ou sans expressions faciales ne peut pas inventer ces controles.

## Dependances runtime

- Three.js 0.180.0
- @pixiv/three-vrm 3.5.5
- @mediapipe/tasks-vision 1.0.1
- Kalidokit 1.1.5
- Google Pose Landmarker Full
- Google Face Landmarker
- Google Hand Landmarker

Aucun de ces composants n'est payant. Voir `THIRD_PARTY.md`.
