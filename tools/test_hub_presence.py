import http.server
import importlib.util
import io
import json
import os
import subprocess
import sys
import threading
import unittest
from unittest import mock

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


class ListHandler(http.server.BaseHTTPRequestHandler):
    seen = []
    status = 200
    response = b"[]"

    def do_GET(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        ListHandler.seen.append({"method": self.command, "path": self.path,
                                 "authorization": self.headers.get("authorization"),
                                 "user_agent": self.headers.get("user-agent"), "body": body})
        self.send_response(ListHandler.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(ListHandler.response)

    def log_message(self, *args):
        pass


class ListWire(unittest.TestCase):
    def setUp(self):
        ListHandler.seen = []
        ListHandler.status = 200
        ListHandler.response = b"[]"
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), ListHandler)
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d/hub/api/presence" % self.srv.server_port

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.thread.join()

    def invoke(self, args, token=TOKEN):
        return run(args, HUB_PRESENCE_URL=self.url, HUB_PRESENCE_TOKEN=token, NO_PROXY="127.0.0.1")

    def assert_safe_failure(self, response, quiet=False):
        self.assertEqual(response.returncode, 0 if quiet else 1)
        self.assertEqual(response.stdout, "")
        self.assertEqual(len(response.stderr.strip().splitlines()), 1)
        self.assertTrue(response.stderr.startswith("hub-presence: "))
        self.assertNotIn(TOKEN, response.stderr)
        self.assertNotIn("SERVER_BODY_PRIVATE_NOTE", response.stderr)

    def test_list_uses_authenticated_bodyless_get_without_identity_and_prints_one_json_line(self):
        payload = [{"owner": "owner_unit", "agent": "agent_unit", "machine": "machine-unit",
                    "state": "working", "note": "Тестовая строка\nвнутри JSON", "stale": False}]
        ListHandler.response = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        result = self.invoke(["list"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertTrue(result.stdout.endswith("\n"))
        self.assertEqual(json.loads(result.stdout), payload)
        self.assertEqual(ListHandler.seen, [{"method": "GET", "path": "/hub/api/presence",
                         "authorization": "Bearer " + TOKEN, "user_agent": "hub-presence/1", "body": b""}])
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_empty_list_and_quiet_success_before_or_after_command_still_print_array(self):
        for args in [["list"], ["--quiet-fail", "list"], ["list", "--quiet-fail"]]:
            with self.subTest(args=args):
                result = self.invoke(args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertEqual(json.loads(result.stdout), [])
                self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertEqual(len(ListHandler.seen), 3)

    def test_malformed_json_nonarray_and_bad_utf8_fail_without_echoing_body(self):
        bodies = [b"SERVER_BODY_PRIVATE_NOTE invalid json", b"\xffSERVER_BODY_PRIVATE_NOTE",
                  b'{"note":"SERVER_BODY_PRIVATE_NOTE"}', b'"SERVER_BODY_PRIVATE_NOTE"', b"null", b"1"]
        for body in bodies:
            with self.subTest(body_kind=type(body).__name__, ordinal=len(ListHandler.seen)):
                ListHandler.response = body
                before_count = len(ListHandler.seen)
                result = self.invoke(["list"])
                self.assert_safe_failure(result)
                self.assertEqual(len(ListHandler.seen), before_count + 1, "Failure must come from the fetched response")

    def test_non200_fails_safely_and_preserves_quiet_flag_positions(self):
        for status, args, quiet in [(401, ["list"], False), (403, ["list"], False),
                                    (503, ["--quiet-fail", "list"], True), (500, ["list", "--quiet-fail"], True)]:
            with self.subTest(status=status, args=args):
                ListHandler.status = status
                ListHandler.response = ("SERVER_BODY_PRIVATE_NOTE " + TOKEN).encode("utf-8")
                before_count = len(ListHandler.seen)
                result = self.invoke(args)
                self.assert_safe_failure(result, quiet=quiet)
                self.assertIn("HTTP %d" % status, result.stderr)
                self.assertEqual(len(ListHandler.seen), before_count + 1)

    def test_decoded_token_in_nested_array_values_or_keys_is_not_printed(self):
        for payload in [[{"note": "prefix " + TOKEN + " suffix"}], [{TOKEN: "value"}], [[{"nested": TOKEN}]]]:
            with self.subTest(ordinal=len(ListHandler.seen)):
                ListHandler.response = json.dumps(payload).encode("utf-8")
                before_count = len(ListHandler.seen)
                result = self.invoke(["list"])
                self.assert_safe_failure(result)
                self.assertEqual(len(ListHandler.seen), before_count + 1)

    def test_escaped_wire_token_is_rejected_after_decoding_before_stdout(self):
        ListHandler.response = ('[{"note":"\\u0075' + TOKEN[1:] + '"}]').encode("utf-8")
        self.assertNotIn(TOKEN.encode("utf-8"), ListHandler.response)
        result = self.invoke(["list"])
        self.assert_safe_failure(result)
        self.assertEqual(len(ListHandler.seen), 1)

    def test_quoted_token_in_decoded_json_is_rejected_without_serialization_bypass(self):
        quoted_token = 'unit-test-"quoted\\token-0123456789abcdef'
        ListHandler.response = json.dumps([{"note": quoted_token}]).encode("utf-8")
        result = self.invoke(["list"], token=quoted_token)
        self.assert_safe_failure(result)
        self.assertNotIn(quoted_token, result.stdout + result.stderr)
        self.assertEqual(len(ListHandler.seen), 1)

    def test_malformed_response_quiet_failure_before_and_after_still_has_no_stdout(self):
        ListHandler.response = b"SERVER_BODY_PRIVATE_NOTE broken-json"
        for args in [["--quiet-fail", "list"], ["list", "--quiet-fail"]]:
            with self.subTest(args=args):
                before_count = len(ListHandler.seen)
                result = self.invoke(args)
                self.assert_safe_failure(result, quiet=True)
                self.assertEqual(len(ListHandler.seen), before_count + 1)


    def test_numeric_configured_token_in_serialized_array_is_never_printed(self):
        numeric_token = "12345678901234567890123456789012"
        ListHandler.response = json.dumps([int(numeric_token)]).encode("utf-8")
        result = self.invoke(["list"], token=numeric_token)
        self.assertEqual(len(ListHandler.seen), 1, "The numeric response must come from an observed GET")
        self.assertEqual(ListHandler.seen[0]["method"], "GET")
        self.assert_safe_failure(result)
        self.assertNotIn(numeric_token, result.stdout + result.stderr)


class ListUnit(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("hub_presence_under_test", TOOL)
        self.client = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.client)

    def call(self, args, env=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        configured = {"HUB_PRESENCE_URL": "https://presence.invalid/hub/api/presence", "HUB_PRESENCE_TOKEN": TOKEN}
        if env is not None:
            configured = env
        with mock.patch.dict(os.environ, configured, clear=True), mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", stderr):
            code = self.client.main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_get_uses_existing_timeout_and_headers_without_hostname_or_owner_lookup(self):
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b"[]"
        response.__enter__.return_value = response
        with mock.patch.object(self.client.urllib.request, "urlopen", return_value=response) as opener, \
                mock.patch.object(self.client.socket, "gethostname", side_effect=AssertionError("list does not need a machine")) as hostname:
            code, stdout, stderr = self.call(["list"])
            self.assertEqual(code, 0, stderr)
            self.assertEqual(json.loads(stdout), [])
            self.assertEqual(stderr, "")
            opener.assert_called_once()
            request = opener.call_args[0][0]
            self.assertEqual(opener.call_args[1], {"timeout": 5})
            self.assertEqual(request.get_method(), "GET")
            self.assertIsNone(request.data)
            self.assertEqual(request.get_header("Authorization"), "Bearer " + TOKEN)
            self.assertEqual(request.get_header("User-agent"), "hub-presence/1")
            hostname.assert_not_called()

    def test_transport_errors_are_safe_one_line_and_quiet_works_both_positions(self):
        dangerous = "SERVER_EXCEPTION_PRIVATE_NOTE " + TOKEN + "\nsecond line"
        errors = [self.client.urllib.error.URLError(dangerous), OSError(dangerous), ValueError(dangerous)]
        for error in errors:
            for args, expected in [(["list"], 1), (["--quiet-fail", "list"], 0), (["list", "--quiet-fail"], 0)]:
                with self.subTest(error=type(error).__name__, args=args):
                    with mock.patch.object(self.client.urllib.request, "urlopen", side_effect=error) as opener:
                        code, stdout, stderr = self.call(args)
                    self.assertEqual(code, expected)
                    self.assertEqual(stdout, "")
                    self.assertEqual(len(stderr.strip().splitlines()), 1)
                    self.assertNotIn(TOKEN, stderr)
                    self.assertNotIn("SERVER_EXCEPTION_PRIVATE_NOTE", stderr)
                    opener.assert_called_once()

    def test_list_requires_config_and_http_scheme_without_touching_transport(self):
        cases = [({}, "HUB_PRESENCE_URL"), ({"HUB_PRESENCE_URL": "https://presence.invalid/"}, "HUB_PRESENCE_TOKEN"),
                 ({"HUB_PRESENCE_URL": "file:///fixture", "HUB_PRESENCE_TOKEN": TOKEN}, "http(s)")]
        for env, expected_error in cases:
            for args, expected_exit in [(["list"], 1), (["--quiet-fail", "list"], 0), (["list", "--quiet-fail"], 0)]:
                with self.subTest(config=expected_error, args=args):
                    with mock.patch.object(self.client.urllib.request, "urlopen") as opener:
                        code, stdout, stderr = self.call(args, env=env)
                    self.assertEqual(code, expected_exit)
                    self.assertEqual(stdout, "")
                    self.assertEqual(len(stderr.strip().splitlines()), 1)
                    self.assertIn(expected_error, stderr)
                    self.assertNotIn(TOKEN, stderr)
                    opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
