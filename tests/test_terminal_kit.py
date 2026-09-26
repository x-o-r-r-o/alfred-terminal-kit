#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters and actions the way Alfred does and validate the output.

Nothing here opens a terminal or types anything: actions run with TK_DRY_RUN=1, which prints the
steps the launcher would take. HOME-like paths point at temporary fixtures via TK_HOME.
"""
import json, os, plistlib, shutil, sqlite3, stat, subprocess, sys, tempfile, time, unittest, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
TMP = tempfile.mkdtemp(prefix="terminal-kit-test-")
NO_APPS = json.dumps({"terminal": "/System/Applications/Utilities/Terminal.app"})


def new_home():
    return tempfile.mkdtemp(dir=TMP, prefix="home-")


def new_cache():
    return tempfile.mkdtemp(dir=TMP, prefix="cache-")


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb" if isinstance(data, bytes) else "w", encoding=None if isinstance(data, bytes) else "utf-8") as f:
        f.write(data)
    return path


def run(cmd, query="", home=None, cache=None, **env):
    e = {k: v for k, v in os.environ.items() if not k.startswith(("TK_", "alfred_", "tk_"))}
    e.update(TK_HOME=home or new_home(), alfred_workflow_cache=cache or new_cache(), TK_FINDER_DIR="", TK_APPS=NO_APPS)
    e.update(env)
    out = subprocess.run(["osascript", "-l", "JavaScript", "./tk.js", cmd, query], cwd=SRC, env=e,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return out


def sf(cmd, query="", **kw):
    out = run(cmd, query, **kw)
    data = json.loads(out.stdout)
    validate(data)
    return data


def items(cmd, query="", **kw):
    return sf(cmd, query, **kw)["items"]


def act(action, arg, **kw):
    """Run an action in dry-run mode; returns (steps printed on stderr as JSON, notification text)."""
    out = run("act", arg, tk_action=action, TK_DRY_RUN="1", **kw)
    logs = [json.loads(l) for l in out.stderr.splitlines() if l.startswith("{")]
    return (logs[0] if logs else None), out.stdout.strip()


def validate(data):
    assert isinstance(data.get("items"), list)
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True) is not False:
            assert "arg" in it, it
            assert it.get("variables", {}).get("tk_action"), it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m
            if m.get("valid", True) is not False:
                assert m.get("variables", {}).get("tk_action"), m


def find(its, prefix):
    for i in its:
        if i["title"].startswith(prefix):
            return i
    raise AssertionError(f"no item starting with {prefix!r}: {[i['title'] for i in its]}")


def titles(its):
    return [i["title"] for i in its]


# ---------------------------------------------------------------- warp

class WarpTests(unittest.TestCase):
    def setUp(self):
        self.home = new_home()
        lc = os.path.join(self.home, ".warp", "launch_configurations")
        write(f"{lc}/dev.yaml", "---\nname: Dev Tabs\nwindows:\n  - tabs:\n      - layout:\n          cwd: /tmp\n")
        write(f"{lc}/quoted.yml", 'name: "Ünïcode \\"quoted\\" & more" # comment\nwindows: []\n')
        write(f"{lc}/noname.yaml", "windows:\n  - tabs: []\n")
        write(f"{lc}/broken.yaml", "name: [unclosed\n\t- : :\n\x00\xff garbage")
        write(f"{lc}/binary.yaml", b"\xff\xfe\x00name: \x80\x81 bad\n")
        write(f"{lc}/notes.txt", "name: not a config")
        write(os.path.join(self.home, ".warp", "tab_configs", "api server.toml"), 'name = "API Server"\n[[panes]]\ncwd = "~"\n')
        self.apps = json.dumps({"warp": "/Applications/Warp.app", "terminal": "/System/Applications/Utilities/Terminal.app"})

    def test_lists_configs_with_uris(self):
        its = items("warp", home=self.home, TK_APPS=self.apps)
        dev = find(its, "Dev Tabs")
        self.assertEqual(dev["arg"], "warp://launch/Dev%20Tabs")
        self.assertEqual(dev["variables"]["tk_action"], "url")
        self.assertIn("Launch Configuration", dev["subtitle"])
        q = find(its, "Ünïcode")
        self.assertEqual(q["title"], 'Ünïcode "quoted" & more')
        tab = find(its, "API Server")
        self.assertEqual(tab["arg"], "warp://tab_config/api%20server")
        self.assertEqual(tab["mods"]["ctrl"]["arg"], "warp://tab_config/api%20server?new_window=true")
        self.assertEqual(tab["mods"]["alt"]["variables"]["tk_action"], "edit")
        self.assertNotIn("notes", " ".join(titles(its)))

    def test_missing_name_falls_back_to_path(self):
        its = items("warp", "noname", home=self.home, TK_APPS=self.apps)
        it = find(its, "noname")
        self.assertIn("no name: field", it["subtitle"])
        self.assertTrue(it["arg"].startswith("warp://launch/%2F"), it["arg"])

    def test_malformed_yaml_does_not_break_listing(self):
        its = items("warp", home=self.home, TK_APPS=self.apps)
        names = titles(its)
        self.assertIn("broken", names)  # unusable name: falls back to the file name
        self.assertTrue(any(n.startswith("binary") or "bad" in n for n in names), names)
        self.assertIn("Dev Tabs", names)

    def test_filter_and_here_actions(self):
        folder = os.path.join(self.home, "My Folder ü")
        os.makedirs(folder)
        its = items("warp", "dev", home=self.home, TK_APPS=self.apps, TK_FINDER_DIR=folder)
        self.assertEqual(its[0]["title"], "Dev Tabs")
        its = items("warp", "", home=self.home, TK_APPS=self.apps, TK_FINDER_DIR=folder)
        here = find(its, "New Warp Tab Here")
        self.assertEqual(here["arg"], folder)
        self.assertEqual(here["variables"]["tk_action"], "warp-tab")
        self.assertIn("New Warp Window Here", titles(its))
        # Preferred terminal is Warp, so no separate "Open Here" row
        self.assertFalse(any(t.startswith("Open Here") for t in titles(its)))
        steps, _ = act("warp-tab", folder, TK_APPS=self.apps)
        self.assertEqual(steps["url"], "warp://action/new_tab?path=" + __import__("urllib.parse").parse.quote(folder, safe=""))

    def test_not_installed(self):
        its = items("warp", home=self.home, TK_APPS=json.dumps({"iterm": "/Applications/iTerm.app"}))
        self.assertEqual(its[0]["title"], "Warp is not installed")
        self.assertEqual(its[0]["arg"], "https://www.warp.dev")
        self.assertFalse(find(its, "Dev Tabs")["valid"])
        self.assertIn("Open Here in iTerm2", titles(its))
        self.assertNotIn("New Warp Tab Here", titles(its))

    def test_no_configs(self):
        its = items("warp", home=new_home(), TK_APPS=self.apps)
        row = find(its, "No Warp Tab Configs")
        self.assertTrue(row["arg"].startswith("https://docs.warp.dev"))
        self.assertEqual(find(items("warp", "zzzz", home=new_home(), TK_APPS=self.apps), "Nothing matches")["valid"], False)

    def test_preview_release(self):
        home = new_home()
        write(os.path.join(home, ".warp-preview", "launch_configurations", "p.yaml"), "name: Preview One\n")
        apps = json.dumps({"warp": "/Applications/Warp Preview.app"})
        its = items("warp", home=home, TK_APPS=apps, warp_release="preview")
        self.assertEqual(find(its, "Preview One")["arg"], "warppreview://launch/Preview%20One")
        self.assertIn("New Warp Tab Here", titles(its))

    def test_unicode_quotes_query(self):
        for q in ['"', "'; do shell script \"x\"", "ü\nnew", "\\"]:
            items("warp", q, home=self.home, TK_APPS=self.apps)


# ---------------------------------------------------------------- history

def meta(b):
    """zsh metafication: bytes 0x83..0x9f and NUL become 0x83, byte ^ 0x20."""
    out = bytearray()
    for c in b:
        if c == 0 or 0x83 <= c <= 0x9F:
            out += bytes([0x83, c ^ 0x20])
        else:
            out.append(c)
    return bytes(out)


class HistoryTests(unittest.TestCase):
    def home_with(self, zsh=None, bash=None, fish=None):
        home = new_home()
        if zsh is not None:
            write(os.path.join(home, ".zsh_history"), zsh)
        if bash is not None:
            write(os.path.join(home, ".bash_history"), bash)
        if fish is not None:
            write(os.path.join(home, ".local/share/fish/fish_history"), fish)
        return home

    def test_zsh_extended_multiline_and_metafied(self):
        now = int(time.time())
        data = (f": {now - 7200}:0;echo old\n"
                f": {now - 3600}:0;for f in *; do\\\n  echo $f\\\ndone\n"
                f": {now - 60}:0;echo 日本語 ✓ ü\n"
                f": {now - 30}:0;echo \"quoted\" 'single' $HOME\n").encode()
        home = self.home_with(zsh=meta(data))
        its = items("hist", home=home)
        self.assertEqual(its[0]["arg"], "echo \"quoted\" 'single' $HOME")
        self.assertEqual(its[1]["arg"], "echo 日本語 ✓ ü")
        self.assertEqual(its[2]["arg"], "for f in *; do\n  echo $f\ndone")
        self.assertIn("⏎", its[2]["title"])
        self.assertIn("1 min ago", its[1]["subtitle"])
        self.assertEqual(its[3]["arg"], "echo old")
        self.assertEqual(its[1]["mods"]["cmd"]["variables"]["tk_action"], "paste")
        self.assertEqual(its[1]["mods"]["alt"]["variables"]["tk_action"], "run")
        self.assertEqual(its[1]["variables"]["tk_action"], "copy")

    def test_metafied_nul_and_trailing_escaped_backslash(self):
        # 0x83 itself and bytes like 0x9f (in "ğ" = c4 9f) are metafied
        data = meta(": 1700000000:0;printf 'ğ'\n: 1700000001:0;echo a\\\\\n: 1700000002:0;ls\n".encode())
        self.assertIn(b"\x83", data)
        its = items("hist", home=self.home_with(zsh=data))
        cmds = [i["arg"] for i in its]
        self.assertIn("printf 'ğ'", cmds)
        # A literal trailing backslash is not glued to the next extended-history entry
        self.assertIn("echo a" + "\\" * 2, cmds)
        self.assertEqual(cmds[0], "ls")

    def test_plain_zsh_and_invalid_utf8(self):
        data = b"ls -la\ngit status\n\xff\xfe broken bytes\r\necho last\n"
        its = items("hist", home=self.home_with(zsh=data))
        self.assertEqual(its[0]["arg"], "echo last")
        self.assertEqual(its[1]["arg"], "\xff\xfe broken bytes")
        self.assertNotIn(" · ", its[0]["subtitle"].split("  ·  ")[0])  # no time for plain history

    def test_bash_with_timestamps_and_multiline(self):
        now = int(time.time())
        bash = f"#{now - 100}\nmake build\n#{now - 50}\ncat <<EOF\nhello\nEOF\n"
        its = items("hist", home=self.home_with(bash=bash))
        self.assertEqual(its[0]["arg"], "cat <<EOF\nhello\nEOF")
        self.assertIn("bash", its[0]["subtitle"])
        self.assertEqual(its[1]["arg"], "make build")

    def test_bash_plain(self):
        its = items("hist", home=self.home_with(bash="one\ntwo\n\nthree\n"))
        self.assertEqual([i["arg"] for i in its], ["three", "two", "one"])

    def test_fish(self):
        fish = ("- cmd: echo first\n  when: 1700000000\n"
                "- cmd: printf 'a\\\\nb'\\nsecond line\n  when: 1700000100\n  paths:\n    - foo\n"
                "- cmd: echo ü\n  when: 1700000200\n")
        its = items("hist", home=self.home_with(fish=fish))
        self.assertEqual([i["arg"] for i in its], ["echo ü", "printf 'a\\nb'\nsecond line", "echo first"])
        self.assertIn("fish", its[0]["subtitle"])

    def test_merge_dedupe_and_order_across_shells(self):
        zsh = b": 1700000300:0;git push\n: 1700000100:0;ls\n"
        fish = "- cmd: git push\n  when: 1700000000\n- cmd: npm test\n  when: 1700000200\n"
        home = self.home_with(zsh=zsh, fish=fish)
        its = items("hist", home=home)
        self.assertEqual([i["arg"] for i in its], ["git push", "npm test", "ls"])
        its = items("hist", home=home, hist_dedupe="0")
        self.assertEqual([i["arg"] for i in its], ["git push", "npm test", "ls", "git push"])

    def test_atuin(self):
        home = new_home()
        db = os.path.join(home, ".local/share/atuin/history.db")
        os.makedirs(os.path.dirname(db))
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE history (id TEXT, timestamp INTEGER, duration INTEGER, exit INTEGER, command TEXT, cwd TEXT, session TEXT, hostname TEXT, deleted_at INTEGER)")
        con.executemany("INSERT INTO history VALUES (?,?,?,?,?,?,?,?,?)", [
            ("1", 1700000000 * 10**9, 0, 0, "atuin one", "/", "s", "h", None),
            ("2", 1700000500 * 10**9, 0, 0, "echo \"multi\"\nline", "/", "s", "h", None),
            ("3", 1700000900 * 10**9, 0, 0, "deleted cmd", "/", "s", "h", 1700000950 * 10**9),
        ])
        con.commit()
        con.close()
        its = items("hist", home=home)
        self.assertEqual([i["arg"] for i in its], ["echo \"multi\"\nline", "atuin one"])
        self.assertIn("atuin", its[0]["subtitle"])
        self.assertEqual(items("hist", home=home, hist_atuin="0")[0]["title"], "No shell history found")

    def test_atuin_old_schema_and_corrupt_db(self):
        home = new_home()
        db = os.path.join(home, ".local/share/atuin/history.db")
        os.makedirs(os.path.dirname(db))
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE history (timestamp INTEGER, command TEXT)")
        con.execute("INSERT INTO history VALUES (?, ?)", (1700000000 * 10**9, "old schema"))
        con.commit()
        con.close()
        self.assertEqual(items("hist", home=home)[0]["arg"], "old schema")
        write(db, b"not a database" * 100)
        its = items("hist", home=home)
        self.assertTrue(any("atuin" in t for t in titles(its)), titles(its))

    def test_fuzzy_with_regex_characters(self):
        # Audit 2: the fuzzy matcher is a regex now: special characters must be escaped
        home = self.home_with(zsh=b"echo a.*b\nls [x]\ncat (y)\n")
        self.assertEqual(items("hist", "a.*b", home=home)[0]["arg"], "echo a.*b")
        self.assertEqual(items("hist", "l[x]", home=home)[0]["arg"], "ls [x]")
        self.assertEqual(items("hist", "c(y)", home=home)[0]["arg"], "cat (y)")
        self.assertEqual(items("hist", "e\\", home=home)[0]["title"], "No command matches “e\\”")

    def test_search(self):
        zsh = b"".join(f": {1700000000 + i}:0;{c}\n".encode() for i, c in enumerate(
            ["git commit -m wip", "docker compose up", "echo git", "kubectl get pods", "ls ~/git-repos", "gcm"]))
        home = self.home_with(zsh=zsh)
        self.assertEqual(items("hist", "git", home=home)[0]["arg"], "git commit -m wip")  # prefix first
        args = [i["arg"] for i in items("hist", "git", home=home)]
        self.assertEqual(args[:3], ["git commit -m wip", "ls ~/git-repos", "echo git"])
        self.assertEqual(items("hist", "compose dock", home=home)[0]["arg"], "docker compose up")
        self.assertIn("kubectl get pods", [i["arg"] for i in items("hist", "kgp", home=home)])  # fuzzy
        self.assertEqual(items("hist", "nomatch123", home=home)[0]["title"], "No command matches “nomatch123”")
        for q in ['"', "'", "\\", "日本", "a\nb", "(", "[", "*"]:
            items("hist", q, home=home)

    def test_missing_and_empty(self):
        self.assertEqual(items("hist", home=new_home())[0]["title"], "No shell history found")
        self.assertEqual(items("hist", home=self.home_with(zsh=b""))[0]["title"], "Shell history is empty")

    def test_custom_histfile(self):
        home = new_home()
        write(os.path.join(home, "hist", "custom"), b": 1700000000:0;custom one\n")
        self.assertEqual(items("hist", home=home, zsh_histfile="~/hist/custom")[0]["arg"], "custom one")

    def test_relative_histfile_is_in_home(self):
        # Audit 1: HISTFILE=.histfile style settings are relative to the home folder
        home = new_home()
        write(os.path.join(home, ".histfile"), b": 1700000000:0;relative one\n")
        self.assertEqual(items("hist", home=home, zsh_histfile=".histfile")[0]["arg"], "relative one")

    def test_atuin_newest_50000(self):
        # Audit 1: huge atuin databases are capped to keep index rebuilds fast
        home = new_home()
        db = os.path.join(home, ".local/share/atuin/history.db")
        os.makedirs(os.path.dirname(db))
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE history (timestamp INTEGER, command TEXT, deleted_at INTEGER)")
        con.executemany("INSERT INTO history VALUES (?, ?, NULL)", ((1600000000 * 10**9 + i * 10**9, f"c{i}") for i in range(50010)))
        con.commit()
        con.close()
        its = items("hist", home=home)
        self.assertEqual(its[0]["arg"], "c50009")
        self.assertEqual(items("hist", "zzzz", home=home)[0]["subtitle"], "Searched 50,000 commands")

    def test_very_long_command_goes_through_cache(self):
        # Audit 1: a multi-megabyte command must not bloat Alfred's JSON
        home = new_home()
        cache = new_cache()
        big = "echo " + "ü" * 30000
        write(os.path.join(home, ".zsh_history"), f": 1700000000:0;{big}\n".encode())
        out = run("hist", "", home=home, cache=cache)
        self.assertLess(len(out.stdout), 10000)
        it = json.loads(out.stdout)["items"][0]
        self.assertTrue(it["arg"].startswith("tkfile:" + cache))
        self.assertEqual(it["mods"]["alt"]["arg"], it["arg"])
        env = dict(os.environ, alfred_workflow_cache=cache)
        r = subprocess.run(["./resolve.sh", it["arg"]], cwd=SRC, env=env, capture_output=True, text=True)
        self.assertEqual(r.stdout, big)
        for bad in ["tkfile:/etc/hosts", f"tkfile:{cache}/big/../../x.txt", "-n", "tkfile:"]:
            r = subprocess.run(["./resolve.sh", bad], cwd=SRC, env=env, capture_output=True, text=True)
            self.assertEqual(r.stdout, bad)
        steps, _ = act("run", it["arg"], cache=cache, home=home, TK_APPS=json.dumps({"iterm": "/Applications/iTerm.app"}))
        self.assertEqual(steps["steps"][0]["argv"][0], big)
        steps, _ = act("run", "tkfile:/etc/hosts", cache=cache, TK_APPS=json.dumps({"iterm": "/Applications/iTerm.app"}))
        self.assertEqual(steps["steps"][0]["argv"][0], "tkfile:/etc/hosts")

    def test_huge_file_reads_the_newest_part(self):
        # Audit 2: files over the size limit are indexed from their end, starting at a full line
        home = new_home()
        lines = b"".join(f": {1600000000 + i}:0;command number {i}\n".encode() for i in range(2000))
        write(os.path.join(home, ".zsh_history"), lines)
        its = items("hist", "zzzz", home=home, TK_HIST_MAX_BYTES="10000")
        n = int(its[0]["subtitle"].split()[1])
        self.assertTrue(200 < n < 400, n)
        its = items("hist", "", home=home, TK_HIST_MAX_BYTES="10000")
        self.assertEqual(its[0]["arg"], "command number 1999")
        self.assertTrue(all(i["arg"].startswith("command number ") for i in its))

    def test_cache_invalidated_by_mtime(self):
        home = self.home_with(zsh=b": 1700000000:0;first\n")
        cache = new_cache()
        self.assertEqual(items("hist", home=home, cache=cache)[0]["arg"], "first")
        self.assertTrue(os.path.exists(os.path.join(cache, "hist-index.json")))
        p = os.path.join(home, ".zsh_history")
        with open(p, "ab") as f:
            f.write(b": 1700000100:0;second\n")
        os.utime(p, (time.time() + 5, time.time() + 5))
        self.assertEqual(items("hist", home=home, cache=cache)[0]["arg"], "second")
        # A corrupt cache is rebuilt
        write(os.path.join(cache, "hist-index.json"), "{not json")
        self.assertEqual(items("hist", home=home, cache=cache)[0]["arg"], "second")

    def test_100k_lines_fast(self):
        home = new_home()
        lines = b"".join(meta(f": {1600000000 + i}:0;cmd {i} ünï {i % 97}\n".encode()) for i in range(100000))
        write(os.path.join(home, ".zsh_history"), lines)
        cache = new_cache()
        t = time.time()
        its = items("hist", "cmd 99", home=home, cache=cache)
        first = time.time() - t
        self.assertEqual(its[0]["arg"], "cmd 99999 ünï 89")
        t = time.time()
        items("hist", "ünï 42", home=home, cache=cache)
        cached = time.time() - t
        self.assertLess(first, 0.6, f"first run took {first:.3f}s")
        self.assertLess(cached, 0.35, f"cached run took {cached:.3f}s")


# ---------------------------------------------------------------- launcher

class LauncherTests(unittest.TestCase):
    NASTY = "echo \"$(whoami)\" 'it'\\''s' ; osascript -e 'beep' \n日本 `id` \\\" end"

    def apps(self, *keys):
        paths = {"iterm": "/Applications/iTerm.app", "ghostty": "/Applications/Ghostty.app", "warp": "/Applications/Warp.app",
                 "kitty": "/Applications/kitty.app", "wezterm": "/Applications/WezTerm.app", "alacritty": "/Applications/Alacritty.app",
                 "terminal": "/System/Applications/Utilities/Terminal.app"}
        return json.dumps({k: paths[k] for k in keys})

    def test_terminal_and_iterm_pass_command_as_argv(self):
        steps, msg = act("run", self.NASTY, TK_APPS=self.apps("terminal"), terminal="terminal")
        self.assertEqual(msg, "")
        self.assertEqual(steps["terminal"], "terminal")
        self.assertEqual(steps["steps"], [{"type": "applescript", "script": "terminal", "argv": [self.NASTY]}])
        steps, _ = act("run", self.NASTY, TK_APPS=self.apps("iterm", "terminal"), terminal="iterm", terminal_open_in="tab")
        self.assertEqual(steps["steps"][0]["argv"], [self.NASTY, "tab"])

    def test_applescripts_are_static_and_use_argv(self):
        for f in os.listdir(os.path.join(SRC, "applescript")):
            src = open(os.path.join(SRC, "applescript", f), encoding="utf-8").read()
            self.assertIn("on run argv", src, f)
            self.assertNotIn("do shell script", src, f)
            self.assertNotIn("run script", src, f)

    def test_no_second_window_on_launch(self):
        # Audit 2: iTerm2 and Ghostty open a window when they launch; reuse it, and never wait
        # for a window that a running app with no windows won't open by itself.
        for f in ["iterm", "ghostty", "terminal"]:
            src = open(os.path.join(SRC, "applescript", f + ".applescript"), encoding="utf-8").read()
            self.assertIn("wasRunning", src, f)
            self.assertIn("if not wasRunning then", src.replace("if wasRunning then", "if not wasRunning then"), f)
        src = open(os.path.join(SRC, "applescript", "iterm.applescript"), encoding="utf-8").read()
        self.assertLess(src.index("if not wasRunning then"), src.index("repeat 50 times"))

    def test_osascript_treats_dash_arguments_as_data(self):
        probe = write(os.path.join(TMP, "probe.applescript"), "on run argv\nreturn (item 1 of argv) & \"|\" & (item 2 of argv)\nend run\n")
        out = subprocess.run(["/usr/bin/osascript", probe, "-e", 'beep"; do shell script "id'], capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), '-e|beep"; do shell script "id')

    def test_auto_order_and_fallback(self):
        steps, _ = act("run", "ls", TK_APPS=self.apps("kitty", "ghostty", "terminal"))
        self.assertEqual(steps["terminal"], "ghostty")
        steps, _ = act("run", "ls", TK_APPS=self.apps("kitty", "terminal"), terminal="iterm")  # not installed
        self.assertEqual(steps["terminal"], "kitty")
        steps, _ = act("run", "ls", TK_APPS=self.apps("terminal"), terminal="bogus")
        self.assertEqual(steps["terminal"], "terminal")

    def runner_file(self, steps, cache):
        argv = steps["steps"][0]["argv"]
        f = argv[-1]
        self.assertTrue(f.startswith(os.path.join(cache, "run", "cmd-")), f)
        self.assertEqual(open(f, encoding="utf-8").read(), self.NASTY)
        self.assertEqual(stat.S_IMODE(os.stat(f).st_mode), 0o600)
        self.assertNotIn(self.NASTY, argv)
        self.assertEqual(argv[argv.index("/bin/zsh"):-1], ["/bin/zsh", "-f", os.path.join(SRC, "runner.sh"), argv[-2]])
        return argv

    def test_runner_terminals(self):
        home = new_home()
        for term, marker in [("kitty", "--single-instance"), ("wezterm", "start"), ("alacritty", "-e")]:
            cache = new_cache()
            steps, _ = act("run", self.NASTY, TK_APPS=self.apps(term), terminal=term, home=home, cache=cache)
            argv = self.runner_file(steps, cache)
            self.assertEqual(argv[:3], ["/usr/bin/open", "-na", json.loads(self.apps(term))[term]])
            self.assertIn(marker, argv)
            self.assertEqual(argv[-2], home)

    def test_ghostty_versions(self):
        cache = new_cache()
        steps, _ = act("run", self.NASTY, TK_APPS=self.apps("ghostty"), terminal="ghostty", TK_APP_VERSION="1.3.1", cache=cache)
        self.assertEqual(steps["steps"][0]["type"], "applescript")
        self.assertEqual(steps["steps"][0]["argv"][1], self.NASTY)
        steps, _ = act("run", self.NASTY, TK_APPS=self.apps("ghostty"), terminal="ghostty", TK_APP_VERSION="1.2.3", cache=cache)
        argv = self.runner_file(steps, cache)
        self.assertIn("-e", argv)
        self.assertTrue(any(a.startswith("--working-directory=") for a in argv))

    def test_warp_run_and_open(self):
        steps, _ = act("run", self.NASTY, TK_APPS=self.apps("warp"), terminal="warp")
        s = steps["steps"][0]
        self.assertEqual(s["type"], "warp-paste")
        self.assertEqual(s["cmd"], self.NASTY)
        self.assertTrue(s["url"].startswith("warp://action/new_window?path=%2F"))
        self.assertEqual(s["bundleid"], "dev.warp.Warp-Stable")
        steps, _ = act("run", "ls", TK_APPS=self.apps("warp"), terminal="warp", warp_release="preview", terminal_open_in="tab")
        self.assertTrue(steps["steps"][0]["url"].startswith("warppreview://action/new_tab"))
        self.assertEqual(steps["steps"][0]["bundleid"], "dev.warp.Warp-Preview")

    def test_open_dirs_universal_action(self):
        home = new_home()
        d1 = os.path.join(home, "a dir 'x'")
        d2 = os.path.join(home, "b ü")
        os.makedirs(d1)
        os.makedirs(d2)
        f = write(os.path.join(d2, "file.txt"), "x")
        out = run("open-dirs", f"{d1}\t{f}\t{d1}", TK_DRY_RUN="1", TK_APPS=self.apps("iterm"), terminal="iterm", home=home)
        logs = [json.loads(l) for l in out.stderr.splitlines() if l.startswith("{")]
        self.assertEqual([l["steps"][0]["argv"] for l in logs],
                         [["/usr/bin/open", "-a", "/Applications/iTerm.app", d1], ["/usr/bin/open", "-a", "/Applications/iTerm.app", d2]])
        out = run("open-dirs", "/nonexistent/path/x", TK_DRY_RUN="1")
        self.assertIn("Nothing to open", out.stdout)
        # Warp opens folders with its URI scheme
        out = run("open-dirs", d1, TK_DRY_RUN="1", TK_APPS=self.apps("warp"), terminal="warp", home=home)
        url = json.loads(out.stderr.splitlines()[0])["steps"][0]["url"]
        self.assertEqual(url, "warp://action/new_window?path=" + __import__("urllib.parse").parse.quote(d1, safe="!*'()"))

    def test_runner_script_executes_file_and_cleans_up(self):
        home = new_home()
        cmdfile = write(os.path.join(TMP, "cmd.txt"), "printf '%s' \"it's ü\" > out.txt")
        env = dict(os.environ, SHELL="/bin/sh", HOME=home)
        subprocess.run(["/bin/zsh", "-f", os.path.join(SRC, "runner.sh"), home, cmdfile], env=env, stdin=subprocess.DEVNULL,
                       capture_output=True, timeout=20)
        self.assertEqual(open(os.path.join(home, "out.txt"), encoding="utf-8").read(), "it's ü")
        self.assertFalse(os.path.exists(cmdfile))

    def test_other_actions(self):
        home = new_home()
        f = write(os.path.join(home, ".ssh", "config"), "Host a\n")
        steps, _ = act("edit", f, home=home)
        self.assertEqual(steps, {"open": ["-t", f]})
        steps, _ = act("reveal", f, home=home)
        self.assertEqual(steps, {"open": ["-R", f]})
        _, msg = act("edit", "/nope/missing", home=home)
        self.assertIn("doesn't exist", msg)
        steps, _ = act("url", "https://example.com/a?b=c", home=home)
        self.assertEqual(steps, {"url": "https://example.com/a?b=c"})
        steps, msg = act("url", "file:///etc/passwd")
        self.assertIsNone(steps)
        self.assertEqual(msg, "Couldn't open the link")
        _, msg = act("run", "   ")
        self.assertEqual(msg, "Nothing to run")
        _, msg = act("bogus", "x")
        self.assertIn("Unknown action", msg)


# ---------------------------------------------------------------- ssh

class SSHTests(unittest.TestCase):
    def setUp(self):
        self.home = h = new_home()
        write(f"{h}/.ssh/config", """
# comment
Host web web-alias
    HostName web.example.com
    User deploy
    Port 2222
Host *.internal !bad
    User nobody
Host db
    HostName=10.0.0.5
    ProxyJump bastion
    User "db user"
Match host foo
    User matched
Include conf.d/*.conf ~/.ssh/extra "missing file"
Include config
Host web
    User ignored-second-value
Host -oProxyCommand=evil
""")
        write(f"{h}/.ssh/conf.d/a.conf", "Host from-glob\n  HostName glob.example.com\nInclude cycle.conf\n")
        write(f"{h}/.ssh/conf.d/skip.txt", "Host not-included\n")
        write(f"{h}/.ssh/cycle.conf", "Host cycle-host\nInclude conf.d/a.conf\n")
        write(f"{h}/.ssh/extra", "Host extra-ü\nHost extra\n  HostName extra.example.com\n")
        write(f"{h}/.ssh/known_hosts", "\n".join([
            "[web.example.com]:2222 ssh-ed25519 AAAA",  # same as config host web → skipped
            "10.0.0.5 ssh-ed25519 AAAA",  # same as config host db → skipped
            "github.com,140.82.121.4 ssh-ed25519 AAAA",
            "[gitlab.local]:2200 ssh-rsa AAAA",
            "|1|hashed=|hash= ssh-rsa AAAA",
            "@cert-authority *.example.com ssh-rsa AAAA",
            "@revoked revoked.example.com ssh-rsa AAAA",
            "*.wild ssh-rsa AAAA",
            "-oProxyCommand=evil ssh-rsa AAAA",
            "weird$(id) ssh-rsa AAAA",
            "# comment",
        ]))

    def test_config_hosts(self):
        its = items("ssh", home=self.home)
        names = titles(its)
        for n in ["web", "web-alias", "db", "from-glob", "cycle-host", "extra", "github.com", "140.82.121.4", "gitlab.local"]:
            self.assertIn(n, names)
        for n in ["10.0.0.5", "*.internal", "not-included", "revoked.example.com", "web.example.com", "*.wild", "-oProxyCommand=evil", "weird$(id)", "extra-ü"]:
            self.assertNotIn(n, names)
        web = find(its, "web")
        self.assertEqual(web["subtitle"], "deploy@web.example.com:2222 · ~/.ssh/config")
        self.assertEqual(web["arg"], "ssh web")
        self.assertEqual(web["variables"]["tk_action"], "ssh")
        self.assertEqual(web["mods"]["cmd"]["arg"], "ssh web")
        self.assertEqual(web["mods"]["cmd"]["variables"]["tk_action"], "copy")
        self.assertEqual(web["mods"]["alt"]["arg"], os.path.join(self.home, ".ssh/config"))
        db = find(its, "db")
        self.assertIn("db user@10.0.0.5", db["subtitle"])
        self.assertIn("via bastion", db["subtitle"])
        self.assertEqual(find(its, "from-glob")["mods"]["alt"]["arg"], os.path.join(self.home, ".ssh/conf.d/a.conf"))
        gl = find(its, "gitlab.local")
        self.assertEqual(gl["arg"], "ssh -p 2200 gitlab.local")
        self.assertIn("known_hosts", gl["subtitle"])
        self.assertLess(names.index("web"), names.index("github.com"))  # config hosts first

    def test_filter_and_typed_host(self):
        its = items("ssh", "glob", home=self.home)
        self.assertEqual(its[0]["title"], "from-glob")
        its = items("ssh", "root@new.example.com:2201", home=self.home)
        row = find(its, "Connect to")
        self.assertEqual(row["arg"], "ssh -p 2201 root@new.example.com")
        for q in ["-oProxyCommand=x", "a;b", "$(id)", "a b"]:
            self.assertFalse(any(t.startswith("Connect to") for t in titles(items("ssh", q, home=self.home))), q)

    def test_act_connects_in_terminal(self):
        steps, _ = act("ssh", "ssh web", home=self.home, TK_APPS=json.dumps({"iterm": "/Applications/iTerm.app"}))
        self.assertEqual(steps["steps"][0]["argv"], ["ssh web", "window"])

    def test_missing_ssh_dir(self):
        its = items("ssh", home=new_home())
        self.assertEqual(its[0]["title"], "No SSH hosts found")
        self.assertEqual(items("ssh", "zzz qqq", home=self.home)[0]["title"], "No host matches “zzz qqq”")

    def test_known_hosts_disabled(self):
        names = titles(items("ssh", home=self.home, ssh_known_hosts="0"))
        self.assertNotIn("github.com", names)

    def test_host_quoting(self):
        h = new_home()
        write(f"{h}/.ssh/config", "Host odd%host\n")
        self.assertEqual(items("ssh", home=h)[0]["arg"], "ssh odd%host")


# ---------------------------------------------------------------- tldr

def make_zip(path, pages):
    with zipfile.ZipFile(path, "w") as z:
        for name, text in pages.items():
            z.writestr(name, text)
    return path


TAR = """# tar

> Archiving utility.
> Often combined with a compression method, such as `gzip`.
> More information: <https://www.gnu.org/software/tar>.

- [c]reate an archive:

`tar cf {{path/to/target.tar}} {{path/to/file1 path/to/file2 ...}}`

- Extract verbosely:

`tar {{[-x|--extract]}} {{[-v|--verbose]}} -f {{source.tar}}`
"""

EN = {
    "common/tar.md": TAR,
    "common/git.md": "# git\n\n> Version control.\n> More information: <https://git-scm.com>.\n\n- Show status:\n\n`git status`\n",
    "common/git-stash.md": "# git stash\n\n> Stash changes.\n\n- Apply a stash:\n\n`git stash apply {{stash@{0}}}`\n\n- Literal braces:\n\n`echo \\{\\{ {{name}} \\}\\}`\n\n- Push with message:\n\n`git stash push {{[-m|--message]}} {{message}}`\n",
    "common/sed.md": "# sed\n\n> Common sed.\n\n- Common example:\n\n`sed 's/a/b/'`\n",
    "osx/sed.md": "# sed\n\n> BSD sed.\n\n- macOS example:\n\n`sed -i '' 's/a/b/' {{file}}`\n",
    "linux/apt.md": "# apt\n\n> Debian packages.\n\n- Install:\n\n`sudo apt install {{package}}`\n",
    "windows/dir.md": "# dir\n\n> List.\n\n- List:\n\n`dir`\n",
}
DE = {
    "common/tar.md": TAR.replace("Archiving utility.", "Archivierungswerkzeug.").replace("More information", "Weitere Informationen"),
    "linux/sed.md": "# sed\n\n> Deutsches linux sed.\n\n- Beispiel:\n\n`sed x`\n",
}


class TldrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(dir=TMP, prefix="tldr-")
        make_zip(os.path.join(cls.dir, "tldr-pages.en.zip"), EN)
        make_zip(os.path.join(cls.dir, "tldr-pages.de.zip"), DE)
        cls.url = "file://" + cls.dir + "/tldr-pages.{lang}.zip"
        cls.cache = new_cache()
        items("tldr", "", cache=cls.cache, TK_TLDR_URL=cls.url, TK_SYNC_UPDATE="1")

    def t(self, q, **kw):
        kw.setdefault("cache", self.cache)
        return items("tldr", q, TK_TLDR_URL=self.url, **kw)

    def test_page_rows(self):
        its = self.t("tar")
        self.assertEqual(its[0]["title"], "tar")
        self.assertEqual(its[0]["subtitle"], "Archiving utility. Often combined with a compression method, such as gzip.")
        self.assertEqual(its[0]["arg"], "https://www.gnu.org/software/tar")
        self.assertEqual(its[0]["variables"]["tk_action"], "url")
        self.assertEqual(its[1]["arg"], "tar cf path/to/target.tar path/to/file1 path/to/file2 ...")
        self.assertEqual(its[1]["subtitle"], "[c]reate an archive")
        self.assertEqual(its[1]["variables"]["tk_action"], "copy")
        self.assertEqual(its[1]["mods"]["cmd"]["variables"]["tk_action"], "paste")
        self.assertEqual(its[1]["mods"]["alt"]["arg"], "tar cf {{path/to/target.tar}} {{path/to/file1 path/to/file2 ...}}")
        self.assertEqual(its[2]["arg"], "tar --extract --verbose -f source.tar")
        self.assertEqual(its[-1]["autocomplete"], "tar @cheat")

    def test_option_style_short(self):
        self.assertEqual(self.t("tar", tldr_options="short")[2]["arg"], "tar -x -v -f source.tar")

    def test_nested_and_escaped_placeholders(self):
        args = [i.get("arg") for i in self.t("git stash")]
        self.assertIn("git stash apply stash@{0}", args)
        self.assertIn("echo {{ name }}", args)
        self.assertIn("git stash push --message message", args)
        self.assertEqual(self.t("git stash")[0]["valid"], False)  # no documentation link

    def test_platform_order(self):
        its = self.t("sed")
        self.assertEqual(its[0]["subtitle"], "BSD sed.")  # osx before common
        its = self.t("apt")
        self.assertIn("linux page", its[0]["subtitle"])
        self.assertIn("windows page", self.t("dir")[0]["subtitle"])

    def test_language_fallback_platform_first(self):
        cache = new_cache()
        its = items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1", tldr_language="de")
        self.assertEqual(its[0]["subtitle"], "Archivierungswerkzeug. Often combined with a compression method, such as gzip.")
        self.assertEqual(its[0]["arg"], "https://www.gnu.org/software/tar")
        # English osx page beats German linux page (platform before language)
        its = items("tldr", "sed", cache=cache, TK_TLDR_URL=self.url, tldr_language="de")
        self.assertEqual(its[0]["subtitle"], "BSD sed.")
        self.assertEqual(items("tldr", "git", cache=cache, TK_TLDR_URL=self.url, tldr_language="de")[0]["title"], "git")
        its = items("tldr", "", cache=cache, TK_TLDR_URL=self.url, tldr_language="de")
        self.assertIn("de with English fallback", its[0]["subtitle"])

    def test_invalid_language_is_english(self):
        its = self.t("", tldr_language="../../etc")
        self.assertNotIn("fallback", its[0]["subtitle"])
        self.assertFalse(os.path.exists(os.path.join(self.cache, "etc")))

    def test_multiword_and_filter(self):
        self.assertEqual(self.t("git stash")[0]["title"], "git stash")
        its = self.t("git stash message")
        self.assertEqual([i["arg"] for i in its if i.get("valid", True)], ["git stash push --message message"])
        its = self.t("tar zzznomatch")
        self.assertTrue(its[0]["title"].startswith("No tar example matches"))

    def test_related_pages(self):
        its = self.t("git")
        rel = find(its, "git stash")
        self.assertEqual(rel["autocomplete"], "git stash")
        self.assertFalse(rel["valid"])

    def test_prefix_search(self):
        its = self.t("gi")
        self.assertEqual(titles(its)[:2], ["git", "git stash"])
        self.assertEqual(its[0]["autocomplete"], "git")
        its = self.t("zzzz")
        self.assertEqual(its[0]["title"], "No tldr page for “zzzz”")
        self.assertEqual(its[-1]["autocomplete"], "zzzz @cheat")
        its = self.t("zzzz", tldr_cheatsh="0")
        self.assertEqual(len(its), 1)
        for q in ['"', "'", "日本", "a\nb", "../../etc/passwd", "*"]:
            self.t(q)

    def test_empty_query(self):
        its = self.t("")
        self.assertIn("6 pages offline", its[0]["subtitle"])
        self.assertEqual(its[1]["variables"]["tk_action"], "tldr-update")

    def test_async_first_download(self):
        cache = new_cache()
        data = sf("tldr", "tar", cache=cache, TK_TLDR_URL=self.url)
        self.assertEqual(data["items"][0]["title"], "Downloading tldr pages…")
        self.assertEqual(data["rerun"], 0.5)
        for _ in range(100):
            if os.path.exists(os.path.join(cache, "tldr", "en.stamp")) and not os.path.exists(os.path.join(cache, "tldr", ".lock")):
                break
            time.sleep(0.1)
        self.assertEqual(items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url)[0]["title"], "tar")

    def test_download_failure_and_retry(self):
        cache = new_cache()
        its = items("tldr", "tar", cache=cache, TK_TLDR_URL="file:///nonexistent/{lang}.zip", TK_SYNC_UPDATE="1")
        self.assertEqual(its[0]["title"], "Couldn't download the tldr pages")
        self.assertEqual(its[1]["variables"]["tk_action"], "tldr-update")
        self.assertEqual(its[-1]["autocomplete"], "tar @cheat")
        # Not retried automatically within the hour
        its = items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1")
        self.assertEqual(its[0]["title"], "Couldn't download the tldr pages")
        # ...but the Try again action does
        run("act", "retry", cache=cache, tk_action="tldr-update", TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1")
        self.assertEqual(items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url)[0]["title"], "tar")

    def test_bad_archive_keeps_old_pages(self):
        cache = new_cache()
        items("tldr", "", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1")
        bad = make_zip(os.path.join(TMP, "tldr-pages.en.zip"), {"README.md": "no pages"})
        run("act", "", cache=cache, tk_action="tldr-update", TK_TLDR_URL="file://" + os.path.dirname(bad) + "/tldr-pages.{lang}.zip", TK_SYNC_UPDATE="1")
        self.assertEqual(items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url)[0]["title"], "tar")

    def test_switching_language_downloads_it_now(self):
        # Audit 1: the hourly retry limit must not delay a newly chosen language
        cache = new_cache()
        items("tldr", "", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1")
        its = items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1", tldr_language="de")
        self.assertTrue(its[0]["subtitle"].startswith("Archivierungswerkzeug"))

    def test_update_fits_in_lock_timeout(self):
        # Audit 1: two languages with retries must finish before the 10-minute lock goes stale
        import re
        src = open(os.path.join(SRC, "tldr-update.sh")).read()
        t = int(re.search(r"--max-time (\d+)", src).group(1))
        retries = int(re.search(r"--retry (\d+)", src).group(1))
        self.assertLess(2 * t * (retries + 1), 600)

    def test_failed_swap_keeps_old_pages(self):
        # Audit 2: if moving the new pages into place fails, the old pages are put back
        cache = new_cache()
        items("tldr", "", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1")
        fakebin = tempfile.mkdtemp(dir=TMP)
        write(os.path.join(fakebin, "mv"), '#!/bin/zsh\n[[ $2 == */pages ]] && exit 1\nexec /bin/mv "$@"\n')
        os.chmod(os.path.join(fakebin, "mv"), 0o755)
        run("act", "", cache=cache, tk_action="tldr-update", TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1",
            PATH=fakebin + ":" + os.environ["PATH"])
        self.assertEqual(items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url)[0]["title"], "tar")

    def test_weekly_refresh(self):
        cache = new_cache()
        items("tldr", "", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1")
        stamp = os.path.join(cache, "tldr", "en.stamp")
        write(stamp, str(int(time.time()) - 8 * 86400))
        os.remove(os.path.join(cache, "tldr", ".attempt-en"))
        its = items("tldr", "tar", cache=cache, TK_TLDR_URL=self.url, TK_SYNC_UPDATE="1")
        self.assertEqual(its[0]["title"], "tar")  # stale pages still answer
        self.assertGreater(float(open(stamp).read()), time.time() - 60)


class CheatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(dir=TMP, prefix="cheat-")
        write(os.path.join(cls.dir, "tar"), "# To extract an archive:\ntar -xvf archive.tar\n\n\x1b[1m# colours\x1b[0m\ntar -czf out.tgz dir/\n")
        write(os.path.join(cls.dir, "nothing"), "Unknown topic.\nDo you mean one of these topics maybe?\n")
        os.makedirs(os.path.join(cls.dir, "git"))
        write(os.path.join(cls.dir, "git", "commit+amend"), "git commit --amend\n")
        cls.url = "file://" + cls.dir

    def test_rows(self):
        its = items("tldr", "tar @cheat", TK_CHEAT_URL=self.url)
        self.assertEqual(its[0]["arg"], "https://cheat.sh/tar")
        self.assertEqual(its[1]["arg"], "tar -xvf archive.tar")
        self.assertEqual(its[1]["subtitle"], "To extract an archive:")
        self.assertEqual(its[2]["subtitle"], "colours")
        self.assertEqual(its[2]["mods"]["cmd"]["variables"]["tk_action"], "paste")

    def test_multiword_unknown_and_errors(self):
        self.assertEqual(items("tldr", "git commit amend @cheat", TK_CHEAT_URL=self.url)[1]["arg"], "git commit --amend")
        self.assertTrue(items("tldr", "nothing @cheat", TK_CHEAT_URL=self.url)[1]["title"].startswith("cheat.sh has no sheet"))
        its = items("tldr", "missing @cheat", TK_CHEAT_URL=self.url)
        self.assertEqual(its[0]["title"], "Couldn't reach cheat.sh")
        self.assertEqual(its[1]["arg"], "https://cheat.sh/missing")
        self.assertEqual(items("tldr", "@cheat", TK_CHEAT_URL=self.url)[0]["title"], "Type a command, then @cheat")
        for q in ['"q @cheat', "日本 @cheat", "../x @cheat"]:
            items("tldr", q, TK_CHEAT_URL=self.url)

    def test_long_topics_do_not_collide(self):
        # Audit 1: cache file names stay unique (and short) for long topics
        cache = new_cache()
        a, b = "a" * 99 + "x", "a" * 99 + "y"
        write(os.path.join(self.dir, a), "echo x\n")
        write(os.path.join(self.dir, b), "echo y\n")
        self.assertEqual(items("tldr", a + " @cheat", cache=cache, TK_CHEAT_URL=self.url)[1]["arg"], "echo x")
        self.assertEqual(items("tldr", b + " @cheat", cache=cache, TK_CHEAT_URL=self.url)[1]["arg"], "echo y")
        self.assertTrue(all(len(f) < 200 for f in os.listdir(os.path.join(cache, "cheat"))))

    def test_cached(self):
        cache = new_cache()
        items("tldr", "tar @cheat", cache=cache, TK_CHEAT_URL=self.url)
        its = items("tldr", "tar @cheat", cache=cache, TK_CHEAT_URL="file:///nonexistent")
        self.assertEqual(its[1]["arg"], "tar -xvf archive.tar")

    def test_disabled(self):
        its = items("tldr", "tar @cheat", TK_CHEAT_URL=self.url, tldr_cheatsh="0")
        self.assertNotEqual(its[0]["title"], "cheat.sh/tar")


# ---------------------------------------------------------------- plist

class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        objs = {o["uid"]: o for o in p["objects"]}
        self.assertEqual(len(objs), len(p["objects"]))
        for src, conns in p["connections"].items():
            self.assertIn(src, objs)
            for c in conns:
                self.assertIn(c["destinationuid"], objs)
                if "sourceoutputuid" in c:
                    self.assertIn(c["sourceoutputuid"], [x["uid"] for x in objs[src]["config"]["conditions"]])
        sfs = [o for o in p["objects"] if o["type"] == "alfred.workflow.input.scriptfilter"]
        self.assertEqual(sorted(o["config"]["keyword"] for o in sfs),
                         ["{var:keyword_hist}", "{var:keyword_ssh}", "{var:keyword_tldr}", "{var:keyword_warp}"])
        for o in sfs:
            mods = {c["modifiers"] for c in p["connections"][o["uid"]]}
            self.assertTrue({0, 1048576, 524288} <= mods, o["config"]["keyword"])  # ↩, ⌘, ⌥
        cond = next(o for o in p["objects"] if o["type"] == "alfred.workflow.utility.conditional")
        self.assertEqual([c["matchstring"] for c in cond["config"]["conditions"]], ["copy", "paste"])
        self.assertTrue(all(c["inputstring"] == "{var:tk_action}" for c in cond["config"]["conditions"]))
        ua = next(o for o in p["objects"] if o["type"] == "alfred.workflow.trigger.universalaction")
        self.assertTrue(ua["config"]["acceptsfiles"])
        self.assertTrue(p["readme"].startswith("## Usage"))
        cfg = {c["variable"]: c for c in p["userconfigurationconfig"]}
        for k in ["terminal", "terminal_open_in", "warp_release", "tldr_language", "hist_atuin", "ssh_known_hosts"]:
            self.assertIn(k, cfg)
        self.assertEqual([x[1] for x in cfg["terminal"]["config"]["pairs"]],
                         ["auto", "terminal", "iterm", "ghostty", "warp", "kitty", "wezterm", "alacritty"])
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)

    def test_scripts_are_executable_and_parse(self):
        for f in ["runner.sh", "tldr-update.sh"]:
            path = os.path.join(SRC, f)
            self.assertTrue(os.access(path, os.X_OK), f)
            self.assertEqual(subprocess.run(["/bin/zsh", "-n", path]).returncode, 0, f)


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=1)
