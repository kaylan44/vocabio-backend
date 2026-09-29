#!/usr/bin/env bash
# Lance `npx <args>` depuis la racine du projet, quel que soit l'environnement
# dans lequel Claude Code exécute ses hooks.
#
# Pourquoi ce script : Node est installé DANS WSL (via nvm), mais l'app desktop
# Claude Code tourne sous Windows et exécute les hooks dans Git Bash, où `npx`
# n'existe pas. Un simple `npx jest` échouait donc avec "command not found" et,
# comme le hook sort en code 2, bloquait Claude en boucle.
#
# Alternatives écartées :
# - coder en dur `wsl.exe ... cd ~/vocabio-backend` : casse si le repo est cloné
#   ailleurs ou si on lance Claude directement depuis WSL/Linux.
# - installer Node côté Windows : deux installations à garder synchronisées.
set -u

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 1

if command -v npx >/dev/null 2>&1; then
  # Cas simple : Claude lancé depuis WSL/Linux/macOS, Node dans le PATH.
  exec npx "$@"
elif command -v wsl.exe >/dev/null 2>&1; then
  # Cas Windows : wsl.exe reprend le dossier courant (chemin \\wsl.localhost\...)
  # et le traduit en chemin Linux. On charge nvm explicitement car un shell
  # non interactif ne lit pas ~/.bashrc, où nvm s'initialise d'habitude.
  # "$@" est passé en arguments positionnels (après `_`, qui devient $0) pour
  # éviter les soucis d'échappement qu'on aurait en les collant dans la chaîne.
  # --exec est indispensable : sans lui, wsl.exe recolle tous les arguments en
  # une seule ligne réinterprétée par le shell Linux, les guillemets sautent et
  # npx reçoit une commande vide ("could not determine executable to run").
  exec wsl.exe --exec bash -c '. "$HOME/.nvm/nvm.sh" >/dev/null && npx "$@"' _ "$@"
else
  # Ni Node ni WSL : on prévient sans bloquer (exit 0), sinon le hook Stop
  # empêcherait Claude de terminer son tour, indéfiniment.
  echo "[hook] npx introuvable (ni Node ni WSL) : 'npx $*' ignoré" >&2
  exit 0
fi
