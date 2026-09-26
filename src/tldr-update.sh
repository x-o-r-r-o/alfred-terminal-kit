#!/bin/zsh -f
# Download the official tldr pages archives (data, not code) into the workflow cache.
# Usage: tldr-update.sh <cache-dir> <lang>...   (tk.js has already taken <cache-dir>/.lock)
# Only Markdown pages are kept: no symbolic links, no other files, and nothing executable.
zmodload zsh/datetime
base=$1; shift
lock="$base/.lock"
print -r -- $$ 2>/dev/null > "$lock/pid"  # tk.js checks that this process is alive
# Remove the lock only while it is still ours.
trap '[[ ! -f $lock/pid || $(<$lock/pid) == $$ ]] && rm -rf -- "$lock"' EXIT
url_tpl=${TK_TLDR_URL:-https://github.com/tldr-pages/tldr/releases/latest/download/tldr-pages.{lang}.zip}
sums_url=${TK_TLDR_SUMS_URL:-${url_tpl%/*}/tldr.sha256sums}
max_bytes=$(( 200 * 1024 * 1024 ))   # uncompressed; the English pages are about 5 MB
sums=""

fetch() {  # fetch <url> <file>
  /usr/bin/curl -fsSL --max-time 120 --retry 1 -o "$2" -- "$1" 2>>"$tmp/err"
}

check() {  # check <zip> <name>: checksum (when the release publishes one), size and CRCs
  local zip=$1 name=$2 want got size
  if [[ -n $sums ]]; then
    want=${${(M)${(f)sums}:#[0-9a-f](#c64)  $name}%% *}
    if [[ -n $want ]]; then
      got=$(/usr/bin/shasum -a 256 -- "$zip"); got=${got%% *}
      [[ $got == $want ]] || { print -r -- "The archive’s checksum doesn’t match" >> "$tmp/err"; return 1 }
    fi
  fi
  size=$(/usr/bin/unzip -l -- "$zip" 2>/dev/null | /usr/bin/tail -n 1); size=${${=size}[1]}
  [[ $size == <-> ]] && (( size <= max_bytes )) || { print -r -- "The archive is too large" >> "$tmp/err"; return 1 }
  /usr/bin/unzip -tqq -- "$zip" >/dev/null 2>>"$tmp/err"
}

setopt extendedglob
for lang in "$@"; do
  [[ $lang =~ '^[a-z]{2,3}(_[A-Z]{2})?$' ]] || continue
  url=${url_tpl//\{lang\}/$lang}
  tmp=$(/usr/bin/mktemp -d "$base/.tmp.XXXXXX") || exit 1
  [[ -z $sums ]] && sums=$(/usr/bin/curl -fsSL --max-time 30 -- "$sums_url" 2>/dev/null)
  ok=0
  if fetch "$url" "$tmp/pages.zip" && check "$tmp/pages.zip" "${url:t}" &&
     /usr/bin/unzip -qo "$tmp/pages.zip" -d "$tmp/pages" 2>>"$tmp/err" >/dev/null; then
    ok=1
    # Keep directories and *.md files only, readable and not executable.
    /usr/bin/find "$tmp/pages" \( -type l -o \( ! -type d ! -name '*.md' \) \) -delete 2>/dev/null
    /usr/bin/find "$tmp/pages" -type f -exec /bin/chmod 0644 {} + 2>/dev/null
    /usr/bin/find "$tmp/pages" -type d -exec /bin/chmod 0755 {} + 2>/dev/null
  fi
  if (( ok )) && [[ -d $tmp/pages/common ]]; then
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
