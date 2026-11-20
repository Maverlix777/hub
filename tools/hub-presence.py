#!/usr/bin/env python3
"""Report agent activity or list the hub presence board.

Usage: hub-presence.py <state> [--card ..] [--note ..] [--agent ..] [--owner ..] [--machine ..] [--quiet-fail]
       hub-presence.py list [--quiet-fail]

HUB_PRESENCE_URL and HUB_PRESENCE_TOKEN are required. HUB_PRESENCE_OWNER / _AGENT / _MACHINE
may stand in for the flags. The token is never printed.
"""
import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request

STATES = ("working", "idle", "blocked", "done")
USER_AGENT = "hub-presence/1"


class Fail(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Fail("bad arguments: " + message.splitlines()[0])


def build_parser():
    p = Parser(description="Report agent presence or list the hub presence board.")
    p.add_argument("state", choices=STATES + ("list",))
    p.add_argument("--card")
    p.add_argument("--note")
    p.add_argument("--agent")
    p.add_argument("--owner")
    p.add_argument("--machine")
    p.add_argument("--quiet-fail", action="store_true", help="always exit 0; one line on stderr on error")
    return p


def response_contains_token(value, token):
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            if token in item:
                return True
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
    return False


def send(args):
    url = os.environ.get("HUB_PRESENCE_URL", "")
    token = os.environ.get("HUB_PRESENCE_TOKEN", "")
    if not url:
        raise Fail("HUB_PRESENCE_URL is not set")
    if not token:
        raise Fail("HUB_PRESENCE_TOKEN is not set")
    if not url.startswith(("https://", "http://")):
        raise Fail("HUB_PRESENCE_URL must be http(s)")
    headers = {"Authorization": "Bearer " + token, "User-Agent": USER_AGENT}
    if args.state == "list":
        req = urllib.request.Request(url, method="GET", headers=headers)
    else:
        owner = args.owner or os.environ.get("HUB_PRESENCE_OWNER")
        agent = args.agent or os.environ.get("HUB_PRESENCE_AGENT")
        machine = args.machine or os.environ.get("HUB_PRESENCE_MACHINE") or socket.gethostname()
        if not owner or not agent:
            raise Fail("owner and agent are required (flags or HUB_PRESENCE_OWNER / HUB_PRESENCE_AGENT)")
        body = {"owner": owner, "agent": agent, "machine": machine, "state": args.state}
        if args.card:
            body["card"] = args.card
        if args.note:
            body["note"] = args.note
        headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                raise Fail("hub answered HTTP %d" % resp.status)
            if args.state == "list":
                rows = json.loads(resp.read())
                if not isinstance(rows, list):
                    raise Fail("hub returned a non-array response")
                if response_contains_token(rows, token):
                    raise Fail("hub returned an unsafe response")
                output = json.dumps(rows, ensure_ascii=False, allow_nan=False)
                if token in output:
                    raise Fail("hub returned an unsafe response")
                print(output)
    except urllib.error.HTTPError as e:
        raise Fail("hub answered HTTP %d" % e.code)
    except (urllib.error.URLError, OSError, ValueError, RecursionError) as e:
        # Only the exception class is shown: messages may echo the request.
        raise Fail("request failed (%s)" % type(e).__name__)


def main(argv=None):
    quiet = "--quiet-fail" in (sys.argv[1:] if argv is None else argv)
    try:
        send(build_parser().parse_args(argv))
    except Fail as e:
        print("hub-presence: %s" % e, file=sys.stderr)
        return 0 if quiet else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
