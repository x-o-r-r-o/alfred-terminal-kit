# Terminal Kit — Plan

**Priority tier:** 1 · **Bundle ID:** `io.github.x-o-r-r-o.terminal-kit` · **Keywords:** `warp`, `hist`, `tldr`, `ssh`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Warp | 113,777 |
| Cheatsheets | 42,334 |
| SSH Connection Manager | 11,430 |
| TLDR Pages | 11,296 |
| Shell History | 5,560 |
| **Total** | **184,397** |

**Alfred today:** No Warp workflow at all; cheat.sh (2022) and navi (2020); no shell-history search; SSH workflow from 2013.

## Features (v1.0)
- [x] `warp` open Warp Tab Configs and launch configurations / new tab or window in the Finder folder / Universal Action "Open in Terminal"
- [x] `hist <query>` fuzzy search zsh/bash/fish/atuin history (cached index), copy, paste or run in chosen terminal
- [x] `tldr <cmd>` offline tldr pages (cached archive, weekly refresh) with copyable examples; cheat.sh fallback
- [x] `ssh` hosts from ~/.ssh/config (with Include) + known_hosts, open in preferred terminal
- [x] Terminal preference: Warp, Ghostty, iTerm2, Terminal, kitty, WezTerm, Alacritty (auto-detected)

## Round 4 (post-release audit, v1.0.1 candidate)
- [x] Universal Action with several folders: Alfred passes each item as its own argument; only the first was opened (`"$1"` → `"$@"`).
- [x] zsh history edited or merged by other tools (plain UTF-8 with 0x83 bytes, e.g. Cyrillic) is no longer garbled by unmetafying.
- [x] Checkboxes also accept "true"/"false"; `zsh history file` accepts `$HOME/…`, `${HOME}/…` and quotes, and says when the file doesn't exist.
- [x] Terminal and iTerm2 honour the folder when running a command outside the home folder.
- [x] New: <kbd>⌃</kbd><kbd>↩</kbd> on a history entry runs it in the frontmost Finder folder.
- [x] New: "Hide commands with" setting keeps commands with secrets out of the history list.
- [x] Tests run on the system Python 3.9 (no `tomllib`) and under Alfred's minimal environment.

## Ideas for v1.1
Ranked by value for effort; none implemented yet.
1. Warp Workflows (`~/.warp/workflows/*.yaml`) in the `warp` list: copy or run the command with its arguments filled in (Raycast users asked for "launch workflows").
2. `hist` shell filter in the query (`zsh: git`, `bash: …`) and a per-shell toggle in the Workflow’s Configuration.
3. `ssh`: <kbd>⌃</kbd><kbd>↩</kbd> to open the host in Finder via SFTP (`sftp://`), or with Transmit/Cyberduck when installed; show `Host *` defaults (User) in subtitles.
4. `ssh`: read `/etc/ssh/ssh_config` Includes and the `Match host` blocks' HostName for subtitles.
5. `tldr`: <kbd>⌘</kbd><kbd>Y</kbd> Quick Look of the whole page (render it to a cached Markdown/HTML file).
6. `hist`: "Copy and fill placeholders" for commands with `<...>` or `{{...}}`, reusing the tldr placeholder parser.
7. Hyper and Tabby as terminals (Raycast SSH users asked for Hyper).
8. Start the tldr download at install time (a hidden first-run trigger) so the first `tldr` query never waits.
9. Replace `/usr/bin/shasum` (a Perl script) with CommonCrypto via JXA, for macOS versions that drop Perl.

## Known limitations
- Warp has no scripting API. Warp 0.2026.05.20+ runs commands from a temporary Tab Config (deleted after 60 s); older versions get the command pasted into a new tab, which needs Accessibility access for Alfred.
- Hashed `known_hosts` entries can't be listed; `Match` blocks and `Host *` defaults aren't shown in subtitles (ssh still applies them when connecting).
- Only the newest 32 MB of each history file and the newest 50,000 atuin commands are indexed.
- cheat.sh is online only (results cached for a day, older copies shown offline with their age); after an HTTP 429 every lookup pauses for five minutes.
- tldr pages of a language you stop using stay in the workflow cache.

## Verify in real Alfred
- [ ] `warp://tab_config/<name>` (and `?new_window=true`) with real Warp and Warp Preview; the temporary run config runs the command in the right folder and disappears.
- [ ] The paste fallback on a Warp older than 0.2026.05.20 (Accessibility prompt, clipboard restored).
- [ ] Ghostty 1.3+ AppleScript, iTerm2 tab/window, Terminal on a cold start (no second window), kitty/WezTerm/Alacritty via runner.sh.
- [ ] Universal Action with several folders selected.
- [ ] Modifier subtitles: ⌃ on a Launch Configuration and ⌥ on "Connect to …" say why nothing happens.
- [ ] First tldr download: "Downloading…" reruns, then the page appears.

## Tech
- **Stack:** zsh + JXA; fixed AppleScripts that take commands as argv.
- **Dependencies:** None. tldr pages are data, not code, so fetching them is allowed; cache them in alfred_workflow_cache.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `python3 tools/build.py --package` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] Any compiled binary is Developer ID signed + notarised; never strip quarantine
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README and the forum post
- [ ] Version bumped in `src/info.plist`; `python3 tools/build.py --package`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link
