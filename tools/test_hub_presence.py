import http.server
import json
import os
import subprocess
import sys
import threading
import unittest

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hub-presence.py")
TOKEN = "unit-test-token-0123456789abcdef-secret"


def run(args, **env):
    full = {k: v for k, v in os.environ.items() if not k.startswith("HUB_PRESENCE_")}
    full.update(env)
    return subprocess.run([sys.executable, TOOL] + args, capture_output=True, text=True, env=full, timeout=30)


BASE = ["working", "--owner", "max", "--agent", "claude", "--machine", "mac1"]


class QuietFail(unittest.TestCase):
    def test_unreachable_url_exit_zero_one_stderr_line_no_token(self):
        r = run(BASE + ["--quiet-fail"], HUB_PRESENCE_URL="http://127.0.0.1:1/hub/api/presence", HUB_PRESENCE_TOKEN=TOKEN)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(r.stderr.strip().splitlines()), 1)
        self.assertNotIn(TOKEN, r.stdout + r.stderr)

    def test_missing_env_quiet_is_zero_loud_is_nonzero(self):
        self.assertEqual(run(BASE + ["--quiet-fail"]).returncode, 0)
        loud = run(BASE)
        self.assertNotEqual(loud.returncode, 0)

    def test_bad_state_quiet_is_zero(self):
        r = run(["sleeping", "--owner", "max", "--agent", "c", "--quiet-fail"], HUB_PRESENCE_URL="http://127.0.0.1:1/", HUB_PRESENCE_TOKEN=TOKEN)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(r.stderr.strip().splitlines()), 1)

    def test_failure_without_quiet_does_not_print_token(self):
        r = run(BASE, HUB_PRESENCE_URL="http://127.0.0.1:1/x", HUB_PRESENCE_TOKEN=TOKEN)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn(TOKEN, r.stdout + r.stderr)


class Handler(http.server.BaseHTTPRequestHandler):
    seen = []
    user_agents = []
    status = 200

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        Handler.seen.append((self.headers.get("authorization"), self.headers.get("content-type"), json.loads(body)))
        Handler.user_agents.append(self.headers.get("user-agent"))
        self.send_response(Handler.status)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args):
        pass


class Wire(unittest.TestCase):
    def setUp(self):
        Handler.seen = []
        Handler.user_agents = []
        Handler.status = 200
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/hub/api/presence" % self.srv.server_port

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def test_sends_bearer_and_fields_and_prints_no_token(self):
        r = run(BASE + ["--card", "T-1", "--note", "hi"], HUB_PRESENCE_URL=self.url, HUB_PRESENCE_TOKEN=TOKEN)
        self.assertEqual(r.returncode, 0, r.stderr)
        auth, ctype, body = Handler.seen[0]
        self.assertEqual(auth, "Bearer " + TOKEN)
        self.assertEqual(ctype, "application/json")
        self.assertEqual(body, {"owner": "max", "agent": "claude", "machine": "mac1", "state": "working", "card": "T-1", "note": "hi"})
        self.assertNotIn(TOKEN, r.stdout + r.stderr)

    def test_env_defaults_and_optional_fields_omitted(self):
        r = run(["idle"], HUB_PRESENCE_URL=self.url, HUB_PRESENCE_TOKEN=TOKEN,
                HUB_PRESENCE_OWNER="dani", HUB_PRESENCE_AGENT="codex", HUB_PRESENCE_MACHINE="m2")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(Handler.seen[0][2], {"owner": "dani", "agent": "codex", "machine": "m2", "state": "idle"})

    def test_sends_explicit_user_agent_instead_of_python_urllib(self):
        r = run(BASE, HUB_PRESENCE_URL=self.url, HUB_PRESENCE_TOKEN=TOKEN)
        self.assertEqual(r.returncode, 0, r.stderr)
        user_agent = Handler.user_agents[0]
        self.assertEqual(user_agent, "hub-presence/1")
        self.assertFalse(user_agent.startswith("Python-urllib"))

    def test_server_error_quiet_fail_zero_loud_nonzero(self):
        Handler.status = 401
        q = run(BASE + ["--quiet-fail"], HUB_PRESENCE_URL=self.url, HUB_PRESENCE_TOKEN=TOKEN)
        self.assertEqual(q.returncode, 0)
        self.assertEqual(len(q.stderr.strip().splitlines()), 1)
        self.assertNotEqual(run(BASE, HUB_PRESENCE_URL=self.url, HUB_PRESENCE_TOKEN=TOKEN).returncode, 0)


if __name__ == "__main__":
    unittest.main()
