# Récap — pipeline de génération d'animations de personnage (Lucy)

Dernière mise à jour : 2026-08-25

## Objectif

Produire des sprites de marche animés et stylisés pour les personnages du jeu (Lucy en premier),
à partir de VRM + capture de mouvement (mocap vidéo), en gardant un rendu propre, cohérent d'une
frame à l'autre, et réutilisable pour les autres personnages (Morrigan, Malphas, Raven...) sans
tout reconstruire à chaque fois.

## Étape 1 — Capture de mouvement (Motion Studio)

Outil : `HellCorp_Motion_Studio/` (Three.js + VRM + MediaPipe pose/face tracking + Kalidokit),
piloté en headless via `tools/render_cli.mjs`.

Pipeline : VRM (`fem_vroid.vrm`) + vidéo source → tracking pose/visage → retargeting IK →
rendu 3D image par image → export en atlas de sprites.

**Deux vrais bugs trouvés et corrigés dans `app.js`** :
- Le filtre de lissage temporel (One Euro Filter, `smoothFrameSeries`) existait dans le code
  mais n'était jamais appelé.
- L'échantillonnage des frames (`nearestFrame`) faisait du plus-proche-voisin pur, aucune
  interpolation entre les poses trackées.

Corrigés → **~6x moins de jitter** mesuré sur les courbes de rotation, mouvement nettement plus
fluide. Vidéo source retenue : `perfect.mp4` (recadrée à 1,72s / 43 frames pour garder le corps
entier dans le cadre).

**État** : fonctionnel, corrections en place dans `HellCorp_Motion_Studio/app.js`. C'est la
base de toutes les stylisations qui suivent.

## Étape 2 — Stylisation SDXL + LoRA (le résultat validé)

Pipeline : chaque frame mocap (rendu 3D propre) composée sur le fond du jeu (`#2b2320`), passée
en img2img SDXL (`waiIllustriousSDXL_v170.safetensors`) avec le LoRA `Pixel_Art_Pony.safetensors`
(filtré UNet-only pour contourner un bug de diffusers sur ce format de LoRA).

Après un balayage de force (0.1 → 1.0) : **force 0.2 validée** comme le résultat recherché
("exactement ce que je veux"). Réglages : `strength=0.55`, `guidance_scale=6.0`, 22 pas, seed fixe.

**Problème identifié** : chaque frame est générée indépendamment par SDXL → variance
inter-frame. Sur ~4-5 frames sur 43, un petit artefact (mèche de cheveux mal interprétée, tache
verte) apparaît et disparaît d'une frame à l'autre — visible en lecture GIF comme un clignotement.

## Étape 3 — Tentative ControlNet + IP-Adapter (abandonnée)

Objectif : permettre de changer de personnage juste en changeant l'image de référence
(IP-Adapter) sans reconstruire tout le VRM, avec ControlNet pour verrouiller la pose.

Travail réel effectué : correction du bug VAE fp16 (`madebyollin/sdxl-vae-fp16-fix`), réglage
CFG/résolution/poids de conditionnement, correction de la troncature de prompt à 77 tokens
(CLIP), tests sur les 3 personnages (Lucy, Morrigan, Malphas) avec la même pose.

**Verdict honnête, confirmé par les tests** : même optimisé à fond, le résultat reste très
bruité / peu abouti comparé à la stylisation legère (étape 2). Génération complète = trop
d'hallucination SDXL pour ce niveau de qualité attendu. **Direction abandonnée** au profit du
retour à la stylisation img2img faible force sur rendu déterministe.

Piste alternative proposée mais non implémentée : recolorisation des matériaux du VRM
(cheveux/vêtements) pour réutiliser le même modèle 3D entre personnages, sans passer par une
régénération IA de l'image.

## Étape 4 — Résolution du problème de variance inter-frame (EbSynth)

Liste de 7 options évaluées (masquage ciblé, chaînage temporel, EbSynth/propagation par patch,
retouche manuelle, lissage temporel post-traitement, AnimateDiff, diffusion vidéo complète) —
**EbSynth retenu et mis en place**.

Implémentation : compilation de l'implémentation open-source de référence
(`jamriska/ebsynth`, build CPU natif macOS ARM64 — le seul package "ebsynth" sur PyPI est un
leurre vide, écarté). Au lieu de générer 43 frames indépendamment, seules **7 keyframes propres**
sont générées et vérifiées une par une (frames 0, 8, 12, 18, 24, 30, 36, 42 — une frame initiale
avec artefact a été remplacée). Les 36 frames restantes sont produites par synthèse de texture
par patch-matching, guidée par le rendu 3D brut (propre et déterministe) de la source et de la
cible — donc aucune nouvelle hallucination.

**Résultat** : l'artefact récurrent a disparu (la frame qui en était affectée en génération
indépendante est maintenant propre, dérivée d'une keyframe saine). Cohérence de style/couleur
nettement supérieure sur toute la séquence. Limite résiduelle mineure : un léger smudge sombre
sur une frame (mismatch local de patch), sans commune mesure avec le clignotement précédent.

Coût : ~18 min CPU pour propager 36 frames (vs. générer 43 frames en SDXL) — plus lent en temps
d'exécution mais un seul chargement de pipeline SDXL et seulement 7 générations IA au lieu de 43.

## État actuel de la pipeline

**Ce qui marche et est validé** :
1. Motion Studio corrigé (lissage + interpolation) → mouvement mocap fluide.
2. Stylisation SDXL img2img + LoRA force 0.2 → le style visuel retenu.
3. EbSynth (7 keyframes + propagation par patch) → résout la variance inter-frame.

**Ce qui n'est pas fait / pas résolu** :
- Le pipeline complet (mocap lissé → 7 keyframes SDXL → propagation EbSynth) n'a pas encore été
  exécuté en une seule passe de bout en bout — le GIF final (`lucy_walk_perfect_ebsynth.gif`)
  a été produit à partir des keyframes de la version force-0.2 déjà générées à l'étape 2, pas
  d'une nouvelle passe combinant tout.
- Réutilisation multi-personnage : toujours non résolue proprement. ControlNet+IP-Adapter
  écarté ; la piste "recolorisation VRM" reste à explorer.
- Rien de tout ça n'est branché dans le jeu — seule l'ancienne version (catwalk.mp4, sans LoRA
  ni EbSynth) est actuellement le sprite du joueur en jeu
  (`web_game/public/assets/characters/lucy/world/walk_front_atlas.png`).

**Scripts et outils réutilisables** (dans `sdxl_lora_bench/`) :
- `full_sequence_smoothed.py`, `full_sequence_perfect.py`, `full_sequence.py` — génération SDXL+LoRA par lot.
- `ebsynth_src/bin/ebsynth` — binaire compilé, prêt à l'emploi.
- `ebsynth_work/run_propagate.sh` — script de propagation (7 keyframes → séquence complète).
- `character/` — références haute qualité Lucy/Morrigan/Malphas fournies par l'utilisateur.
- `pixel_art_pony_unet_only.safetensors` — LoRA filtré, prêt à charger sans bug diffusers.

## Fichiers dans ce dossier

16 GIFs au total :
- `00_baseline_raw.gif` → `10_keyframe_reduced_8pose.gif` — les 11 planches de style testées au
  tout début (avant le choix du LoRA pixel-art).
- `lucy_walk_pixelart_lora0.7.gif` — premier test LoRA complet (vidéo `catwalk.mp4`, force 0.7).
- `lucy_walk_perfect_pixelart_lora0.2.gif` — version validée (vidéo `perfect.mp4`, force 0.2).
- `lucy_walk_perfect_smoothed_raw.gif` — mouvement lissé/interpolé, sans stylisation IA.
- `lucy_walk_perfect_smoothed_lora0.2.gif` — mouvement lissé + LoRA force 0.2.
- `lucy_walk_perfect_ebsynth.gif` — version la plus aboutie à ce jour : keyframes propres + propagation EbSynth, cohérence inter-frame maximale.

## Prochaines étapes possibles (non lancées, en attente de décision)

1. Refaire une passe complète mocap-lissé → SDXL 0.2 (7 keyframes) → EbSynth, en une seule
   chaîne (actuellement le GIF EbSynth réutilise des keyframes de l'ancienne passe).
2. Trancher sur la stratégie multi-personnage (recolorisation VRM vs. autre chose).
3. Brancher le résultat retenu dans le jeu comme sprite (actuellement le jeu utilise toujours
   l'ancienne version catwalk sans LoRA/EbSynth).
