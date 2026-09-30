"""Admin CLI: `fieldsync-admin init | issue-token | verify-audit | demo | seed`."""

from __future__ import annotations

import argparse
import secrets
import sys
import time

from .auth import Role, issue_token
from .config import Settings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fieldsync-admin")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help="print fresh secrets as .env lines")
    t = sub.add_parser("issue-token", help="issue a bearer token (dev)")
    t.add_argument("--sub", required=True)
    t.add_argument("--role", required=True, choices=[r.value for r in Role])
    t.add_argument("--agency", default="agency-1")
    t.add_argument("--ttl", type=int, default=900)
    sub.add_parser("verify-audit", help="verify the audit chain of the local database")
    sub.add_parser("demo", help="run the end-to-end scenario in-process")
    sd = sub.add_parser("seed", help="DEV ONLY: run the scenario against a running server")
    sd.add_argument("--url", default="http://localhost:8080")
    sd.add_argument(
        "--leave-open",
        action="store_true",
        help="leave the conflict and quarantine for hands-on review",
    )
    a = ap.parse_args(argv)
    if a.cmd == "init":
        print(
            f"SYNC_SIGNING_KEY={secrets.token_hex(32)}\nSYNC_TOKEN_SECRET={secrets.token_hex(32)}"
        )
        return 0
    s = Settings.from_env()
    if a.cmd == "issue-token":
        if not s.token_secret:
            print("SYNC_TOKEN_SECRET is not set", file=sys.stderr)
            return 2
        print(
            issue_token(
                s.token_secret, a.sub, Role(a.role), a.agency, int(time.time() * 1000), a.ttl
            )
        )
        return 0
    if a.cmd == "verify-audit":
        from .app import build_service

        st = build_service(s.with_dev_secrets()).audit.verify()
        print(f"ok={st.ok} entries={st.entries} error={st.error}")
        return 0 if st.ok else 1
    from .simulate import run_scenario

    if a.cmd == "seed":
        import httpx

        if not s.token_secret:
            print("SYNC_TOKEN_SECRET is not set; use the same .env as the server.", file=sys.stderr)
            return 2
        with httpx.Client(base_url=a.url, timeout=30) as http:
            run_scenario(http, s.token_secret, resolve=not a.leave_open)
        return 0
    import tempfile
    from pathlib import Path

    from fastapi.testclient import TestClient

    from .app import create_app

    st2 = Settings(data_dir=Path(tempfile.mkdtemp())).with_dev_secrets()
    with TestClient(create_app(st2)) as http:
        run_scenario(http, st2.token_secret)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
