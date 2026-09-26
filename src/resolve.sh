#!/bin/bash
# Pass a result through to Alfred's clipboard object.
# Very long values arrive as "tkfile:<path>" (written by tk.js to the workflow cache).
case "$1" in
  tkfile:*)
    f="${1#tkfile:}"
    case "$f" in
      "$alfred_workflow_cache"/big/big-*.txt) [[ "$f" != *..* && -f "$f" ]] && cat -- "$f" || printf '%s' "$1" ;;
      *) printf '%s' "$1" ;;
    esac ;;
  *) printf '%s' "$1" ;;
esac
