import argparse
import json
from pathlib import Path

from sgw_platform.acceptance import MilestoneVerifier


parser = argparse.ArgumentParser(description="Run the Step 5J backend acceptance gate.")
parser.add_argument(
    "--data",
    type=Path,
    default=Path(__file__).parents[1] / "data" / "synthetic_sgw.json",
)
parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
args = parser.parse_args()

report = MilestoneVerifier(args.data).verify()
if args.json:
    print(json.dumps(report.to_dict(), indent=2))
else:
    for check in report.checks:
        marker = "PASS" if check.passed else "FAIL"
        print(f"[{marker}] {check.label}\n       {check.detail}")
    print(f"\nBackend milestone: {'READY' if report.passed else 'NOT READY'}")

raise SystemExit(0 if report.passed else 1)
