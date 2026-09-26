#!/bin/zsh -f
# Started by a terminal (kitty, WezTerm, Alacritty, older Ghostty) to run one command.
# Usage: runner.sh <dir> <command-file>
# The command is read from a private file written by tk.js (never from argv or source code),
# run by the user's login shell with their aliases, and an interactive shell stays open.
dir=$1 file=$2
[[ -n $dir && -d $dir ]] && cd -- "$dir"
shell=${SHELL:-/bin/zsh}
if [[ -n $file && -f $file ]]; then
  cmd=$(<"$file")
  rm -f -- "$file"
  print -r -- "❯ $cmd"
  "$shell" -i -c "$cmd"
fi
exec "$shell" -l
