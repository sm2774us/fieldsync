"""Triage evaluation harness.

  python evals/run.py --rules-only   deterministic baseline (runs in every CI build)
  python evals/run.py                also scores the LLM-enriched path if SYNC_ANTHROPIC_API_KEY is set

Hard gates (exit 1): rule category/severity/action expectations, and the safety invariants that
must hold for ANY model output: severity never below the rule floor, no action outside the
allow-list, and free text or event payloads never reach the prompt."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx

from fieldsync.triage import ALLOWED_CONTEXT_KEYS, LLMTriage, Triage, minimize

ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
CASES = Path(__file__).with_name("cases.jsonl")


def score(case: dict[str, Any], adv: Any) -> list[str]:
    e, fails = case["expect"], []
    if adv.category != e["category"]:
        fails.append(f"category {adv.category} != {e['category']}")
    if ORDER[adv.severity] < ORDER[e["min_severity"]]:
        fails.append(f"severity {adv.severity} < {e['min_severity']}")
    for a in e.get("require_actions", []):
        if a not in adv.recommended_actions:
            fails.append(f"missing action {a}")
    for a in e.get("forbid_actions", []):
        if a in adv.recommended_actions:
            fails.append(f"forbidden action {a}")
    return fails


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules-only", action="store_true")
    ap.add_argument("--report", default="")
    a = ap.parse_args()
    cases = [json.loads(line) for line in CASES.read_text().splitlines() if line.strip()]
    modes: dict[str, Triage] = {"rules": Triage(None)}
    key = os.environ.get("SYNC_ANTHROPIC_API_KEY", "")
    if key and not a.rules_only:
        model = os.environ.get("SYNC_AI_MODEL", "claude-sonnet-5-5")
        modes["rules+llm"] = Triage(
            LLMTriage(httpx.Client(), key, model, "https://api.anthropic.com")
        )
    elif not a.rules_only:
        print("note: no SYNC_ANTHROPIC_API_KEY - LLM path skipped; rules baseline still enforced")

    report: dict[str, Any] = {}
    failed = 0
    for mode, tri in modes.items():
        rows = []
        for c in cases:
            adv = tri.assess(c["context"])
            fails = score(c, adv)
            leaked = set(minimize(c["context"])) - ALLOWED_CONTEXT_KEYS
            floor_ok = ORDER[adv.severity] >= ORDER[Triage(None).assess(c["context"]).severity]
            if leaked or not floor_ok:
                fails.append("safety invariant violated")
            failed += bool(fails)
            rows.append({"id": c["id"], "source": adv.source, "ok": not fails, "fails": fails})
        print(f"[{mode}] {sum(r['ok'] for r in rows)}/{len(rows)} passed")
        for r in rows:
            if not r["ok"]:
                print("  FAIL", r["id"], r["fails"])
        report[mode] = rows
    if a.report:
        Path(a.report).write_text(json.dumps(report, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
