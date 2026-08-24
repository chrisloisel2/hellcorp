# HellCorp — Document de présentation complet

## 1. Résumé du projet

**HellCorp** est un jeu de management narratif et relationnel situé dans une multinationale infernale.

Le joueur dirige une division appelée **Special Contracts** au sein de HellCorp, une entreprise démoniaque structurée comme une multinationale moderne.

Le projet repose sur une idée centrale :

> **Le joueur construit et gère son entreprise sur mobile, puis entre physiquement dans cette même entreprise sur PC.**

La version mobile représente la **Day Shift** : gestion, recrutement, contrats, bâtiments, employés et progression.

La version PC représente la **Night Shift** : exploration du siège, interactions, dialogues, événements personnels, incidents et progression relationnelle.

Les deux expériences partagent le même état de sauvegarde.

---

# 2. Vision

HellCorp ne doit pas ressembler à deux jeux séparés.

Le mobile ne doit pas être un idle game collé à un visual novel PC.

Le PC ne doit pas être un simple bonus narratif.

Les deux couches doivent constamment se nourrir.

```text
MOBILE — DAY SHIFT

Contrats
↓
Argent
↓
Construction
↓
Recrutement
↓
Relations
↓
Événements déclenchés

        ↓ sauvegarde partagée ↓

PC — NIGHT SHIFT

Exploration
↓
Conversations
↓
Événements personnels
↓
Décisions
↓
Memories
↓
Flags narratifs
↓
Bonus / conséquences

        ↓ retour management ↓
```

Le hook du jeu est simple :

> **Je construis mon entreprise sur mobile, puis je peux réellement y entrer et vivre avec mes employés sur PC.**

---

# 3. Ton et univers

HellCorp mélange :

- multinationale premium ;
- bureaucratie infernale ;
- humour noir ;
- fantasy démoniaque ;
- relations adultes ;
- séduction ;
- management ;
- politique interne ;
- rivalités ;
- occultisme ;
- satire corporate.

Le jeu ne doit pas être un enfer médiéval.

HellCorp est un enfer moderne.

On y trouve :

- ascenseurs ;
- open spaces ;
- board rooms ;
- salles de réunion ;
- services juridiques ;
- départements financiers ;
- équipes sécurité ;
- archives interdites ;
- laboratoires occultes ;
- cafétérias ;
- machines à café ;
- RH ;
- audits ;
- contrats littéralement infernaux.

L'esthétique générale doit donner l'impression d'une entreprise extrêmement professionnelle qui traite l'Enfer comme un business normal.

---

# 4. Les Seven Divisions

HellCorp est structurée autour de grandes divisions liées aux sept péchés.

```text
PRIDE
GREED
LUST
ENVY
WRATH
GLUTTONY
SLOTH
```

Le joueur dirige :

```text
SPECIAL CONTRACTS
```

Cette division est plus petite, flexible et atypique.

Elle reçoit des opérations trop politiques, trop étranges ou trop risquées pour les autres divisions.

Chaque grande division possède :

- une direction ;
- une philosophie ;
- une esthétique ;
- des personnages ;
- des contrats ;
- des intérêts ;
- des rivalités ;
- un arc narratif.

Cette structure permet de faire évoluer HellCorp pendant plusieurs saisons ou extensions sans changer son architecture.

---

# 5. Boucle principale

La boucle principale est :

```text
CONTRATS
↓
RESSOURCES
↓
CONSTRUCTION
↓
RECRUTEMENT
↓
ÉQUIPES PLUS PUISSANTES
↓
NOUVEAUX CONTRATS
↓
RELATIONS
↓
NIGHT SHIFT
↓
NOUVEAUX FLAGS ET BONUS
↓
CONTRATS
```

Chaque système doit avoir une conséquence sur au moins un autre système.

---

# 6. Day Shift — Mobile

Le mobile est le gestionnaire de HellCorp.

Il doit être utilisable pendant :

- 2 minutes ;
- 10 minutes ;
- 30 minutes.

Écran d'accueil conceptuel :

```text
HELLCORP
SPECIAL CONTRACTS

Capital              42 680 $
Revenus/h              1 240 $
Réputation                 18
Employés                   12

──────────────────────────

3 contrats terminés
Morrigan veut vous voir
2 candidats disponibles
4 messages

──────────────────────────

[ENTREPRISE]
[CONTRATS]
[EMPLOYÉS]
[RECRUTER]
[MESSAGES]
```

La V1 doit éviter les dizaines de monnaies.

Ressources principales :

- argent ;
- réputation ;
- éventuellement une ressource surnaturelle.

---

# 7. Contrats

Les contrats sont la boucle de management principale.

Exemple :

```text
ACQUISITION HOSTILE

Durée : 2 h

Finance       180
Legal         120
Management     70

Risque : élevé

Modificateurs :
+25 % si l'équipe contient Ruthless
-15 % si deux employés possèdent Rivalry
+10 % si un VP dirige l'opération
```

Le joueur sélectionne plusieurs employés.

La puissance d'une équipe dépend de :

- statistiques ;
- traits ;
- fatigue ;
- motivation ;
- synergies ;
- rivalités ;
- compétences uniques.

La meilleure équipe n'est donc pas toujours celle avec les plus grosses statistiques.

---

# 8. Durées de contrats

Plusieurs catégories permettent de s'adapter à différents rythmes de jeu.

```text
FLASH
1–5 minutes

SHORT
15–30 minutes

STANDARD
1–3 heures

LONG
6–12 heures

EXPEDITION
24 heures
```

Un joueur peut lancer une opération avant de dormir et récupérer les résultats le lendemain.

---

# 9. Employés

Chaque employé possède plusieurs couches de gameplay.

```text
STATS
Finance
Legal
Marketing
Occult
Security
Management

TRAITS
Ambitious
Coward
Workaholic
Idealist
Ruthless
Jealous
etc.

CONDITION
Fatigue
Motivation
Stress

RELATIONS
avec le joueur
avec les autres employés

ABILITIES
passives
actives
spéciales
```

Les personnages majeurs disposent en plus de contenu narratif complet.

---

# 10. Recrutement

Le recrutement est un pilier du jeu.

Plusieurs systèmes doivent coexister.

## Job Board

Système classique.

Avantages :

- faible coût ;
- rotation fréquente ;
- employés secondaires ;
- accès facile.

## Headhunter

Recherche ciblée.

```text
Département : Legal
Rang minimum : A
Trait : Ambitious
Budget : 5 000 $
Durée : 4 heures
```

Plus le budget est élevé, meilleures sont les chances.

## Poaching

Le joueur peut débaucher certains personnages employés par les divisions rivales.

Exemple :

```text
MORRIGAN
VP FINANCE — GREED DIVISION

Salaire proposé : 6 500
Prime : 8 000
Titre : VP Finance
Bureau privé : oui

Probabilité actuelle : 43 %
```

## Story Recruitment

Les personnages majeurs peuvent être obtenus par :

- arcs narratifs ;
- contrats ;
- incidents ;
- rivalités ;
- événements spéciaux.

Les personnages principaux ne doivent pas ressembler à des cartes de gacha sans contexte.

---

# 11. Départements

Le joueur construit physiquement sa division.

Départements envisagés :

```text
Finance
Legal
Marketing
Occult
Security
R&D
Human Resources
Executive
```

Chaque département doit débloquer :

```text
1 famille de contrats
1 mécanique
1 catégorie d'employés
1 zone PC
1 groupe d'événements
```

Exemple :

```text
OCCULT

Mobile
- contrats surnaturels
- reliques
- employés Occult
- incidents paranormaux

PC
- laboratoire Occult
- archives interdites
- salle d'invocation
- événements nocturnes
```

Construire quelque chose sur mobile doit donc changer physiquement le bâtiment PC.

---

# 12. Night Shift — PC

La Night Shift est la partie exploration et relations.

Le joueur se déplace dans le siège HellCorp.

Il peut :

- parler ;
- recevoir des messages ;
- entrer dans des bureaux ;
- participer à des incidents ;
- résoudre des conflits ;
- déclencher des événements ;
- débloquer des Memories ;
- développer des relations.

Une Night Shift peut durer environ 15 à 45 minutes.

Exemple :

```text
18:03
Fin du travail

18:10
Discussion avec Lucy

18:22
Incident dans Occult

18:35
Morrigan propose un verre

19:00
Bar

19:25
Événement relationnel

19:45
Retour HellCorp

20:00
Sauvegarde
```

Le joueur doit sentir que l'entreprise continue de vivre après la journée de travail.

---

# 13. Le téléphone

Le téléphone existe sur mobile et sur PC.

Exemples de messages :

```text
LUCY
Tu es encore au bureau ?

MORRIGAN
Passe dans mon bureau.

MALPHAS
Nous avons un problème aux archives.

RAVEN
Accès de sécurité verrouillé.

HR
Incident #66642
```

Certains événements peuvent disparaître à la fin de la Night Shift.

Cela donne une sensation de monde vivant.

---

# 14. Relations

Les relations ne doivent pas être résumées à une simple jauge de romance.

Variables internes :

```text
Affinity
Trust
Respect
Attraction
Fear
Rivalry
```

Le joueur ne voit pas nécessairement les valeurs numériques.

Il peut voir des phrases :

```text
"She respects you."
"She doesn't trust your motives."
"Something is bothering her."
"She seems unusually comfortable around you."
```

La progression dépend également de flags narratifs.

Exemple :

```text
morrigan_hired = true
morrigan_argument_01 = true
morrigan_supported_board_meeting = true
trust >= 30
respect >= 50
```

Ces conditions peuvent ouvrir un événement.

---

# 15. Casual et Romance

Deux formes de relations peuvent exister.

## Casual

Progression courte.

```text
Recrutement
↓
Flirt
↓
Événement
↓
Relation légère
```

## Romance

Progression plus importante.

```text
Recrutement
↓
Connaissance
↓
Confiance
↓
Arc personnel
↓
Flirt
↓
Rendez-vous
↓
Conflit
↓
Réconciliation
↓
Relation
```

Chaque personnage peut avoir une structure différente.

---

# 16. Memories

Les événements importants deviennent des Memories.

Exemple :

```text
MORRIGAN — MEMORIES

01 First Interview          ✓
02 Hostile Intentions       ✓
03 Late Night               ✓
04 Expensive Taste          ?
05 Boardroom War            🔒
06 Penthouse                🔒
07 The Promotion            🔒
08 ???                      🔒
```

Une Memory peut être :

- recrutement ;
- conflit ;
- scène professionnelle ;
- secret ;
- rendez-vous ;
- événement de groupe ;
- moment relationnel ;
- conclusion d'arc.

---

# 17. Personnages majeurs

La V1 ne doit pas essayer de lancer 100 personnages.

Objectif :

```text
12 personnages majeurs
30–50 employés secondaires
```

Les personnages majeurs possèdent :

- recrutement unique ;
- statistiques ;
- traits ;
- capacités ;
- personnalité ;
- messages ;
- événements professionnels ;
- événements personnels ;
- événements relationnels ;
- Memories ;
- arc narratif ;
- tenues ;
- réactions aux autres personnages.

Les personnages secondaires servent principalement au management.

---

# 18. Personnages du prototype

Les quatre personnages actuellement définis sont :

- Morrigan ;
- Lucy ;
- Malphas ;
- Raven.

Tous sont des personnages fictifs explicitement adultes.

---

# 19. Morrigan — Vice-présidente Finance

## Fonction

Morrigan est l'une des figures centrales de la division Finance.

Elle représente :

- contrôle ;
- ambition ;
- prédation financière ;
- pouvoir ;
- compétition.

## Apparence

Direction visuelle :

- grande ;
- silhouette lourde en sablier ;
- longs cheveux noirs ;
- asymétrie des cheveux sur un œil ;
- tailleur noir ;
- ivoire ;
- or vieilli ;
- silhouette verticale.

Elle doit être immédiatement reconnaissable sans dépendre de micro-détails.

## Gameplay

Statistiques fortes :

- Finance ;
- Legal ;
- Management.

Trait possible :

```text
RUTHLESS NEGOTIATOR

+20 % revenus sur contrats Finance
-10 % relation avec employés Idealist
```

## Personnalité

Morrigan est :

- ambitieuse ;
- sarcastique ;
- calculatrice ;
- exigeante ;
- difficile à impressionner ;
- très consciente des rapports de pouvoir.

Elle déteste devoir quelque chose à quelqu'un.

## Arc

Son histoire peut traiter :

- sa place dans Greed Division ;
- sa relation avec Mammon ;
- la dette ;
- le contrôle ;
- la loyauté ;
- la vulnérabilité qu'elle refuse d'admettre.

---

# 20. Lucy — Assistante exécutive

## Fonction

Lucy est l'assistante du joueur.

Elle sert de lien entre :

- interface ;
- tutoriel ;
- messages ;
- employés ;
- événements ;
- organisation.

## Apparence

Direction visuelle :

- plus petite ;
- silhouette ronde ;
- blonde ;
- chignon imparfait ;
- lunettes ;
- blouse ivoire ;
- jupe sombre ;
- badge usé ;
- manches retroussées.

Elle doit sembler travailler réellement dans l'entreprise.

## Gameplay

Lucy améliore :

- planification ;
- logistique ;
- messages ;
- coordination ;
- affectations.

Elle peut réduire certains temps de préparation ou fournir des informations supplémentaires.

## Personnalité

Lucy est :

- intelligente ;
- pratique ;
- observatrice ;
- très organisée ;
- légèrement fatiguée ;
- plus mystérieuse qu'elle ne le paraît.

## Arc

Son histoire peut tourner autour de ce qu'elle sait réellement de HellCorp.

Question centrale :

> Pourquoi reste-t-elle dans cette entreprise ?

---

# 21. Malphas — Directrice des affaires occultes

## Fonction

Malphas dirige Occult.

Elle représente :

- connaissance interdite ;
- calme ;
- ancienneté ;
- stratégie ;
- surnaturel.

## Apparence

Direction visuelle :

- très grande ;
- cheveux blancs ;
- silhouette longue ;
- cornes asymétriques gravées ;
- oreilles démoniaques ;
- bordeaux ;
- noir ;
- or ancien ;
- formes verticales et pointues.

Son costume corporate doit évoquer un vêtement rituel sans devenir une armure fantasy.

## Gameplay

Malphas débloque :

- contrats occultes ;
- reliques ;
- événements paranormaux ;
- archives ;
- recherche surnaturelle.

## Personnalité

Malphas est :

- calme ;
- précise ;
- ancienne ;
- intimidante ;
- peu démonstrative ;
- fascinée par les pactes et les règles.

## Arc

Son histoire traite :

- anciens contrats ;
- obligations de HellCorp ;
- secrets archivés ;
- prix de la connaissance ;
- pactes impossibles à annuler.

---

# 22. Raven — Directrice de la sécurité

## Fonction

Raven dirige Security.

Elle représente :

- surveillance ;
- discipline ;
- menace ;
- protection ;
- intervention.

## Apparence

Direction visuelle :

- athlétique ;
- épaules marquées ;
- taille compacte ;
- cheveux noirs ;
- accents acier ;
- rouge d'alarme ;
- uniforme sécurité couture ;
- plumes sombres ;
- éléments métalliques numérotés.

Elle ne doit pas ressembler à un simple personnage tactique générique.

## Gameplay

Raven améliore :

- sécurité ;
- réduction du risque ;
- protection des équipes ;
- gestion des incidents ;
- récupération après échec.

## Personnalité

Raven est :

- directe ;
- disciplinée ;
- vigilante ;
- peu bavarde ;
- très professionnelle ;
- protectrice malgré elle.

## Arc

Son histoire confronte :

- devoir ;
- hiérarchie ;
- protection ;
- attachement ;
- loyauté à HellCorp contre loyauté envers le joueur.

---

# 23. Direction artistique

La direction artistique actuelle doit éviter le rendu IA générique.

Le style retenu est :

> **Manhwa / webtoon adulte, patte graphique marquée**

Caractéristiques :

- illustration numérique façon webtoon coréen ;
- lignes franches à épaisseur variable, contour extérieur appuyé, traits intérieurs fins ;
- ombrage peint dramatique, éclairage directionnel, rim light ;
- reflets satinés maîtrisés sur cheveux et peau, avec grain et relief, jamais uniformes ;
- yeux détaillés, iris rendu, catchlights ;
- palette saturée et signature par personnage ;
- rendu sensuel et séduisant assumé, anatomie mature cohérente ;
- influence mode éditoriale ;
- Art déco infernal ;
- animation adulte stylisée ;
- formes graphiques fortes.

À éviter :

- peau lissée en aplat uniforme sans grain ni relief ;
- rendu 3D déguisé ;
- ultra-détail inutile ;
- lumière orange/bleu générique, éclairage plat identique sur chaque image ;
- anatomie identique pour tous, même visage recyclé d'un personnage à l'autre ;
- bijoux et chaînes impossibles à animer ;
- symétrie faciale parfaite ou expression vide typique d'un rendu IA par défaut ;
- tout détail (mains, bijoux, logo fantôme) qui trahit une génération IA non retouchée.

Le contenu explicitement érotique n'appartient pas aux sprites de gameplay (bureau,
déplacement) : il vit dans un palier d'assets séparé, les scènes de Memory/événement
(sections 15-16). Les masters et sprites monde restent séduisants mais habillés,
cohérents avec un personnage que le joueur croise au travail.

---

# 24. Palette

Palette globale HellCorp :

```text
Charbon
Ivoire sale
Rouge oxydé
Bordeaux
Or vieilli
Violet sombre
Vert administratif
Acier
```

La palette doit être cohérente entre :

- splash arts ;
- portraits ;
- sprites ;
- UI ;
- décors.

---

# 25. Silhouettes

Chaque personnage doit être identifiable en silhouette noire.

Exemples :

```text
MORRIGAN
grande
sablier
cheveux volumineux
tailleur long

LUCY
plus petite
ronde
chignon
jupe
lunettes

MALPHAS
très grande
cornes
cheveux très longs
silhouette verticale

RAVEN
athlétique
épaules
uniforme compact
plumes
```

Si deux personnages sont difficiles à distinguer en silhouette, leur design doit être retravaillé.

---

# 26. Trois niveaux d'assets

Chaque personnage majeur possède trois représentations distinctes.

## Splash art

Utilisation :

- recrutement ;
- Memories ;
- écran personnage ;
- marketing ;
- événements majeurs.

Résolution cible :

```text
1536 × 2048
ou équivalent
```

Le splash art peut contenir davantage de détails.

## Portrait animé

Utilisation :

- dialogues ;
- messages ;
- gros plans ;
- événements.

Résolution approximative :

```text
1024 × 1536
```

Il doit être simplifié pour être riggable.

## Sprite monde

Utilisation :

- bureau ;
- marche ;
- interaction ;
- exploration.

Hauteur visible cible :

```text
192–256 px
```

Le sprite doit privilégier :

- silhouette ;
- contraste ;
- palette ;
- lisibilité.

---

# 27. Godot

Godot 4 est le moteur prévu.

Les outils principaux sont :

```text
Node2D
Sprite2D
AnimatedSprite2D
AnimationPlayer
Skeleton2D
Bone2D
Polygon2D
```

Les sprites de déplacement utilisent principalement des atlas.

Les portraits peuvent utiliser Skeleton2D.

---

# 28. Animation

Il faut éviter de générer toutes les frames indépendamment avec une IA.

Cela produit :

- changement de visage ;
- changement de proportions ;
- vêtements instables ;
- cheveux différents ;
- accessoires mutants.

Les animations répétables doivent être déterministes.

Exemples :

```text
idle
walk
talk
sit
stand
turn
use_computer
drink
interact
```

---

# 29. Budget sprite

Pour un personnage majeur :

```text
Idle
4 frames

Walk
6 frames × 4 directions = 24

Talk
4 frames

Sit
4 frames

Interact
4–8 frames
```

Environ :

```text
40–50 frames initiales
```

Le nombre peut augmenter avec les interactions.

---

# 30. Contraintes graphiques des sprites

Taille recommandée :

```text
cellule : 256 × 256
personnage : 192–224 px
```

Format :

```text
PNG RGBA
fond transparent
```

Palette :

```text
16–48 couleurs selon le niveau de détail
```

Éviter :

- micro-chaînes ;
- cheveux ultra-détaillés ;
- dizaines de bijoux ;
- motifs impossibles à lire ;
- textures réalistes ;
- éclairage cinématique baked dans chaque frame.

---

# 31. Pipeline visuel

La production ne doit pas être :

```text
prompt
↓
image IA
↓
asset final
```

Elle doit être :

```text
brief
↓
silhouette
↓
master reference
↓
génération contrôlée
↓
correction
↓
paint-over
↓
palette
↓
simplification
↓
sprite
↓
QA
```

L'IA sert d'outil de recherche et de préproduction.

Elle ne doit pas décider seule de l'identité finale.

---

# 32. Référence canonique

Chaque personnage doit posséder une image canonique.

Exemple :

```text
morrigan_master.png
lucy_master.png
malphas_master.png
raven_master.png
```

Une fois validée, cette image ne change plus sans décision volontaire.

Toutes les générations futures doivent être dérivées de cette référence.

---

# 33. LoRA personnage

Pour les personnages importants, une LoRA dédiée peut être entraînée.

Exemple :

```text
hellcorp_morrigan_v1.safetensors
hellcorp_lucy_v1.safetensors
```

Dataset recommandé :

```text
20–40 références propres
```

Le dataset doit conserver :

- visage ;
- proportions ;
- coiffure ;
- tenue ;
- palette ;
- accessoires clés.

---

# 34. Pipeline M3

Sur Apple Silicon M3, le pipeline local doit privilégier MLX.

Image :

```text
MFLUX
+
FLUX.2 Klein 4B
```

Portrait animé :

```text
FasterLivePortrait-MLX
```

Vidéo courte :

```text
MLX-Video
+
Wan2.2 TI2V 5B Q4
```

Gameplay :

```text
Godot
+
sprites
+
Skeleton2D
```

La vidéo IA ne doit pas remplacer les sprites de gameplay.

---

# 35. Vidéos courtes

Les modèles vidéo peuvent servir à :

- cinématiques ;
- événements spéciaux ;
- transitions ;
- séquences de quelques secondes.

Ils ne doivent pas servir à :

- walk loops ;
- idle loops ;
- mouvements répétables ;
- gameplay courant.

Raison :

- dérive d'identité ;
- jitter ;
- changement d'accessoires ;
- instabilité frame à frame.

---

# 36. Architecture de données

Le cœur logique doit être séparé de la présentation.

Structure conceptuelle :

```text
hellcorp/
│
├── core/
│   ├── game_state
│   ├── economy
│   ├── contracts
│   ├── employees
│   ├── relationships
│   ├── narrative
│   └── save_system
│
├── data/
│   ├── characters
│   ├── contracts
│   ├── buildings
│   ├── events
│   ├── dialogue
│   ├── items
│   └── balance
│
├── mobile/
├── pc/
└── shared/
```

---

# 37. GameState

Le mobile et le PC doivent lire le même état.

```text
AccountState
├── EconomyState
├── CompanyState
├── BuildingState
├── EmployeeState[]
├── CharacterState[]
├── ContractState[]
├── RelationshipState[]
├── NarrativeFlags[]
├── MemoryUnlocks[]
└── WorldState
```

---

# 38. Event Director

Les événements doivent être data-driven.

Exemple conceptuel :

```text
EVENT
morrigan_late_night_01

Requirements:
- morrigan_hired
- trust >= 15
- finance_department >= 1
- time >= 18:00

Location:
morrigan_office

Actors:
morrigan
player

Choices:
A → trust +5
B → respect +3
C → attraction +4

Unlock:
memory_morrigan_03
```

Il ne faut pas coder chaque événement directement dans une scène Godot.

---

# 39. Première heure

Structure envisagée :

```text
00:00
cinématique promotion catastrophique

00:05
Lucy et premiers employés

00:10
premier contrat

00:15
récompense

00:20
tutoriel recrutement

00:30
nouveau personnage

00:35
conflit d'employés

00:45
message personnel

00:50
DAY SHIFT COMPLETE

puis Night Shift PC
```

Le joueur découvre alors le même bureau en exploration.

---

# 40. Vertical slice

Le vertical slice doit prouver toute la chaîne.

Contenu :

```text
1 département
Finance

3 personnages majeurs
Morrigan
Lucy
Raven

6 employés secondaires

10 contrats

1 recrutement

1 construction

1 conflit

1 Night Shift

1 mini-arc Morrigan

3 Memories

1 conséquence PC → mobile
```

---

# 41. Test principal du vertical slice

Le joueur doit pouvoir :

```text
recruter Morrigan sur mobile
↓
recevoir un message
↓
ouvrir la version PC
↓
marcher jusqu'à son bureau
↓
vivre un événement
↓
faire un choix
↓
revenir au management
↓
constater un changement mécanique
```

Si cette boucle fonctionne, HellCorp fonctionne.

---

# 42. V1 cible

Version 1 envisagée :

```text
12 personnages majeurs
30–50 employés secondaires

5 départements
Finance
Legal
Marketing
Occult
Security

40–60 contrats

1 étage évolutif
plus quelques lieux externes

bar
restaurant
penthouse
archives
zones HellCorp

8–12 heures de contenu narratif

plusieurs dizaines d'événements Night Shift

Memories
messagerie
recrutement
relations
management
construction
```

---

# 43. Fonctionnalités repoussées

À ne pas prioriser avant le vertical slice :

```text
LLM
multijoueur
PvP
guildes
centaines de personnages
open world
housing complexe
marché joueur
combat traditionnel
voix intégrales
sept divisions jouables immédiatement
```

---

# 44. IA conversationnelle

## V1

```text
dialogues écrits
variables
templates
Event Director
```

Aucun LLM nécessaire.

## V2

LLM pour :

- variations SMS ;
- petites conversations ;
- dialogues facultatifs.

## V3

LLM pour :

- mémoire ;
- conversation libre ;
- événements émergents ;
- personnalité dynamique.

L'architecture doit permettre cette évolution sans reconstruire le jeu.

---

# 45. Monétisation envisagée

Architecture envisagée :

```text
PC
achat premium

Mobile
F2P
```

Monétisation possible :

- cosmétiques ;
- tenues ;
- décorations ;
- confort ;
- accélérations raisonnables ;
- slots supplémentaires ;
- contenu narratif ;
- extensions ;
- pass saisonnier.

Les personnages majeurs ne doivent pas être bloqués uniquement derrière un paiement.

---

# 46. Principe de monétisation

Le désir d'achat doit être :

> **J'aime ce personnage et je veux plus de contenu autour de lui.**

Pas :

> **Je dois payer pour continuer la relation de base.**

---

# 47. Règle fondamentale de design

Chaque élément important doit toucher au moins deux systèmes.

Exemples :

```text
personnage narratif
→ gameplay

bâtiment
→ nouvelle zone PC

relation
→ bonus ou malus

contrat
→ événement narratif

Night Shift
→ conséquence management
```

---

# 48. Règle fondamentale artistique

Chaque personnage doit posséder :

```text
silhouette propre
palette propre
motif propre
objet personnel
posture habituelle
imperfection volontaire
détail narratif
```

La beauté générique ne suffit pas.

---

# 49. Morrigan — identité graphique

```text
Couleurs
noir
ivoire
or

Motifs
triangles
verticales
finance
Art déco

Silhouette
grande
sablier
tailleur long

Signature
cheveux noirs asymétriques
bijou calculatrice / motif financier
regard évaluateur
```

---

# 50. Lucy — identité graphique

```text
Couleurs
ivoire
brun tabac
vert administratif

Motifs
cercles
papier
organisation

Silhouette
petite
ronde
chignon

Signature
lunettes
manches remontées
badge usé
encre sur les doigts
```

---

# 51. Malphas — identité graphique

```text
Couleurs
bordeaux
noir
os
violet

Motifs
runes
arcs
verticales

Silhouette
très grande
longue
cornes

Signature
cornes gravées
cheveux blancs
costume rituel corporate
```

---

# 52. Raven — identité graphique

```text
Couleurs
noir bleuté
acier
rouge alarme

Motifs
blocs
angles
numéros
sécurité

Silhouette
athlétique
compacte
épaules fortes

Signature
plumes
plaques numérotées
uniforme sécurité couture
```

---

# 53. Ce que HellCorp ne doit pas devenir

Le projet doit éviter :

- un simple gacha ;
- un idle game sans profondeur ;
- un visual novel statique ;
- un catalogue de personnages sans systèmes ;
- un jeu entièrement généré par IA ;
- une accumulation de monnaies ;
- une surproduction de personnages sans contenu ;
- des sprites trop détaillés pour être animés ;
- des splash arts génériques sans direction artistique.

---

# 54. Ce que HellCorp doit devenir

HellCorp doit donner l'impression que :

```text
chaque personnage travaille réellement ici
chaque département existe réellement
chaque choix laisse une trace
chaque recrutement change le bâtiment
chaque soirée raconte quelque chose
chaque relation affecte le management
```

Le joueur ne collectionne pas seulement des personnages.

Il construit une entreprise dans laquelle ces personnages vivent.

---

# 55. Objectif de production immédiat

La priorité actuelle est :

```text
1. verrouiller la direction artistique
2. valider les masters de Morrigan, Lucy, Malphas et Raven
3. produire Morrigan en sprite 192–224 px
4. créer idle + walk
5. intégrer Morrigan dans Godot
6. tester la lisibilité
7. seulement ensuite produire les autres personnages
```

---

# 56. Critères de validation d'un sprite

Un sprite est validé si :

- le personnage reste reconnaissable à 200 px ;
- la silhouette est claire ;
- les jambes et bras restent lisibles ;
- les détails importants survivent au downscale ;
- le sprite peut être animé sans casser le costume ;
- les couleurs restent distinctes du décor ;
- le visage n'a pas besoin de détails impossibles à voir ;
- il fonctionne dans Godot sans dizaines de calques.

---

# 57. Critères de validation d'un personnage

Un personnage majeur doit être validé sur quatre axes.

## Gameplay

Il change réellement la manière de jouer.

## Narration

Il possède un arc propre.

## Visuel

Il est identifiable immédiatement.

## Relations

Les interactions avec lui ne sont pas interchangeables avec celles d'un autre personnage.

---

# 58. Philosophie générale

HellCorp doit rester systémique avant d'être volumineux.

Trois excellents personnages valent mieux que trente personnages superficiels.

Un seul département profond vaut mieux que huit menus vides.

Une seule Night Shift mémorable vaut mieux que cinquante événements génériques.

La production doit toujours privilégier :

```text
cohérence
lisibilité
identité
interconnexion
réutilisabilité
```

---

# 59. Conclusion

HellCorp repose sur une idée forte :

> **Construire une entreprise infernale le jour et vivre à l'intérieur la nuit.**

Le mobile crée la structure.

Le PC crée l'attachement.

Le management donne de la valeur aux personnages.

Les personnages donnent du sens au management.

La direction artistique doit rester suffisamment simple pour être animable dans Godot, tout en conservant une identité graphique propre.

La priorité n'est pas de produire énormément de contenu.

La priorité est de construire une première boucle complète où :

```text
recrutement
management
exploration
relation
conséquence
```

fonctionnent comme un seul jeu.
