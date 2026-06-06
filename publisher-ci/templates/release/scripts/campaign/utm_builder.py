#!/usr/bin/env python3
"""
utm_builder.py — Generate UTM-tagged links so every channel's traffic is attributable.

Why this exists: with no ad budget, the ONLY way to know which community post or
content piece actually sent people your way is to tag the links. Free analytics
(Plausible, GA, Umami, even server logs) can then split traffic by source/medium.

Usage:
  # Use a sensible default channel set:
  python utm_builder.py --base-url https://myapp.org --campaign launch_v2

  # Custom channels (repeatable): --channel source,medium[,content]
  python utm_builder.py --base-url https://myapp.org --campaign launch_v2 \
      --channel reddit,community,r_selfhosted \
      --channel hackernews,community,show_hn \
      --channel newsletter,email,feb_issue

  # Write a CSV too:
  python utm_builder.py --base-url https://myapp.org --campaign launch_v2 --csv links.csv

Output: a Markdown table (stdout) and optionally a CSV. Paste each link into the
matching channel so your analytics can tell them apart.
"""
import argparse
import csv
import sys
from urllib.parse import urlencode, urlparse, urlunparse, parse_qsl

DEFAULT_CHANNELS = [
    ("reddit", "community", ""),
    ("hackernews", "community", "show_hn"),
    ("producthunt", "referral", ""),
    ("twitter", "social", ""),
    ("mastodon", "social", ""),
    ("newsletter", "email", ""),
    ("github", "referral", "readme"),
    ("blog", "content", ""),
]


def build_url(base_url, campaign, source, medium, content):
    parts = urlparse(base_url)
    query = dict(parse_qsl(parts.query))
    query["utm_source"] = source
    query["utm_medium"] = medium
    query["utm_campaign"] = campaign
    if content:
        query["utm_content"] = content
    new_query = urlencode(query)
    return urlunparse((parts.scheme, parts.netloc, parts.path, parts.params, new_query, parts.fragment))


def parse_channel(spec):
    bits = [b.strip() for b in spec.split(",")]
    source = bits[0]
    medium = bits[1] if len(bits) > 1 and bits[1] else "referral"
    content = bits[2] if len(bits) > 2 else ""
    return source, medium, content


def main():
    ap = argparse.ArgumentParser(description="Build UTM-tagged links for attribution.")
    ap.add_argument("--base-url", required=True, help="The URL people should land on, e.g. https://myapp.org")
    ap.add_argument("--campaign", required=True, help="Campaign slug, e.g. launch_v2 (keep it consistent)")
    ap.add_argument("--channel", action="append", default=[],
                    help="source,medium[,content] — repeatable. If omitted, a default set is used.")
    ap.add_argument("--csv", help="Optional path to also write a CSV.")
    args = ap.parse_args()

    if not args.base_url.startswith(("http://", "https://")):
        sys.exit("base-url must start with http:// or https://")

    channels = [parse_channel(c) for c in args.channel] if args.channel else DEFAULT_CHANNELS

    rows = []
    for source, medium, content in channels:
        url = build_url(args.base_url, args.campaign, source, medium, content)
        rows.append({"source": source, "medium": medium, "content": content, "url": url})

    # Markdown table
    print(f"\nTracked links for campaign: {args.campaign}\n")
    print("| source | medium | content | link |")
    print("|---|---|---|---|")
    for r in rows:
        print(f"| {r['source']} | {r['medium']} | {r['content'] or '—'} | {r['url']} |")
    print()

    if args.csv:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["source", "medium", "content", "url"])
            w.writeheader()
            w.writerows(rows)
        print(f"Wrote {len(rows)} links to {args.csv}")


if __name__ == "__main__":
    main()
