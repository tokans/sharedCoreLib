#!/usr/bin/env python3
"""
outreach_mailmerge.py — Personalize one message template across many contacts.

Why this exists: community outreach, niche-blog pitches, and donor thank-yous all
work far better personalized — but doing it by hand is the reason people skip it.
This merges a CSV of contacts into a template with {placeholders} and writes one
ready-to-send draft per contact. You still review/send manually (good — it keeps
it human and avoids spammy behavior).

Usage:
  python outreach_mailmerge.py --contacts contacts.csv --template msg.txt --out drafts/

contacts.csv must have a header row; column names are the placeholders. Example:
  name,project,email
  Sam,SelfHostWeekly,sam@example.com

msg.txt example:
  Hi {name},
  I built an open-source tool and thought {project} readers might find it useful...

Tip: keep a 'name' or 'email' column so output files can be named sensibly.
"""
import argparse
import csv
import os
import re
import sys

PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")


def safe_name(row, idx):
    for key in ("name", "email", "project", "handle"):
        if row.get(key):
            return re.sub(r"[^\w.-]+", "_", row[key].strip())[:60]
    return f"contact_{idx}"


def main():
    ap = argparse.ArgumentParser(description="Personalize a template across a contacts CSV.")
    ap.add_argument("--contacts", required=True, help="CSV with a header row.")
    ap.add_argument("--template", required=True, help="Text file containing {placeholders}.")
    ap.add_argument("--out", default="drafts", help="Output directory for drafts.")
    ap.add_argument("--combined", help="Optional: also write all drafts into one .md file.")
    args = ap.parse_args()

    with open(args.template, encoding="utf-8") as f:
        template = f.read()
    needed = set(PLACEHOLDER_RE.findall(template))

    with open(args.contacts, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        contacts = list(reader)
        have = set(reader.fieldnames or [])

    missing = needed - have
    if missing:
        sys.exit(f"Template needs columns not in CSV: {', '.join(sorted(missing))}\n"
                 f"CSV has: {', '.join(sorted(have))}")

    os.makedirs(args.out, exist_ok=True)
    combined_parts = []
    for i, row in enumerate(contacts, 1):
        msg = template
        for key in needed:
            msg = msg.replace("{" + key + "}", (row.get(key) or "").strip())
        fname = f"{i:03d}_{safe_name(row, i)}.txt"
        with open(os.path.join(args.out, fname), "w", encoding="utf-8") as out:
            out.write(msg)
        combined_parts.append(f"### To: {safe_name(row, i)}\n\n{msg}\n\n---\n")

    print(f"Wrote {len(contacts)} drafts to {args.out}/")
    if args.combined:
        with open(args.combined, "w", encoding="utf-8") as f:
            f.write("\n".join(combined_parts))
        print(f"Also wrote combined file: {args.combined}")
    print("Review each draft before sending. Personalize the first line further where you can.")


if __name__ == "__main__":
    main()
