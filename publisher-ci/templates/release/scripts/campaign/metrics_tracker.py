#!/usr/bin/env python3
"""
metrics_tracker.py — A dead-simple, dependency-free metrics log + trend report.

Why this exists: improvement is impossible without a baseline and a record. This
keeps an append-only CSV of whatever numbers matter for the campaign (signups,
visitors, stars, donations, replies...) and prints a report showing the latest
value, the change since last entry, and the change since you started.

Usage:
  # Log an entry (date defaults to today). Pass any metric as key=value:
  python metrics_tracker.py log --file metrics.csv visitors=320 signups=14 donations=2

  # Log for a specific date:
  python metrics_tracker.py log --file metrics.csv --date 2026-06-01 visitors=210 signups=9

  # Show the trend report:
  python metrics_tracker.py report --file metrics.csv

The CSV is human-readable and editable; columns grow automatically as you add new
metrics. Keep entries at a consistent cadence (daily or weekly) for clean trends.
"""
import argparse
import csv
import os
import sys
from datetime import date


def read_rows(path):
    if not os.path.exists(path):
        return [], []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        cols = reader.fieldnames or []
    return rows, cols


def write_rows(path, rows, cols):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in cols})


def cmd_log(args):
    rows, cols = read_rows(args.file)
    entry = {"date": args.date or date.today().isoformat()}
    for kv in args.metrics:
        if "=" not in kv:
            sys.exit(f"Bad metric '{kv}'. Use key=value, e.g. signups=14")
        k, v = kv.split("=", 1)
        entry[k.strip()] = v.strip()

    # Union of columns, date first.
    cols = list(dict.fromkeys(["date"] + cols + list(entry.keys())))
    rows.append(entry)
    rows.sort(key=lambda r: r.get("date", ""))
    write_rows(args.file, rows, cols)
    print(f"Logged entry for {entry['date']}: " +
          ", ".join(f"{k}={v}" for k, v in entry.items() if k != "date"))


def _to_num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def cmd_report(args):
    rows, cols = read_rows(args.file)
    if not rows:
        sys.exit(f"No data in {args.file} yet. Log some entries first.")
    metrics = [c for c in cols if c != "date"]
    first, last = rows[0], rows[-1]
    prev = rows[-2] if len(rows) > 1 else None

    print(f"\nMetrics report — {args.file}")
    print(f"Entries: {len(rows)}  ({first['date']} → {last['date']})\n")
    header = f"{'metric':<16}{'latest':>12}{'vs prev':>14}{'vs start':>16}"
    print(header)
    print("-" * len(header))
    for m in metrics:
        cur = _to_num(last.get(m))
        if cur is None:
            print(f"{m:<16}{str(last.get(m,'')):>12}{'—':>14}{'—':>16}")
            continue
        # vs previous
        if prev and _to_num(prev.get(m)) is not None:
            p = _to_num(prev.get(m))
            d = cur - p
            pct = (d / p * 100) if p else float("inf")
            vs_prev = f"{d:+.0f} ({pct:+.0f}%)" if p else f"{d:+.0f}"
        else:
            vs_prev = "—"
        # vs start
        s = _to_num(first.get(m))
        if s is not None:
            d0 = cur - s
            pct0 = (d0 / s * 100) if s else float("inf")
            vs_start = f"{d0:+.0f} ({pct0:+.0f}%)" if s else f"{d0:+.0f}"
        else:
            vs_start = "—"
        print(f"{m:<16}{cur:>12.0f}{vs_prev:>14}{vs_start:>16}")
    print()


def main():
    ap = argparse.ArgumentParser(description="Log and report campaign metrics.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    lg = sub.add_parser("log", help="Append a metrics entry.")
    lg.add_argument("--file", required=True)
    lg.add_argument("--date", help="YYYY-MM-DD (default: today)")
    lg.add_argument("metrics", nargs="+", help="key=value pairs, e.g. visitors=320 signups=14")
    lg.set_defaults(func=cmd_log)

    rp = sub.add_parser("report", help="Print a trend report.")
    rp.add_argument("--file", required=True)
    rp.set_defaults(func=cmd_report)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
