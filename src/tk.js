#!/usr/bin/osascript -l JavaScript
// Terminal Kit for Alfred: Warp launch configurations, shell history, tldr pages and SSH hosts.
// Usage: osascript -l JavaScript tk.js <command> [query]
//   warp | hist | tldr | ssh   Script Filters
//   act                        run the action named by $tk_action on the argument
//   open-dirs                  open folders (tab-separated) in the preferred terminal
// Untrusted strings (commands, paths, host names) never become part of AppleScript or shell
// source: they are passed as argv to fixed scripts in ./applescript and ./runner.sh.
ObjC.import("Foundation");
ObjC.import("AppKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}

// TK_HOME replaces $HOME for every file the workflow reads (used by the test suite).
const HOME = env("TK_HOME", env("HOME", $.NSHomeDirectory().js)).replace(/\/+$/, "");
const DRY = env("TK_DRY_RUN", "") === "1";
const FM = $.NSFileManager.defaultManager;
const CWD = FM.currentDirectoryPath.js;
const WEEK = 7 * 86400;

// ---------- helpers ----------

function now() {
  return Date.now() / 1000;
}

function exists(path) {
  return FM.fileExistsAtPath(path);
}

function isDir(path) {
  const d = Ref();
  return FM.fileExistsAtPathIsDirectory(path, d) && d[0];
}

function stat(path) {
  const a = FM.attributesOfItemAtPathError(path, $());
  if (a.isNil()) return null;
  return { mtime: a.fileModificationDate.timeIntervalSince1970, size: Number(a.fileSize), dir: a.fileType.js === "NSFileTypeDirectory" };
}

function listDir(path) {
  const a = FM.contentsOfDirectoryAtPathError(path, $());
  return a.isNil() ? [] : a.js.map((s) => s.js);
}

// Every byte becomes one char 0–255, so nothing can fail to decode.
function readLatin1(path) {
  const s = $.NSString.alloc.initWithContentsOfFileEncodingError(path, $.NSISOLatin1StringEncoding, $());
  return s.isNil() ? null : s.js;
}

// Bytes (as a Latin-1 string) -> text. Invalid UTF-8 lines are kept as Latin-1.
function decodeUTF8(s) {
  if (!/[\x80-\xff]/.test(s)) return s;
  try {
    return decodeURIComponent(escape(s));
  } catch (e) {
    return s.split("\n").map((l) => {
      try {
        return decodeURIComponent(escape(l));
      } catch (e2) {
        return l;
      }
    }).join("\n");
  }
}

function readText(path) {
  const raw = readLatin1(path);
  return raw === null ? null : decodeUTF8(raw).replace(/^﻿/, "");
}

function writeFile(path, text) {
  return $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}

function mkdirs(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}

function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}terminal-kit`));
}

function expandTilde(p) {
  return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p;
}

function tildify(p) {
  return p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

function oneLine(s, max = 200) {
  const t = String(s).replace(/\r?\n/g, " ⏎ ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function plural(n, word) {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

// POSIX shell quoting for display and for commands the user will run.
function shq(s) {
  s = String(s);
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

// Run a program with argv (never through a shell). Returns {ok, out, err, status}.
function exec(path, args, { wait = true, input = null } = {}) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  let outP = null, errP = null;
  if (wait) {
    outP = $.NSPipe.pipe;
    errP = $.NSPipe.pipe;
    task.standardOutput = outP;
    task.standardError = errP;
  } else {
    // Detached: never hold Alfred's stdout open.
    task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;
    task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
  }
  const inP = input !== null ? $.NSPipe.pipe : null;
  task.standardInput = inP || $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError($())) return { ok: false, out: "", err: `Couldn't run ${path}`, status: -1 };
  if (inP) {
    inP.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
    inP.fileHandleForWriting.closeFile;
  }
  if (!wait) return { ok: true, out: "", err: "", status: 0 };
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const str = (d) => {
    const s = $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding);
    return s.isNil() ? "" : s.js;
  };
  return { ok: task.terminationStatus === 0, out: str(out), err: str(err).trim(), status: task.terminationStatus };
}

// Fuzzy score: higher is better, 0 = no match.
function score(text, query) {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = q.split(/\s+/);
  if (words.every((w) => t.includes(w))) {
    return new RegExp("(^|[\\s/._-])" + words[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(t) ? 60 : 40;
  }
  let i = 0;
  const flat = q.replace(/\s+/g, "");
  for (const c of t) if (c === flat[i]) i++;
  return i === flat.length ? 10 : 0;
}

function ago(t) {
  const d = now() - t;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 2 * 86400) return "yesterday";
  if (d < 30 * 86400) return `${Math.floor(d / 86400)} days ago`;
  const date = new Date(t * 1000);
  return date.toISOString().slice(0, 10);
}

// Alfred's JSON should stay small: very long values travel as "tkfile:<cache path>" and are read
// back by ./resolve.sh (copy, paste) or resolveArg (other actions).
const LARGE = 20000;
function bigArg(text) {
  if (text.length <= LARGE) return text;
  const dir = mkdirs(`${cacheDir()}/big`);
  const path = `${dir}/big-${hash(text)}-${text.length}.txt`;
  if (!exists(path)) writeFile(path, text);
  return `tkfile:${path}`;
}

function resolveArg(arg) {
  const m = /^tkfile:(.*)$/s.exec(arg);
  if (!m) return arg;
  const dir = `${cacheDir()}/big/`;
  if (!m[1].startsWith(dir) || !/^big-[0-9a-f]{8}-\d+\.txt$/.test(m[1].slice(dir.length))) return arg;
  const t = readText(m[1]);
  return t === null ? arg : t;
}

function textFor(value) {
  const short = value.length > 5000 ? value.slice(0, 5000) + "…" : value;
  return { copy: value.length > LARGE ? "Too long for ⌘C: press ↩ to copy it" : value, largetype: short };
}

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}

function output(items, extra = {}) {
  return JSON.stringify(Object.assign({ skipknowledge: true, items }, extra));
}

// ---------- terminals ----------

const TERMINALS = {
  iterm: { name: "iTerm2", ids: ["com.googlecode.iterm2"] },
  ghostty: { name: "Ghostty", ids: ["com.mitchellh.ghostty"] },
  warp: { name: "Warp", ids: ["dev.warp.Warp-Stable"] },
  kitty: { name: "kitty", ids: ["net.kovidgoyal.kitty"] },
  wezterm: { name: "WezTerm", ids: ["com.github.wez.wezterm"] },
  alacritty: { name: "Alacritty", ids: ["org.alacritty", "io.alacritty"] },
  terminal: { name: "Terminal", ids: ["com.apple.Terminal"] },
};
const AUTO_ORDER = ["iterm", "ghostty", "warp", "kitty", "wezterm", "alacritty", "terminal"];

function warpPreview() {
  return env("warp_release", "stable") === "preview";
}

function warpId() {
  return warpPreview() ? "dev.warp.Warp-Preview" : "dev.warp.Warp-Stable";
}

// Path of an installed terminal, or null. TK_APPS='{"iterm":"/path"}' fakes the installed set in tests.
const appCache = {};
function appPath(key) {
  if (key in appCache) return appCache[key];
  const fake = env("TK_APPS", null);
  let path = null;
  if (fake !== null) {
    path = JSON.parse(fake)[key] || null;
  } else {
    const ids = key === "warp" ? [warpId()] : TERMINALS[key].ids;
    for (const id of ids) {
      const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
      if (!url.isNil()) {
        path = url.path.js;
        break;
      }
    }
    if (!path && key === "terminal") path = "/System/Applications/Utilities/Terminal.app";
  }
  appCache[key] = path;
  return path;
}

function installedTerminals() {
  return AUTO_ORDER.filter((k) => appPath(k));
}

function preferredTerminal() {
  const want = env("terminal", "auto");
  if (TERMINALS[want] && appPath(want)) return want;
  return installedTerminals()[0] || "terminal";
}

function opensTab(key) {
  return env("terminal_open_in", "window") === "tab" && ["iterm", "ghostty", "warp"].includes(key);
}

function terminalName(key) {
  return key === "warp" && warpPreview() ? "Warp Preview" : TERMINALS[key].name;
}

function appVersion(appPathStr) {
  const fake = env("TK_APP_VERSION", null);
  if (fake !== null) return fake;
  const d = $.NSDictionary.dictionaryWithContentsOfFile(`${appPathStr}/Contents/Info.plist`);
  if (d.isNil()) return "0";
  const v = d.objectForKey("CFBundleShortVersionString");
  return v.isNil() ? "0" : v.js;
}

function versionAtLeast(v, want) {
  const a = String(v).split(/[.\-+ ]/).map((x) => parseInt(x, 10) || 0);
  const b = want.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  }
  return true;
}

// A command for runner.sh is written to a private file; only its path travels as argv.
function commandFile(cmd) {
  const dir = mkdirs(`${cacheDir()}/run`);
  // Remove leftovers older than a day (runner.sh deletes the file it runs).
  for (const f of listDir(dir)) {
    const s = stat(`${dir}/${f}`);
    if (s && now() - s.mtime > 86400) FM.removeItemAtPathError(`${dir}/${f}`, $());
  }
  const path = `${dir}/cmd-${$.NSUUID.UUID.UUIDString.js}.txt`;
  writeFile(path, cmd);
  FM.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: 0o600 }), path, $());
  return path;
}

function urlEncodePath(p) {
  return encodeURIComponent(p);
}

// The steps that open `dir` (and optionally type `cmd`) in terminal `term`.
function plan(term, cmd, dir) {
  const app = appPath(term) || appPath("terminal");
  const tab = env("terminal_open_in", "window") === "tab";
  dir = dir || HOME;
  const runner = `${CWD}/runner.sh`;
  const viaRunner = () => ["/bin/zsh", "-f", runner, dir, commandFile(cmd)];
  switch (term) {
    case "iterm":
      if (!cmd) return [{ type: "exec", argv: ["/usr/bin/open", "-a", app, dir] }];
      return [{ type: "applescript", script: "iterm", argv: [cmd, tab ? "tab" : "window"] }];
    case "ghostty":
      if (versionAtLeast(appVersion(app), "1.3")) {
        return [{ type: "applescript", script: "ghostty", argv: [dir, cmd || "", tab ? "tab" : "window"] }];
      }
      if (!cmd) return [{ type: "exec", argv: ["/usr/bin/open", "-na", app, "--args", `--working-directory=${dir}`] }];
      return [{ type: "exec", argv: ["/usr/bin/open", "-na", app, "--args", `--working-directory=${dir}`, "-e", ...viaRunner()] }];
    case "warp": {
      const scheme = warpPreview() ? "warppreview" : "warp";
      const url = `${scheme}://action/new_${tab ? "tab" : "window"}?path=${urlEncodePath(dir)}`;
      if (!cmd) return [{ type: "url", url }];
      return [{ type: "warp-paste", url, cmd, bundleid: warpId() }];
    }
    case "kitty":
      return [{ type: "exec", argv: ["/usr/bin/open", "-na", app, "--args", "--single-instance", "--directory", dir, ...(cmd ? viaRunner() : [])] }];
    case "wezterm":
      return [{ type: "exec", argv: ["/usr/bin/open", "-na", app, "--args", "start", "--cwd", dir, ...(cmd ? ["--", ...viaRunner()] : [])] }];
    case "alacritty":
      return [{ type: "exec", argv: ["/usr/bin/open", "-na", app, "--args", "--working-directory", dir, ...(cmd ? ["-e", ...viaRunner()] : [])] }];
    default:
      if (!cmd) return [{ type: "exec", argv: ["/usr/bin/open", "-a", app, dir] }];
      return [{ type: "applescript", script: "terminal", argv: [cmd] }];
  }
}

function setClipboard(text, transient) {
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType($(text), $.NSPasteboardTypeString);
  if (transient) {
    // nspasteboard.org markers: clipboard managers (Alfred included) skip this entry.
    pb.setStringForType($(""), $("org.nspasteboard.TransientType"));
    pb.setStringForType($(""), $("org.nspasteboard.AutoGeneratedType"));
  }
}

function getClipboard() {
  const s = $.NSPasteboard.generalPasteboard.stringForType($.NSPasteboardTypeString);
  return s.isNil() ? null : s.js;
}

function openURL(url) {
  if (!/^(https?|warp|warppreview):\/\//i.test(url)) return false;
  if (DRY) return true;
  return $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
}

// Open `dir` / run `cmd` in the preferred terminal. Returns a message for the notification, or undefined.
function launch(cmd, dir) {
  const term = preferredTerminal();
  const steps = plan(term, cmd, dir);
  if (DRY) {
    console.log(JSON.stringify({ terminal: term, steps }));
    return undefined;
  }
  for (const s of steps) {
    let r = { ok: true, err: "" };
    if (s.type === "exec") r = exec(s.argv[0], s.argv.slice(1));
    else if (s.type === "applescript") r = exec("/usr/bin/osascript", [`${CWD}/applescript/${s.script}.applescript`, ...s.argv]);
    else if (s.type === "url") r = { ok: openURL(s.url), err: "Couldn't open Warp" };
    else if (s.type === "warp-paste") r = warpPaste(s);
    if (!r.ok) {
      if (cmd) setClipboard(cmd, false);
      return `Couldn't open ${terminalName(term)}${r.err ? `: ${oneLine(r.err, 120)}` : ""}${cmd ? ". The command is on the clipboard." : ""}`;
    }
    if (r.message) return r.message;
  }
  return undefined;
}

// Warp has no scripting API: open a tab or window, then paste the command with ⌘V and press Return,
// but only once Warp is really frontmost. The clipboard is restored afterwards.
function warpPaste(s) {
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(s.bundleid).count > 0;
  const previous = getClipboard();
  setClipboard(s.cmd, true);
  if (!openURL(s.url)) return { ok: false, err: "Couldn't open Warp" };
  const r = exec("/usr/bin/osascript", [`${CWD}/applescript/warp-paste.applescript`, s.bundleid, running ? "warm" : "cold"]);
  if (r.ok && r.out.trim() === "ok") {
    delay(0.4);
    if (previous !== null) setClipboard(previous, false);
    return { ok: true };
  }
  setClipboard(s.cmd, false);
  return { ok: true, message: "Warp didn't come to the front in time. The command is on the clipboard: press ⌘V in Warp." };
}

// ---------- Finder ----------

function finderFolder() {
  const fake = env("TK_FINDER_DIR", null);
  if (fake !== null) return fake || null;
  if ($.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.finder").count === 0) return null;
  try {
    const finder = Application("Finder");
    const wins = finder.finderWindows();
    const target = wins.length ? wins[0].target() : finder.desktop();
    const url = $.NSURL.URLWithString(target.url());
    return url.isNil() ? null : url.path.js;
  } catch (e) {
    return null;
  }
}

// ---------- warp ----------

const WARP_DOCS = "https://docs.warp.dev/terminal/windows/tab-configs";

// The top-level `name:` of a launch configuration. Tolerant of malformed YAML: it never throws.
function yamlName(text) {
  if (text === null) return null;
  const m = text.match(/^name[ \t]*:[ \t]*(.*?)[ \t]*$/m);
  if (!m) return null;
  let v = m[1];
  if (/^"/.test(v)) {
    const q = v.match(/^"((?:[^"\\]|\\.)*)"/);
    if (!q) return v.slice(1) || null;
    try {
      return JSON.parse(`"${q[1].replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1").replace(/\\([^"\\/bfnrtu])/g, "$1")}"`) || null;
    } catch (e) {
      return q[1] || null;
    }
  }
  if (/^'/.test(v)) {
    const q = v.match(/^'((?:[^']|'')*)'/);
    return (q ? q[1].replace(/''/g, "'") : v.slice(1)) || null;
  }
  v = v.replace(/\s+#.*$/, "").trim();
  if (!v || /^[|>&*!{[]/.test(v)) return null;
  return v;
}

function tomlName(text) {
  if (text === null) return null;
  const m = text.match(/^name[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m);
  if (!m) return null;
  if (m[2] !== undefined) return m[2] || null;
  try {
    return JSON.parse(`"${m[1]}"`) || null;
  } catch (e) {
    return m[1] || null;
  }
}

function warpConfigs() {
  const base = HOME + (warpPreview() ? "/.warp-preview" : "/.warp");
  const scheme = warpPreview() ? "warppreview" : "warp";
  const out = [];
  const tabDir = `${base}/tab_configs`;
  for (const f of listDir(tabDir).sort()) {
    if (!/\.toml$/i.test(f) || f.startsWith(".")) continue;
    const path = `${tabDir}/${f}`;
    if (isDir(path)) continue;
    const stem = f.replace(/\.toml$/i, "");
    const name = tomlName(readText(path)) || stem;
    out.push({ kind: "tab", name, path, uri: `${scheme}://tab_config/${encodeURIComponent(stem)}` });
  }
  const lcDir = `${base}/launch_configurations`;
  for (const f of listDir(lcDir).sort()) {
    if (!/\.ya?ml$/i.test(f) || f.startsWith(".")) continue;
    const path = `${lcDir}/${f}`;
    if (isDir(path)) continue;
    const name = yamlName(readText(path));
    // Warp matches the `name:` field (warpdotdev/warp#15003); the path is the documented fallback.
    out.push({ kind: "launch", name: name || f.replace(/\.ya?ml$/i, ""), path, uri: `${scheme}://launch/${encodeURIComponent(name || path)}`, unnamed: !name });
  }
  return { base, configs: out };
}

function warpItems(query) {
  const q = query.trim();
  const items = [];
  const warpApp = appPath("warp");
  const wname = terminalName("warp");
  if (!warpApp) {
    items.push({
      title: `${wname} is not installed`,
      subtitle: "↩ Open warp.dev · Folders still open in your preferred terminal",
      arg: "https://www.warp.dev", variables: { tk_action: "url" }, icon: { path: "icons/error.png" },
      mods: { cmd: { arg: "https://www.warp.dev", subtitle: "Open warp.dev", variables: { tk_action: "url" } } },
    });
  }
  const { base, configs } = warpConfigs();
  const scored = [];
  for (const c of configs) {
    const s = score(c.name, q) || (q ? score(c.path.split("/").pop(), q) / 2 : 1);
    if (!s) continue;
    const kind = c.kind === "tab" ? "Tab Config" : "Launch Configuration";
    scored.push([s, {
      title: c.name,
      subtitle: `${kind} · ${tildify(c.path)}${c.unnamed ? " (no name: field)" : ""}`,
      arg: c.uri,
      valid: !!warpApp,
      uid: `warp:${c.path}`,
      autocomplete: c.name,
      variables: { tk_action: "url" },
      icon: { path: `icons/${c.kind === "tab" ? "tab" : "warp"}.png` },
      text: { copy: c.uri, largetype: c.name },
      mods: {
        cmd: { arg: c.path, valid: true, subtitle: "Reveal in Finder", variables: { tk_action: "reveal" } },
        alt: { arg: c.path, valid: true, subtitle: "Edit the file", variables: { tk_action: "edit" } },
        ...(c.kind === "tab" && warpApp ? { ctrl: { arg: `${c.uri}?new_window=true`, valid: true, subtitle: "Open in a new window", variables: { tk_action: "url" } } } : {}),
      },
    }]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title));
  items.push(...scored.map((x) => x[1]));

  const folder = finderFolder() || HOME;
  const pref = preferredTerminal();
  const actions = [];
  if (warpApp) {
    actions.push(["New Warp Tab Here", "tab", "warp-tab"], ["New Warp Window Here", "window", "warp-window"]);
  }
  if (pref !== "warp" || !warpApp) actions.push([`Open Here in ${terminalName(pref)}`, "terminal", "open-dir"]);
  for (const [title, icon, action] of actions) {
    if (!score(title, q) && q) continue;
    items.push({
      title,
      subtitle: `${tildify(folder)}  ·  the frontmost Finder folder`,
      arg: folder,
      variables: { tk_action: action },
      icon: { path: `icons/${icon}.png` },
      mods: { cmd: { arg: folder, subtitle: "Reveal the folder in Finder", variables: { tk_action: "reveal" } } },
    });
  }
  if (!configs.length && !q) {
    items.push(info("No Warp Tab Configs or Launch Configurations yet",
      `Save one in Warp, or add files to ${tildify(base)}/tab_configs · ↩ Open the docs`, "info",
      { valid: true, arg: WARP_DOCS, variables: { tk_action: "url" } }));
  }
  if (!items.length) items.push(info(`Nothing matches “${q}”`, "Search Tab Configs and Launch Configurations by name"));
  return items;
}

// ---------- history ----------

const SHELLS = ["zsh", "bash", "fish", "atuin"];

function histSources() {
  let zshFile = expandTilde(env("zsh_histfile", "").trim()) || `${HOME}/.zsh_history`;
  if (!zshFile.startsWith("/")) zshFile = `${HOME}/${zshFile}`; // like HISTFILE=.histfile in ~/.zshrc
  const list = [
    { kind: 0, path: zshFile },
    { kind: 1, path: `${HOME}/.bash_history` },
    { kind: 2, path: `${HOME}/.local/share/fish/fish_history` },
  ];
  if (env("hist_atuin", "1") !== "0") list.push({ kind: 3, path: `${HOME}/.local/share/atuin/history.db` });
  const out = [];
  for (const s of list) {
    const st = stat(s.path);
    if (!st || st.dir) continue;
    s.mtime = st.mtime;
    s.size = st.size;
    if (s.kind === 3) {
      const wal = stat(`${s.path}-wal`);
      if (wal) s.mtime = Math.max(s.mtime, wal.mtime) + wal.size / 1e12;
    }
    out.push(s);
  }
  return out;
}

// zsh "metafies" bytes 0x83–0x9f and NUL: they are stored as 0x83 followed by (byte ^ 0x20).
function unmetafy(raw) {
  return raw.indexOf("\x83") < 0 ? raw : raw.replace(/\x83([\s\S])/g, (m, c) => String.fromCharCode(c.charCodeAt(0) ^ 0x20));
}

// Returns [[command, time (0 if unknown)], …] oldest first.
function parseZsh(raw) {
  const lines = decodeUTF8(unmetafy(raw)).split("\n");
  const out = [];
  const HEADER = /^: *(\d+):\d*;/;
  let cur = null, t = 0, extended = false;
  for (let line of lines) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    // zsh itself would glue a new ": <time>:0;" entry onto a command that ends with a literal
    // backslash; in an extended-history file that header can only start a new entry.
    if (cur !== null && extended && HEADER.test(line)) {
      out.push([cur.slice(0, -1) + "\\", t]);
      cur = null;
    }
    if (cur === null) {
      const m = HEADER.exec(line);
      if (m) extended = true;
      t = m ? parseInt(m[1], 10) : 0;
      cur = m ? line.slice(m[0].length) : line;
    } else cur += line;
    // A trailing backslash means the command continues on the next line (zsh writes \n as \\\n).
    if (cur.endsWith("\\")) {
      cur = cur.slice(0, -1) + "\n";
      continue;
    }
    out.push([cur, t]);
    cur = null;
  }
  if (cur !== null) out.push([cur.replace(/\n$/, ""), t]);
  return out;
}

function parseBash(raw) {
  const lines = decodeUTF8(raw).split("\n");
  const out = [];
  const timed = lines.some((l) => /^#\d{9,11}$/.test(l));
  let t = 0, buf = null;
  for (let line of lines) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const m = /^#(\d{9,11})$/.exec(line);
    if (m) {
      if (buf !== null) out.push([buf.replace(/\n+$/, ""), t]);
      buf = null;
      t = parseInt(m[1], 10);
      continue;
    }
    if (!timed) {
      out.push([line, 0]);
      continue;
    }
    // With HISTTIMEFORMAT set, a multi-line command sits between two timestamps.
    buf = buf === null ? line : buf + "\n" + line;
  }
  if (buf !== null) out.push([buf.replace(/\n+$/, ""), t]);
  return out;
}

function parseFish(raw) {
  const out = [];
  let cur = null;
  for (const line of decodeUTF8(raw).split("\n")) {
    const m = /^- cmd: ?(.*)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = [m[1].replace(/\\(\\|n)/g, (x, c) => (c === "n" ? "\n" : "\\")), 0];
      continue;
    }
    const w = /^ {2}when: *(\d+)/.exec(line);
    if (w && cur) cur[1] = parseInt(w[1], 10);
  }
  if (cur) out.push(cur);
  return out;
}

const HIST_WARNINGS = [];

function parseAtuin(path) {
  const sqlite = env("TK_SQLITE", "/usr/bin/sqlite3");
  // The newest 50,000 commands keep a rebuild of the index fast on huge databases.
  const q = (where) => `SELECT timestamp, command FROM (SELECT timestamp, command FROM history ${where} ORDER BY timestamp DESC LIMIT 50000) ORDER BY timestamp ASC;`;
  let r = exec(sqlite, ["-readonly", "-json", path, q("WHERE deleted_at IS NULL")]);
  if (!r.ok) r = exec(sqlite, ["-readonly", "-json", path, q("")]);
  if (!r.ok) {
    HIST_WARNINGS.push(`atuin history couldn't be read: ${oneLine(r.err, 100)}`);
    return [];
  }
  try {
    const rows = r.out.trim() ? JSON.parse(r.out) : [];
    return rows.filter((x) => typeof x.command === "string").map((x) => [x.command, Math.floor(Number(x.timestamp) / 1e9) || 0]);
  } catch (e) {
    HIST_WARNINGS.push("atuin history couldn't be parsed");
    return [];
  }
}

// Newest first, deduplicated: [[command, time, shell], …]. Cached by the sources' mtime and size.
function histIndex() {
  const sources = histSources();
  const dedupe = env("hist_dedupe", "1") !== "0";
  const sig = JSON.stringify([2, dedupe, sources.map((s) => [s.kind, s.path, s.mtime, s.size])]);
  const dir = cacheDir();
  const sigPath = `${dir}/hist-index.sig`, dataPath = `${dir}/hist-index.json`;
  if (readText(sigPath) === sig) {
    const data = readText(dataPath);
    if (data !== null) {
      try {
        return { entries: JSON.parse(data), sources };
      } catch (e) {
        // rebuild below
      }
    }
  }
  const all = [];
  for (const s of sources) {
    let list;
    if (s.kind === 3) list = parseAtuin(s.path);
    else {
      const raw = readLatin1(s.path);
      if (raw === null) {
        HIST_WARNINGS.push(`Couldn't read ${tildify(s.path)}`);
        continue;
      }
      list = s.kind === 0 ? parseZsh(raw) : s.kind === 1 ? parseBash(raw) : parseFish(raw);
    }
    // Untimed entries sort by file position just before the file's modification time.
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const [cmd, t] = list[i];
      if (!cmd.trim()) continue;
      all.push([cmd, t, s.kind, t || s.mtime - (n - i) / 1e6, i]);
    }
  }
  all.sort((a, b) => b[3] - a[3] || (a[2] === b[2] ? b[4] - a[4] : a[2] - b[2]));
  const seen = new Set();
  const entries = [];
  for (const e of all) {
    const key = e[0].trim();
    if (dedupe) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    entries.push([e[0], e[1], e[2]]);
  }
  if (!HIST_WARNINGS.length) {
    writeFile(dataPath, JSON.stringify(entries));
    writeFile(sigPath, sig);
  }
  return { entries, sources };
}

function histSearch(entries, query, limit) {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const words = q.split(/\s+/);
  const tiers = [[], [], [], []];
  const flat = q.replace(/\s+/g, "");
  for (const e of entries) {
    const l = e[0].toLowerCase();
    if (l.startsWith(q)) {
      tiers[0].push(e);
      if (tiers[0].length >= limit) break;
      continue;
    }
    let all = true;
    for (const w of words) {
      if (!l.includes(w)) {
        all = false;
        break;
      }
    }
    if (all) {
      const i = l.indexOf(words[0]);
      (i === 0 || /[\s/|;&(=._-]/.test(l[i - 1]) ? tiers[1] : tiers[2]).push(e);
      continue;
    }
    if (tiers[0].length + tiers[1].length + tiers[2].length + tiers[3].length < limit) {
      let j = 0;
      for (let k = 0; k < l.length && j < flat.length; k++) if (l[k] === flat[j]) j++;
      if (j === flat.length) tiers[3].push(e);
    }
  }
  return [].concat(...tiers).slice(0, limit);
}

function histItems(query) {
  const { entries, sources } = histIndex();
  const term = terminalName(preferredTerminal());
  const items = [];
  for (const [cmd, t, kind] of histSearch(entries, query, 50)) {
    const shell = SHELLS[kind];
    const when = t ? ` · ${ago(t)}` : "";
    const arg = bigArg(cmd);
    items.push({
      title: oneLine(cmd),
      subtitle: `${shell}${when}  ·  ↩ Copy · ⌘↩ Paste · ⌥↩ Run in ${term}`,
      arg,
      variables: { tk_action: "copy" },
      icon: { path: `icons/${shell}.png` },
      text: textFor(cmd),
      mods: {
        cmd: { arg, subtitle: "Paste into the frontmost app", variables: { tk_action: "paste" } },
        alt: { arg, subtitle: `Run in a new ${term} ${opensTab(preferredTerminal()) ? "tab" : "window"}`, variables: { tk_action: "run" } },
      },
    });
  }
  for (const w of HIST_WARNINGS) items.push(info(w, "", "error"));
  if (!items.length) {
    if (!sources.length) {
      items.push(info("No shell history found", "Looked for ~/.zsh_history, ~/.bash_history, fish and atuin history", "error"));
    } else if (!entries.length) {
      items.push(info("Shell history is empty", sources.map((s) => tildify(s.path)).join(", ")));
    } else {
      items.push(info(`No command matches “${query.trim()}”`, `Searched ${plural(entries.length, "command")}`));
    }
  }
  return items;
}

// ---------- tldr ----------

const TLDR_URL = "https://github.com/tldr-pages/tldr/releases/latest/download/tldr-pages.{lang}.zip";
const PLATFORM_ORDER = ["osx", "common", "linux"];

function tldrLangs() {
  const lang = env("tldr_language", "en").trim().replace("-", "_");
  const ok = /^[a-z]{2,3}(_[A-Z]{2})?$/.test(lang) ? lang : "en";
  return ok === "en" ? ["en"] : [ok, "en"];
}

function tldrBase() {
  return mkdirs(`${cacheDir()}/tldr`);
}

function readNum(path) {
  const t = readText(path);
  const n = t === null ? NaN : parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function updateRunning(base) {
  const s = stat(`${base}/.lock`);
  return !!s && now() - s.mtime < 600;
}

// Download (or refresh) the pages archive in the background.
function startUpdate(base, langs, force) {
  const attempt = `${base}/.attempt-${langs.join("+")}`;
  if (!force && now() - readNum(attempt) < 3600) return; // at most one automatic try per hour
  const lock = `${base}/.lock`;
  if (updateRunning(base)) return;
  FM.removeItemAtPathError(lock, $()); // stale
  // Take the lock here, so the next run of the Script Filter already sees "downloading".
  if (!FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(lock, false, $(), $())) return;
  writeFile(attempt, String(Math.floor(now())));
  const args = ["-f", `${CWD}/tldr-update.sh`, base, ...langs];
  if (env("TK_SYNC_UPDATE", "") === "1") exec("/bin/zsh", args);
  else exec("/usr/bin/nohup", ["/bin/zsh", ...args], { wait: false });
}

function tldrIndex(base, lang) {
  const dir = `${base}/${lang}`;
  const stamp = readNum(`${base}/${lang}.stamp`);
  if (!isDir(`${dir}/common`)) return null;
  const idxPath = `${base}/${lang}.index.json`;
  const cached = readText(idxPath);
  if (cached !== null) {
    try {
      const j = JSON.parse(cached);
      if (j.stamp === stamp) return j;
    } catch (e) {
      // rebuild
    }
  }
  const platforms = {};
  for (const p of listDir(dir)) {
    if (p.startsWith(".") || !isDir(`${dir}/${p}`)) continue;
    platforms[p] = listDir(`${dir}/${p}`).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  }
  const j = { stamp, platforms };
  writeFile(idxPath, JSON.stringify(j));
  return j;
}

function platformOrder(indexes) {
  const all = new Set();
  for (const ix of indexes) Object.keys(ix.platforms).forEach((p) => all.add(p));
  return PLATFORM_ORDER.filter((p) => all.has(p)).concat([...all].filter((p) => !PLATFORM_ORDER.includes(p)).sort());
}

// Platform takes precedence over language (tldr client spec).
function findPage(name, langs, idx, order) {
  for (const p of order) {
    for (const l of langs) {
      const ix = idx[l];
      if (ix && ix.platforms[p] && ix.platforms[p].includes(name)) return { platform: p, lang: l };
    }
  }
  return null;
}

// "{{[-f|--force]}}" -> --force (or -f); "{{path/to/file}}" -> path/to/file; "\{\{" -> "{{".
function renderPlaceholders(cmd, style) {
  let out = "", i = 0;
  const n = cmd.length;
  while (i < n) {
    if (cmd.startsWith("\\{\\{", i)) {
      out += "{{";
      i += 4;
      continue;
    }
    if (cmd.startsWith("\\}\\}", i)) {
      out += "}}";
      i += 4;
      continue;
    }
    if (cmd.startsWith("{{", i)) {
      let j = i + 2, depth = 0, inner = "";
      // The outer braces mark the placeholder: "{{stash@{0}}}" -> "stash@{0}".
      while (j < n) {
        const c = cmd[j];
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth > 0) depth--;
          else if (cmd[j + 1] === "}") break;
        }
        inner += c;
        j++;
      }
      if (j >= n) {
        out += cmd.slice(i);
        break;
      }
      const opt = /^\[(-[^|\]]*)\|(--[^|\]]*)\]$/.exec(inner);
      out += opt ? (style === "short" ? opt[1] : opt[2]) : inner;
      i = j + 2;
      continue;
    }
    out += cmd[i++];
  }
  return out;
}

function parsePage(md) {
  const page = { title: "", desc: [], url: "", examples: [] };
  let pending = null;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m;
    if ((m = /^#\s+(.*)$/.exec(line)) && !page.title) page.title = m[1].trim();
    else if ((m = /^>\s?(.*)$/.exec(line))) {
      // "> More information: <https://…>." (any language): the link, not the description.
      const u = /<(https?:\/\/[^>\s]+)>\.?\s*$/.exec(m[1]);
      if (u) page.url = u[1];
      else page.desc.push(m[1].trim().replace(/`([^`]*)`/g, "$1"));
    } else if ((m = /^-\s+(.*)$/.exec(line))) pending = m[1].trim().replace(/:$/, "");
    else if ((m = /^`(.*)`\s*$/.exec(line)) && pending !== null) {
      page.examples.push({ desc: pending.replace(/`([^`]*)`/g, "$1"), cmd: m[1] });
      pending = null;
    }
  }
  return page;
}

function tldrItems(query) {
  const langs = tldrLangs();
  const base = tldrBase();
  const cheat = env("tldr_cheatsh", "1") !== "0";
  const q = query.replace(/\s+/g, " ").trim();
  const cm = /^(.*?)\s*@cheat$/i.exec(q);
  if (cm && cheat) return cheatItems(cm[1]);

  const haveEn = isDir(`${base}/en/common`);
  const stampEn = readNum(`${base}/en.stamp`);
  const errPath = `${base}/en.error`;
  if (!haveEn || langs.some((l) => !readNum(`${base}/${l}.stamp`) && !exists(`${base}/${l}.error`))) {
    startUpdate(base, langs, false);
  } else if (now() - stampEn > WEEK) startUpdate(base, langs, false);
  if (!isDir(`${base}/en/common`)) {
    if (updateRunning(base)) {
      return { items: [info("Downloading tldr pages…", "About 3 MB, only the first time. Results appear when it’s done.", "download")], rerun: 0.5 };
    }
    const err = exists(errPath) ? oneLine(readText(errPath) || "", 150) : "";
    const items = [info("Couldn't download the tldr pages", err || "Check your internet connection", "error"),
      { title: "Try again", subtitle: "Download the tldr pages archive from GitHub", arg: "retry", variables: { tk_action: "tldr-update" }, icon: { path: "icons/download.png" } }];
    if (cheat && q) items.push(cheatRow(q));
    return { items };
  }

  const idx = {};
  for (const l of langs) {
    const ix = tldrIndex(base, l);
    if (ix) idx[l] = ix;
  }
  const order = platformOrder(Object.values(idx));
  const style = env("tldr_options", "long");

  if (!q) {
    const count = new Set([].concat(...Object.values(idx.en.platforms))).size;
    const langNote = langs[0] === "en" ? "" : idx[langs[0]] ? ` · ${langs[0]} with English fallback`
      : updateRunning(base) ? ` · downloading ${langs[0]}…` : ` · ${langs[0]} isn't available, using English`;
    return { items: [
      info("Type a command name", `${plural(count, "page")} offline · updated ${ago(stampEn)}${langNote}`, "tldr"),
      { title: "Update tldr pages now", subtitle: updateRunning(base) ? "Updating…" : "Pages refresh weekly in the background", arg: "update", variables: { tk_action: "tldr-update" }, icon: { path: "icons/download.png" } },
    ] };
  }

  // Longest run of leading words that names a page: "git commit amend" -> git-commit, filter "amend".
  const words = q.toLowerCase().split(" ");
  let found = null, name = "", rest = [];
  for (let k = words.length; k >= 1 && !found; k--) {
    name = words.slice(0, k).join("-");
    found = findPage(name, langs, idx, order);
    rest = words.slice(k);
  }
  if (found) {
    const md = readText(`${base}/${found.lang}/${found.platform}/${name}.md`) || "";
    const page = parsePage(md);
    const items = [];
    const where = ["osx", "common"].includes(found.platform) ? "" : ` · ${found.platform} page`;
    const filter = rest.join(" ");
    if (!filter) {
      items.push({
        title: page.title || name,
        subtitle: (page.desc.join(" ") || "tldr page") + where,
        arg: page.url || "",
        valid: !!page.url,
        quicklookurl: page.url || undefined,
        variables: { tk_action: "url" },
        icon: { path: "icons/tldr.png" },
        mods: { cmd: { arg: page.url || "", valid: !!page.url, subtitle: page.url ? `Open ${page.url}` : "No documentation link", variables: { tk_action: "url" } } },
        text: { copy: page.desc.join("\n"), largetype: page.desc.join("\n") },
      });
    }
    for (const ex of page.examples) {
      const plain = renderPlaceholders(ex.cmd, style);
      if (filter && !score(`${ex.desc} ${plain}`, filter)) continue;
      items.push({
        title: plain,
        subtitle: ex.desc + where,
        arg: plain,
        variables: { tk_action: "copy" },
        icon: { path: "icons/example.png" },
        text: { copy: plain, largetype: plain },
        mods: {
          cmd: { arg: plain, subtitle: "Paste into the frontmost app", variables: { tk_action: "paste" } },
          alt: { arg: ex.cmd, subtitle: "Copy with the {{placeholders}}", variables: { tk_action: "copy" } },
        },
      });
    }
    if (filter && items.length === 0) items.push(info(`No ${name} example matches “${filter}”`, `${page.examples.length} examples on the page`));
    if (!filter) {
      const subs = new Set();
      for (const p of order) for (const l of Object.keys(idx)) for (const n of idx[l].platforms[p] || []) if (n.startsWith(name + "-")) subs.add(n);
      [...subs].sort().slice(0, 8).forEach((n) => items.push(info(n.replace(/-/g, " "), "Related page · ↩ Show", "tldr", { autocomplete: n.replace(/-/g, " ") })));
    }
    if (cheat) items.push(cheatRow(name.replace(/-/g, " ")));
    return { items };
  }

  // No page: search names by prefix, then substring.
  const needle = q.toLowerCase().replace(/ /g, "-");
  const names = new Map();
  for (const p of order) for (const l of Object.keys(idx)) for (const n of idx[l].platforms[p] || []) if (!names.has(n)) names.set(n, p);
  const pre = [], sub = [];
  for (const [n, p] of names) {
    if (n.startsWith(needle)) pre.push([n, p]);
    else if (n.includes(needle)) sub.push([n, p]);
  }
  pre.sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]));
  sub.sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0]));
  const items = pre.concat(sub).slice(0, 30).map(([n, p]) =>
    info(n.replace(/-/g, " "), `tldr page${["osx", "common"].includes(p) ? "" : ` · ${p}`} · ↩ Show`, "tldr", { autocomplete: n.replace(/-/g, " ") }));
  if (!items.length) items.push(info(`No tldr page for “${q}”`, cheat ? "Try cheat.sh below" : "Check the spelling, or enable cheat.sh in the Workflow’s Configuration"));
  if (cheat) items.push(cheatRow(q));
  return { items };
}

function cheatRow(topic) {
  return info(`Look up “${topic}” on cheat.sh`, "Online cheat sheets · ↩ Show", "cheat", { autocomplete: `${topic} @cheat` });
}

// ---------- cheat.sh ----------

function cheatURL(topic) {
  const words = topic.trim().split(/\s+/).map(encodeURIComponent);
  const path = words[0] + (words.length > 1 ? "/" + words.slice(1).join("+") : "");
  return { page: `https://cheat.sh/${path}`, api: `${env("TK_CHEAT_URL", "https://cheat.sh")}/${path}?T` };
}

// FNV-1a, for short unique file names.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function hexOf(s) {
  return unescape(encodeURIComponent(s)).split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function cheatItems(topic) {
  topic = topic.trim();
  if (!topic) return { items: [info("Type a command, then @cheat", "Example: tar @cheat", "cheat")] };
  if (topic.length > 100) return { items: [info("That's too long for cheat.sh", "", "error")] };
  const { page, api } = cheatURL(topic);
  const dir = mkdirs(`${cacheDir()}/cheat`);
  const file = `${dir}/${hexOf(topic.toLowerCase()).slice(0, 120)}-${hash(topic.toLowerCase())}.txt`;
  const st = stat(file);
  let text = st && now() - st.mtime < 86400 ? readText(file) : null;
  if (text === null) {
    const r = exec("/usr/bin/curl", ["-fsSL", "--max-time", "10", "-A", "curl/8 (Alfred Terminal Kit)", "--", api]);
    if (!r.ok) {
      const stale = st ? readText(file) : null;
      if (stale === null) {
        return { items: [info("Couldn't reach cheat.sh", r.err || `curl exited with ${r.status}`, "error"),
          { title: `Open ${page}`, subtitle: "In your browser", arg: page, variables: { tk_action: "url" }, icon: { path: "icons/cheat.png" } }] };
      }
      text = stale;
    } else {
      text = r.out.replace(/\x1b\[[0-9;]*m/g, "");
      writeFile(file, text);
    }
  }
  const items = [{ title: `cheat.sh/${topic}`, subtitle: "↩ Open in the browser", arg: page, variables: { tk_action: "url" }, icon: { path: "icons/cheat.png" } }];
  if (/^Unknown topic\./m.test(text) || !text.trim()) {
    items.push(info(`cheat.sh has no sheet for “${topic}”`, ""));
    return { items };
  }
  let comment = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      comment = t.replace(/^#+\s*/, "");
      continue;
    }
    items.push({
      title: oneLine(t),
      subtitle: comment || "cheat.sh",
      arg: t,
      variables: { tk_action: "copy" },
      icon: { path: "icons/example.png" },
      text: { copy: t, largetype: t },
      mods: { cmd: { arg: t, subtitle: "Paste into the frontmost app", variables: { tk_action: "paste" } } },
    });
    comment = "";
    if (items.length > 80) break;
  }
  return { items };
}

// ---------- ssh ----------

function globToRegex(g) {
  let r = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") r += "[^/]*";
    else if (c === "?") r += "[^/]";
    else if (c === "[") {
      const j = g.indexOf("]", i + 1);
      if (j < 0) r += "\\[";
      else {
        r += "[" + g.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = j;
      }
    } else r += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${r}$`);
}

// Expand a glob with *, ? and [..] in any path component (no shell involved).
function globPaths(pattern) {
  if (!/[*?[]/.test(pattern)) return exists(pattern) ? [pattern] : [];
  const parts = pattern.split("/");
  let bases = [parts[0] === "" ? "" : "."];
  for (let k = parts[0] === "" ? 1 : 0; k < parts.length; k++) {
    const part = parts[k];
    if (!part) continue;
    const next = [];
    for (const b of bases) {
      const dir = b === "" ? "/" : b;
      if (/[*?[]/.test(part)) {
        const re = globToRegex(part);
        for (const f of listDir(dir).sort()) {
          if (f.startsWith(".") && !part.startsWith(".")) continue;
          if (re.test(f)) next.push(`${b}/${f}`);
        }
      } else if (exists(`${b}/${part}`)) next.push(`${b}/${part}`);
    }
    bases = next;
    if (!bases.length) break;
  }
  return bases;
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const HOST_OK = /^[A-Za-z0-9_.@%:+~\[\]-]+$/;

function parseSshConfig(path, depth, seen, hosts, notes) {
  if (depth > 16 || seen.has(path)) return;
  seen.add(path);
  const text = readText(path);
  if (text === null) return;
  let current = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const args = splitArgs(m[2].replace(/\s+#.*$/, ""));
    if (key === "host") {
      current = [];
      for (const a of args) {
        if (/[*?!]/.test(a) || a.startsWith("-") || !HOST_OK.test(a)) continue;
        if (!hosts.has(a)) hosts.set(a, { alias: a, file: path, line: n + 1 });
        current.push(a);
      }
    } else if (key === "match") {
      current = [];
    } else if (key === "include") {
      for (const a of args) {
        let p = expandTilde(a);
        if (!p.startsWith("/")) p = `${HOME}/.ssh/${p}`;
        for (const f of globPaths(p)) if (!isDir(f)) parseSshConfig(f, depth + 1, seen, hosts, notes);
      }
    } else if (["hostname", "user", "port", "proxyjump"].includes(key) && args.length) {
      for (const a of current) {
        const h = hosts.get(a);
        if (h && h[key] === undefined) h[key] = args[0];
      }
    }
  }
}

function sshHosts() {
  const hosts = new Map();
  const cfg = `${HOME}/.ssh/config`;
  parseSshConfig(cfg, 0, new Set(), hosts, []);
  const list = [...hosts.values()].map((h) => Object.assign(h, { source: "config" }));
  if (env("ssh_known_hosts", "1") !== "0") {
    const known = new Set(list.map((h) => `${(h.hostname || h.alias).toLowerCase()}:${h.port || "22"}`));
    const kh = `${HOME}/.ssh/known_hosts`;
    const text = readText(kh);
    if (text !== null) {
      const lines = text.split("\n");
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n].trim();
        if (!line || line.startsWith("#")) continue;
        let fields = line.split(/\s+/);
        if (fields[0].startsWith("@")) continue; // @cert-authority / @revoked
        if (fields[0].startsWith("|")) continue; // hashed
        for (const h of fields[0].split(",")) {
          if (!h || h.startsWith("!") || /[*?]/.test(h)) continue;
          const pm = /^\[([^\]]+)\]:(\d+)$/.exec(h);
          const host = pm ? pm[1] : h;
          const port = pm ? pm[2] : "22";
          if (host.startsWith("-") || !HOST_OK.test(host)) continue;
          const key = `${host.toLowerCase()}:${port}`;
          if (known.has(key) || hosts.has(host) && port === "22") continue;
          known.add(key);
          list.push({ alias: host, port: port === "22" ? undefined : port, file: kh, line: n + 1, source: "known" });
        }
      }
    }
  }
  return { list, cfg };
}

function sshCommand(h) {
  return h.source === "known" && h.port ? `ssh -p ${shq(h.port)} ${shq(h.alias)}` : `ssh ${shq(h.alias)}`;
}

function sshItems(query) {
  const q = query.trim();
  const { list, cfg } = sshHosts();
  const term = terminalName(preferredTerminal());
  const scored = [];
  for (const h of list) {
    const s = Math.max(score(h.alias, q), score([h.user, h.hostname].filter(Boolean).join("@"), q) * 0.8);
    if (!s) continue;
    const target = h.source === "known" ? (h.port ? `port ${h.port}` : "") : `${h.user ? h.user + "@" : ""}${h.hostname || h.alias}${h.port ? ":" + h.port : ""}`;
    const bits = [target, h.proxyjump ? `via ${h.proxyjump}` : "", h.source === "known" ? "known_hosts" : tildify(h.file)].filter(Boolean);
    const cmd = sshCommand(h);
    scored.push([s, {
      title: h.alias,
      subtitle: bits.join(" · "),
      arg: cmd,
      uid: `ssh:${h.alias}:${h.port || ""}`,
      autocomplete: h.alias,
      variables: { tk_action: "ssh" },
      icon: { path: `icons/${h.source === "known" ? "known" : "ssh"}.png` },
      text: { copy: cmd, largetype: cmd },
      mods: {
        cmd: { arg: cmd, subtitle: `Copy “${cmd}”`, variables: { tk_action: "copy" } },
        alt: { arg: h.file, subtitle: `Open ${tildify(h.file)}`, variables: { tk_action: "edit" } },
      },
    }, h.source === "known" ? 1 : 0]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[2] - b[2] || a[1].title.localeCompare(b[1].title));
  const items = scored.slice(0, 200).map((x) => x[1]);
  // Connect to whatever was typed: user@host or host:port.
  const typed = /^(?:([A-Za-z0-9_.-]+)@)?([A-Za-z0-9_.%-]+|\[[0-9a-fA-F:.%]+\])(?::(\d{1,5}))?$/.exec(q);
  if (q && typed && !q.startsWith("-") && !list.some((h) => h.alias === q)) {
    const host = typed[2].replace(/^\[|\]$/g, "");
    const cmd = `ssh ${typed[3] ? `-p ${typed[3]} ` : ""}${shq((typed[1] ? typed[1] + "@" : "") + host)}`;
    items.push({
      title: `Connect to ${q}`, subtitle: `${cmd}  ·  in ${term}`, arg: cmd, variables: { tk_action: "ssh" }, icon: { path: "icons/terminal.png" },
      mods: { cmd: { arg: cmd, subtitle: `Copy “${cmd}”`, variables: { tk_action: "copy" } } },
    });
  }
  if (!items.length) {
    if (!list.length) items.push(info("No SSH hosts found", `Add Host entries to ${tildify(cfg)}`, "info", exists(cfg) ? { valid: true, arg: cfg, variables: { tk_action: "edit" } } : {}));
    else items.push(info(`No host matches “${q}”`, `${plural(list.length, "host")} in ~/.ssh`));
  }
  return items;
}

// ---------- actions ----------

function openDirs(arg) {
  const dirs = [];
  for (const p of String(arg).split("\t").map((s) => s.trim()).filter(Boolean)) {
    const d = isDir(p) ? p : p.replace(/\/[^/]*$/, "") || "/";
    if (isDir(d) && !dirs.includes(d)) dirs.push(d);
  }
  if (!dirs.length) return "Nothing to open: choose a folder";
  for (const d of dirs.slice(0, 10)) {
    const msg = launch("", d);
    if (msg) return msg;
  }
  return undefined;
}

function openFile(path, how) {
  if (!exists(path)) return `${tildify(path)} doesn't exist`;
  const argv = how === "reveal" ? ["-R", path] : ["-t", path];
  if (DRY) {
    console.log(JSON.stringify({ open: argv }));
    return undefined;
  }
  const r = exec("/usr/bin/open", argv);
  return r.ok ? undefined : `Couldn't open ${tildify(path)}`;
}

function act(arg) {
  const action = env("tk_action", "");
  arg = resolveArg(arg);
  switch (action) {
    case "run":
    case "ssh":
      return arg.trim() ? launch(arg, HOME) : "Nothing to run";
    case "open-dir":
      return openDirs(arg);
    case "warp-tab":
    case "warp-window": {
      const scheme = warpPreview() ? "warppreview" : "warp";
      const url = `${scheme}://action/new_${action === "warp-tab" ? "tab" : "window"}?path=${urlEncodePath(arg || HOME)}`;
      if (DRY) {
        console.log(JSON.stringify({ url }));
        return undefined;
      }
      return openURL(url) ? undefined : "Couldn't open Warp";
    }
    case "url":
      if (!/^(https?|warp|warppreview):\/\//i.test(arg)) return "Couldn't open the link";
      if (DRY) {
        console.log(JSON.stringify({ url: arg }));
        return undefined;
      }
      return openURL(arg) ? undefined : "Couldn't open the link";
    case "edit":
    case "reveal":
      return openFile(arg, action);
    case "tldr-update": {
      const base = tldrBase();
      startUpdate(base, tldrLangs(), true);
      return "Updating tldr pages in the background";
    }
    default:
      return `Unknown action: ${action}`;
  }
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  try {
    switch (cmd) {
      case "warp": return output(warpItems(query));
      case "hist": return output(histItems(query));
      case "ssh": return JSON.stringify({ items: sshItems(query) });
      case "tldr": {
        const r = tldrItems(query);
        return output(r.items, r.rerun ? { rerun: r.rerun } : {});
      }
      case "act": return act(query);
      case "open-dirs": return openDirs(query);
      default: return output([info(`Unknown command: ${cmd}`, "", "error")]);
    }
  } catch (e) {
    if (cmd === "act" || cmd === "open-dirs") return `Terminal Kit error: ${e && e.message ? e.message : e}`;
    return output([info("Terminal Kit error", String(e && e.message ? e.message : e), "error")]);
  }
}
