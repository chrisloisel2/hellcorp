# Dossiers personnages — ce qui va où

Un dossier par personnage majeur (`morrigan/`, `lucy/`, `malphas/`, `raven/`), même
convention de nommage que les pipelines de génération déjà en place dans le repo, pour
pouvoir copier leurs sorties ici sans rien renommer :

- `hellcorp_sprite_pipeline.sh` (FLUX, image fixe) → `master.png`, `portrait.png`,
  `expressions/*.png`, `world/*.png` (poses statiques), `splash.png`.
- `HellCorp_Motion_Studio` (VRM + mocap, vraies boucles d'animation frame par frame) →
  remplace à terme les fichiers `world/walk_*` par de vraies séquences si le rendu
  procédural (bob/tilt actuel) ne suffit plus.

**Important** : créer ces fichiers ne les branche pas automatiquement au jeu. Aujourd'hui
`game.js`/`editor.js` ne consomment que `avatar_file` (une seule image par personnage,
définie dans la table `characters` / `map_npcs`). Tout ce qui est décrit ici est une zone
de stockage pour préparer la suite (portraits selon sentiment, sprite multi-directions) —
il faudra une passe de code séparée pour que le jeu les affiche réellement. Dites-le moi
quand vous voulez que je fasse cette passe.

## Arborescence attendue, par personnage

```
characters/<key>/
  master.png                  référence canonique verrouillée (jamais affichée en jeu)
  portrait.png                portrait dialogue neutre, plan buste
  expressions/
    neutral.png
    confident.png
    amused.png
    annoyed.png
    worried.png
    cold_glare.png
  world/
    idle_front.png
    idle_back.png
    idle_left.png
    idle_right.png
    walk_left_a.png / walk_left_b.png / walk_left_c.png
    walk_right_a.png / walk_right_b.png / walk_right_c.png   (optionnel — set "full")
    walk_front_a.png / walk_front_b.png / walk_front_c.png   (optionnel — set "full")
    walk_back_a.png / walk_back_b.png / walk_back_c.png      (optionnel — set "full")
    talk.png
    present.png
    sit.png
    use_pc.png
  splash.png                  art recrutement / marketing / écran personnage
```

Le set "quick" (idle × 4 directions + walk_left × 3 + talk/present/sit, 9 fichiers) suffit
pour retester rapidement en jeu. Le set "full" ajoute les 3 autres directions de marche et
`use_pc` (18 fichiers), à faire une fois le personnage validé.

## Formats et tailles cibles

| Fichier | Taille cible | Notes |
|---|---|---|
| `master.png` | 896×1344 (jusqu'à 1536×2048 en qualité max) | identité verrouillée, ne change plus une fois validée |
| `portrait.png` + `expressions/*.png` | 768×1152 (jusqu'à 1024×1536) | même cadrage exact pour les 7 fichiers (portrait + 6 expressions), sinon les changements d'humeur sautent visuellement |
| `world/*.png` | hauteur visible 192–256px, canvas 256×256, fond transparent | aujourd'hui le jeu affiche les personnages à 130px (`NPC_DRAW_HEIGHT` dans `game.js`, `player.drawHeight`) — soit on relève cette constante au moment du branchement, soit on downscale ces sprites à l'export |
| `splash.png` | 1536×2048 ou 2× upscale du master | non utilisé en jeu pour l'instant, réservé à un futur écran personnage / recrutement |

Toutes les images : PNG RGBA, fond transparent pour `world/*` et `splash.png` ; fond libre
pour `master.png`/`portrait.png`/`expressions/*.png` (ils ne sont jamais découpés sur fond
transparent dans le pipeline actuel).

## Les 6 expressions et le lien avec le système de sentiments

Le jeu a déjà un système de stats de relation (`affinity`, `trust`, `respect`, `attraction`,
`fear`, `rivalry`, voir `server/relationships.js`), mais aujourd'hui il ne produit que du
texte (`sentimentPhrases()`), jamais un changement d'image. Les 6 expressions générées par
le pipeline correspondent à une lecture possible de ces stats — à confirmer/ajuster avec moi
quand on câble ça côté code :

| Expression | Quand l'utiliser |
|---|---|
| `neutral` | état par défaut, aucune stat marquante |
| `confident` | `respect` élevé (≥60) |
| `amused` | `attraction` élevée (≥60) ou `affinity` élevée (≥70) |
| `worried` | `fear` élevée (≥50) |
| `annoyed` | `respect` faible (≤20) |
| `cold_glare` | `trust` faible (≤20) ou `rivalry` élevée (≥50) |

## Personnages

- `morrigan/`, `lucy/`, `malphas/` : déjà configurés dans `hellcorp_ai/config/characters.json`,
  utilisables directement avec `./hellcorp_sprite_pipeline.sh all <nom> quick`.
- `raven/` : existe dans le jeu (table `characters`, `hellcorp_generations/raven/`) mais
  **n'est pas encore déclarée** dans `hellcorp_ai/config/characters.json` — il faut lui
  ajouter une entrée (description, seed, palette) avant de pouvoir lancer le pipeline dessus.
- Morrigan a une variante "Night Shift" (forme démoniaque) déjà définie sous la clé
  `morrigan_night` dans `characters.json` — pas de dossier dédié créé ici pour l'instant ;
  dites-moi si vous voulez la traiter comme un personnage à part entière ou comme une variante
  de `morrigan/`.
