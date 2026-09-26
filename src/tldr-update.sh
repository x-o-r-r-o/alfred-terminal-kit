#!/bin/zsh -f
# Download the official tldr pages archives (data, not code) into the workflow cache.
# Usage: tldr-update.sh <cache-dir> <lang>...   (tk.js has already taken <cache-dir>/.lock)
zmodload zsh/datetime
base=$1; shift
lock="$base/.lock"
trap 'rm -rf -- "$lock"' EXIT
url_tpl=${TK_TLDR_URL:-https://github.com/tldr-pages/tldr/releases/latest/download/tldr-pages.{lang}.zip}
for lang in "$@"; do
  [[ $lang =~ '^[a-z]{2,3}(_[A-Z]{2})?$' ]] || continue
  url=${url_tpl//\{lang\}/$lang}
  tmp=$(/usr/bin/mktemp -d "$base/.tmp.XXXXXX") || exit 1
  if /usr/bin/curl -fsSL --max-time 120 --retry 1 -o "$tmp/pages.zip" -- "$url" 2>"$tmp/err" &&
     /usr/bin/unzip -qo "$tmp/pages.zip" -d "$tmp/pages" 2>>"$tmp/err" >/dev/null &&
     [[ -d $tmp/pages/common ]]; then
    rm -rf -- "$base/$lang.old"
    [[ -d $base/$lang ]] && mv -- "$base/$lang" "$base/$lang.old"
    if mv -- "$tmp/pages" "$base/$lang"; then
      rm -rf -- "$base/$lang.old" "$base/$lang.error"
      print -r -- "$EPOCHSECONDS" > "$base/$lang.stamp"
    else
      [[ -d $base/$lang.old ]] && mv -- "$base/$lang.old" "$base/$lang"   # keep the old pages
    fi
  else
    [[ -s $tmp/err ]] || print -r -- "The archive has no pages" > "$tmp/err"
    /usr/bin/head -c 300 "$tmp/err" > "$base/$lang.error"
  fi
  rm -rf -- "$tmp"
done
