"""Unit tests for the lane console's build cache key (cache.py) and page selection (pages.py): no browser, no build.
  python3 molds/mold_v0/testing/console/test_render.py        (also run by render.py --self-test)
"""
import json, os, shutil, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cache, pages  # noqa: E402


def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh: fh.write(text)


class CacheKey(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="lane-cache-test-")
        self.cb = self.lane("a")
        self.standin = os.path.join(self.t, "standin"); write(os.path.join(self.standin, "package.json"), '{"version":"1-lane-standin"}')
        self.env = {"PATH": "/usr/bin", "HOME": "/root", "LANG": "C.UTF-8", "NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1",
                    "APP_API_URL": "http://127.0.0.1:41000", "NEXT_PUBLIC_AUTH_PROVIDER": "clerk"}

    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)

    def lane(self, name):
        cb = os.path.join(self.t, name)
        write(os.path.join(cb, "web", "src", "app", "page.tsx"), "export default () => 'home'")
        write(os.path.join(cb, "web", "src", "config", "pack-nav.generated.ts"), "export const packTabs = []")
        write(os.path.join(cb, "web", "node_modules", ".package-lock.json"), '{"packages":{"node_modules/next":{"version":"16.2.12"}}}')
        write(os.path.join(cb, "packs", "p1", "pack.json"), '{"id":"p1"}')
        write(os.path.join(cb, "profile.json"), '{"name":"A"}')
        return cb

    def key(self, cb=None, env=None, node="v22.0.0"):
        cb = cb or self.cb
        return cache.key(cache.inputs(cb, os.path.join(cb, "web"), os.path.join(cb, "web", "node_modules"), self.standin, env or self.env, node))

    def test_same_inputs_same_key_in_any_folder(self):
        self.assertEqual(self.key(), self.key())
        self.assertEqual(self.key(), self.key(self.lane("b")), "a second clone of the same lane copy shares the build")

    def test_a_console_file_changes_the_key(self):
        k = self.key(); write(os.path.join(self.cb, "web", "src", "app", "page.tsx"), "export default () => 'home!'")
        self.assertNotEqual(k, self.key())

    def test_a_new_file_changes_the_key(self):
        k = self.key(); write(os.path.join(self.cb, "web", "src", "app", "app", "page.tsx"), "x")
        self.assertNotEqual(k, self.key())

    def test_generated_pack_files_change_the_key(self):
        k = self.key(); write(os.path.join(self.cb, "web", "src", "config", "pack-nav.generated.ts"), "export const packTabs = [1]")
        self.assertNotEqual(k, self.key())

    def test_a_different_pack_never_shares(self):
        k = self.key()
        write(os.path.join(self.cb, "packs", "p1", "pack.json"), '{"id":"p1","v":2}')
        k2 = self.key(); self.assertNotEqual(k, k2)
        write(os.path.join(self.cb, "packs", "p2", "pack.json"), '{"id":"p2"}')
        self.assertNotEqual(k2, self.key())
        os.makedirs(os.path.join(self.cb, "web", "src", "packs", "host1"))
        self.assertNotEqual(k2, self.key(), "a host pack folder is an input")

    def test_profile_changes_the_key(self):
        k = self.key(); write(os.path.join(self.cb, "profile.json"), '{"name":"B"}')
        self.assertNotEqual(k, self.key())

    def test_installed_packages_change_the_key(self):
        k = self.key(); write(os.path.join(self.cb, "web", "node_modules", ".package-lock.json"), '{"packages":{"node_modules/next":{"version":"16.2.13"}}}')
        self.assertNotEqual(k, self.key())

    def test_versions_when_npm_kept_no_record(self):
        nm = os.path.join(self.cb, "web", "node_modules"); os.remove(os.path.join(nm, ".package-lock.json"))
        write(os.path.join(nm, "next", "package.json"), '{"version":"16.2.12"}'); write(os.path.join(nm, "@scope", "x", "package.json"), '{"version":"1"}')
        k = self.key(); write(os.path.join(nm, "@scope", "x", "package.json"), '{"version":"2"}')
        self.assertNotEqual(k, self.key())

    def test_build_env_counts_but_not_the_api_port(self):
        k = self.key()
        self.assertEqual(k, self.key(env={**self.env, "APP_API_URL": "http://127.0.0.1:52000", "PATH": "/other", "HOME": "/h"}))
        self.assertNotEqual(k, self.key(env={**self.env, "NEXT_PUBLIC_AUTH_PROVIDER": "builtin"}))
        self.assertNotEqual(k, self.key(env={**self.env, "LANG": "de_DE.UTF-8"}))

    def test_node_and_standin_count(self):
        k = self.key()
        self.assertNotEqual(k, self.key(node="v24.1.0"))
        write(os.path.join(self.standin, "index.js"), "x"); self.assertNotEqual(k, self.key())

    def test_ignored_folders_and_env_files_do_not_count(self):
        k = self.key()
        write(os.path.join(self.cb, "web", ".next", "BUILD_ID"), "x")
        write(os.path.join(self.cb, "web", ".env.local"), "SECRET=1")
        write(os.path.join(self.cb, "web", "node_modules", "left-pad", "index.js"), "x")
        write(os.path.join(self.cb, "src", "http.ts"), "api only")   # the API is served from the lane copy, never cached
        self.assertEqual(k, self.key())


class CacheStore(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(prefix="lane-store-test-")
        self.root = os.path.join(self.t, "cache")

    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)

    def built(self, port=41000):
        w = os.path.join(self.t, "work", "web")
        shutil.rmtree(w, ignore_errors=True)
        write(os.path.join(w, ".next", "BUILD_ID"), "b1")
        write(os.path.join(w, ".next", "routes-manifest.json"), json.dumps({"rewrites": {"fallback": [{"destination": f"http://127.0.0.1:{port}/:path*"}]}}))
        write(os.path.join(w, ".next", "required-server-files.json"), f'{{"x":"http://127.0.0.1:{port}/:path*"}}')
        write(os.path.join(w, ".next", "cache", "webpack", "big"), "x" * 100)
        write(os.path.join(w, "src", "app", "page.tsx"), "x")
        os.makedirs(os.path.join(w, "node_modules", "next"))
        return w

    def test_store_lookup_copy_and_patch(self):
        self.assertIsNone(cache.lookup(self.root, "k1"))
        cache.store(self.root, "k1", self.built(), {"api_port": 41000})
        meta = cache.lookup(self.root, "k1")
        self.assertEqual(meta["api_port"], 41000)
        e = cache.entry(self.root, "k1")
        self.assertFalse(os.path.exists(os.path.join(e, "web", ".next", "cache")), "the bundler cache stays in work/")
        self.assertFalse(os.path.exists(os.path.join(e, "web", "node_modules")), "packages are linked per run")
        run = cache.run_copy(self.root, "k1")
        nd = os.path.join(run, "web", ".next")
        self.assertTrue(cache.patch_port(nd, 41000, 43210))
        self.assertIn("127.0.0.1:43210", open(os.path.join(nd, "routes-manifest.json")).read())
        self.assertIn("127.0.0.1:43210", open(os.path.join(nd, "required-server-files.json")).read())
        self.assertIn("127.0.0.1:41000", open(os.path.join(e, "web", ".next", "routes-manifest.json")).read(), "the entry itself is never patched")
        self.assertFalse(cache.patch_port(nd, 41000, 1), "an address that is not there is refused, nothing written")

    def test_patch_refuses_an_ambiguous_manifest(self):
        w = self.built()
        write(os.path.join(w, ".next", "routes-manifest.json"), "http://127.0.0.1:41000 http://127.0.0.1:41000")
        self.assertFalse(cache.patch_port(os.path.join(w, ".next"), 41000, 2))

    def test_an_unfinished_entry_is_no_entry(self):
        os.makedirs(os.path.join(cache.entry(self.root, "k2"), "web"))
        write(os.path.join(cache.entry(self.root, "k2"), "meta.json"), '{"key":"k2"}')
        self.assertIsNone(cache.lookup(self.root, "k2"), "no BUILD_ID: not a build")

    def test_lru_eviction_keeps_the_newest_and_skips_what_is_in_use(self):
        for i in range(8):
            cache.store(self.root, f"k{i}", self.built(), {"api_port": 1})
            p = os.path.join(cache.entry(self.root, f"k{i}"), "meta.json")
            m = json.load(open(p)); m["last_used"] = 1000 + i; cache.write_json(p, m)
        with cache.lock(os.path.join(self.root, "locks", "k0.lock")):
            gone = cache.evict(self.root, 5, protect={"k1"}, say=lambda *_: None)
        self.assertEqual(sorted(gone), ["k2"], "k0 is in use, k1 protected: only k2 of the three oldest goes")
        self.assertEqual(sorted(cache.evict(self.root, 5, say=lambda *_: None)), ["k0", "k1"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.root, "entries"))), [f"k{i}" for i in range(3, 8)])

    def test_touch_marks_use(self):
        cache.store(self.root, "k1", self.built(), {"api_port": 1})
        before = cache.lookup(self.root, "k1")["last_used"]; time.sleep(0.01)
        cache.touch(self.root, "k1")
        m = cache.lookup(self.root, "k1"); self.assertGreater(m["last_used"], before); self.assertEqual(m["uses"], 1)


PAGES = [
    {"pack": "shell", "path": "/"}, {"pack": "shell", "path": "/admin"}, {"pack": "shell", "path": "/admin/keys"},
    {"pack": "shell", "path": "/app"}, {"pack": "shell", "path": "/app/keys"}, {"pack": "shell", "path": "/app/team"},
    {"pack": "shell", "path": "/app?lane=no-account", "as": "no_account"}, {"pack": "shell", "path": "/privacy"},
    {"pack": "shell", "path": "/request-access"},
    {"pack": "octo", "path": "/app/research"}, {"pack": "octo", "path": "/admin/research"}, {"pack": "octo", "path": "/research"},
    {"pack": "p1", "path": "/app/keys"}, {"pack": "p1", "path": "/app/packs/p1/home"}, {"pack": "p1", "path": "/app/records/filings"},
    {"pack": "p1", "path": "/admin/records/filings"},
]
PACKS = [{"id": "octo", "kind": "host"}, {"id": "p1", "kind": "pack"}, {"id": "quiet", "kind": "pack"}]
ALL = list(dict.fromkeys(p["path"] for p in PAGES))
SMOKE = ["/", "/admin"]
MOLD = "molds/mold_v0/codebase/"


def chosen(*changed, importers=None, pages_=PAGES):
    c, notes, rules = pages.plan(list(changed), pages_, PACKS, importers)
    return sorted(c), notes, rules


class PageSelection(unittest.TestCase):
    def test_one_page(self):
        c, _, _ = chosen(MOLD + "web/src/app/app/keys/page.tsx")
        self.assertEqual(c, sorted(["/app/keys"] + SMOKE), "the page, both rows of it (shell and p1's tab), and the smoke")

    def test_a_page_with_rows_for_other_people(self):
        c, _, _ = chosen(MOLD + "web/src/app/app/page.tsx")
        self.assertEqual(c, sorted(["/app", "/app?lane=no-account"] + SMOKE))

    def test_a_layout_takes_its_subtree(self):
        c, _, _ = chosen(MOLD + "web/src/app/app/layout.tsx")
        self.assertEqual(c, sorted(["/app", "/app/keys", "/app/team", "/app?lane=no-account", "/app/research", "/app/packs/p1/home", "/app/records/filings"] + SMOKE))

    def test_shared_code_takes_every_page(self):
        for f in ("web/src/components/ui/button.tsx", "web/src/lib/api.ts", "web/src/styles/x.css", "web/next.config.ts",
                  "web/package.json", "web/src/config/pack-nav.generated.ts", "web/src/proxy.ts", "web/public/logo.svg",
                  "web/src/app/layout.tsx", "web/src/app/globals.css", "web/src/app/(site)/layout.tsx", "src/http.ts",
                  "package.json", "profile.json", "sql/001.sql"):
            self.assertEqual(chosen(MOLD + f)[0], sorted(ALL), f)

    def test_the_harness_itself_takes_every_page(self):
        self.assertEqual(chosen("molds/mold_v0/testing/console/browser.mjs")[0], sorted(ALL))
        self.assertEqual(chosen("molds/mold_v0/testing/accessibility/a11y.mjs")[0], sorted(ALL))

    def test_nothing_that_reaches_the_console_is_smoke_only(self):
        for f in ("molds/mold_v0/testing/load/load.py", "state/tasks/mold_v0.jsonl", "docs/RUNBOOK.md", MOLD + "docs/x.md",
                  MOLD + "README.md", MOLD + "scripts/no-account-test.ts", "molds/mold_v1/codebase/web/src/components/x.tsx",
                  ".claude/scripts/lanes.py", "AGENTS.md"):
            self.assertEqual(chosen(f)[0], SMOKE, f)

    def test_dynamic_segments_take_their_static_part(self):
        self.assertEqual(chosen(MOLD + "web/src/app/app/records/[area]/page.tsx")[0], sorted(["/app/records/filings"] + SMOKE))
        self.assertEqual(chosen(MOLD + "web/src/app/app/packs/[pack]/[page]/page.tsx")[0], sorted(["/app/packs/p1/home"] + SMOKE))

    def test_host_routes_take_that_area_of_host_packs(self):
        self.assertEqual(chosen(MOLD + "web/src/app/app/host/[pack]/[...path]/page.tsx")[0], sorted(["/app/research"] + SMOKE))
        self.assertEqual(chosen(MOLD + "web/src/app/(site)/host/[pack]/[...path]/page.tsx")[0], sorted(["/research"] + SMOKE))
        self.assertEqual(chosen(MOLD + "web/src/app/admin/host/[pack]/[...path]/page.tsx")[0], sorted(["/admin/research"] + SMOKE))

    def test_route_groups_are_not_in_the_address(self):
        self.assertEqual(chosen(MOLD + "web/src/app/(site)/privacy/page.tsx")[0], sorted(["/privacy"] + SMOKE))

    def test_packs(self):
        p1 = sorted(["/app/keys", "/app/packs/p1/home", "/app/records/filings", "/admin/records/filings"] + SMOKE)
        self.assertEqual(chosen("packs/p1/pack.json")[0], p1, "a factory pack's manifest")
        self.assertEqual(chosen("packs/p1/files/packs/p1/pack.json")[0], p1, "a factory pack's files, read as the codebase's")
        self.assertEqual(chosen(MOLD + "packs/p1/pack.json")[0], p1, "a pack in the codebase")
        self.assertEqual(chosen(MOLD + "web/src/packs/octo/routes.json")[0], sorted(["/app/research", "/admin/research", "/research"] + SMOKE))
        c, notes, _ = chosen("packs/quiet/pack.json")
        self.assertEqual(c, SMOKE); self.assertTrue(any("no console page" in n for n in notes), "said, never silently dropped")
        self.assertEqual(chosen("packs/p1/files/web/src/components/x.tsx")[0], sorted(ALL), "a pack overriding shared code")

    def test_a_route_helper_follows_its_importers(self):
        f = MOLD + "web/src/app/app/keys/keys-table.tsx"
        own = lambda rel: ["web/src/app/app/keys/page.tsx"]
        shared = lambda rel: ["web/src/app/app/keys/page.tsx", "web/src/app/admin/keys/page.tsx"]
        self.assertEqual(chosen(f, importers=own)[0], sorted(["/app/keys"] + SMOKE))
        self.assertEqual(chosen(f, importers=shared)[0], sorted(ALL))
        self.assertEqual(chosen(f)[0], sorted(ALL), "no importer scan available: every page")

    def test_reasons_and_smoke(self):
        c, _, _ = pages.plan([MOLD + "web/src/app/app/keys/page.tsx"], PAGES, PACKS)
        self.assertIn("smoke (always graded)", c["/"])
        self.assertTrue(any("/app/keys changed" in r for r in c["/app/keys"]))
        no_admin = [p for p in PAGES if p["path"] != "/admin"]
        c2, _, _ = pages.plan(["docs/x.md"], no_admin, PACKS)
        self.assertEqual(sorted(c2), ["/", "/admin/keys"], "no /admin: the first admin page is the smoke")

    def test_several_changes_union(self):
        c, _, rules = chosen(MOLD + "web/src/app/app/keys/page.tsx", MOLD + "web/src/app/(site)/privacy/page.tsx", "docs/x.md")
        self.assertEqual(c, sorted(["/app/keys", "/privacy"] + SMOKE)); self.assertEqual(len(rules), 3)

    def test_importer_scan(self):
        t = tempfile.mkdtemp(prefix="lane-imp-test-")
        try:
            write(os.path.join(t, "web/src/app/app/keys/keys-table.tsx"), "export const T = 1")
            write(os.path.join(t, "web/src/app/app/keys/page.tsx"), "import { T } from './keys-table';")
            write(os.path.join(t, "web/src/app/admin/keys/page.tsx"), "import x from '@/app/admin/keys/other';")
            imp = pages.importers_in(t)
            self.assertEqual(imp("web/src/app/app/keys/keys-table.tsx"), ["web/src/app/app/keys/page.tsx"])
        finally:
            shutil.rmtree(t)

    def test_changed_files_from_git(self):
        t = tempfile.mkdtemp(prefix="lane-git-test-")
        try:
            g = lambda *a: subprocess.run(["git", "-C", t, *a], check=True, capture_output=True)
            g("init", "-q"); g("config", "user.email", "t@example.org"); g("config", "user.name", "t")
            write(os.path.join(t, "a.txt"), "1"); write(os.path.join(t, "b.txt"), "1"); g("add", "."); g("commit", "-qm", "base")
            base = subprocess.run(["git", "-C", t, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            write(os.path.join(t, "a.txt"), "2"); g("commit", "-qam", "change")
            write(os.path.join(t, "b.txt"), "2"); write(os.path.join(t, "c.txt"), "new")
            top, _, files = pages.changed_files(t, base)
            self.assertEqual(files, ["a.txt", "b.txt", "c.txt"], "committed, unstaged and untracked")
            with self.assertRaises(SystemExit): pages.changed_files(t, "no-such-ref")
        finally:
            shutil.rmtree(t)


if __name__ == "__main__":
    unittest.main(verbosity=1)
