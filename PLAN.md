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
