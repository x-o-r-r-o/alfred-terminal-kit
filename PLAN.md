# Terminal Kit — Plan

**Priority tier:** 1 · **Bundle ID:** `com.xorro.terminal-kit`

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
- [ ] `warp` open Warp launch configurations / new tab in folder / open current Finder folder in Warp
- [ ] `hist <query>` fuzzy search zsh/bash/fish history, paste or run in chosen terminal
- [ ] `tldr <cmd>` offline tldr pages (cached archive) with copyable examples
- [ ] `ssh` hosts from ~/.ssh/config + known_hosts, open in preferred terminal
- [ ] Terminal preference: Warp, Ghostty, iTerm2, Terminal

## Tech
- **Stack:** zsh + JXA.
- **Dependencies:** None (tldr archive downloaded on first use).
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post
