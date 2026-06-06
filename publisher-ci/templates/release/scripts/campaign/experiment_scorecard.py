#!/usr/bin/env python3
"""
experiment_scorecard.py — Turn raw results into a verdict and a next move.

Why this exists: the "improve" step fails when people stare at numbers and argue.
This gives a clear read: did the experiment hit its target, how big was the lift
vs baseline, and (for conversion tests) is an observed difference likely real or
just noise? It ends with a recommendation: double down / iterate / cut.

Two modes:

1) Target check (any metric):
   python experiment_scorecard.py target \
       --metric "weekly signups" --actual 41 --target 30 --baseline 18

2) Conversion A/B (two variants, e.g. two landing-page headlines):
   python experiment_scorecard.py ab \
       --a-conversions 12 --a-total 400 \
       --b-conversions 25 --b-total 410
"""
import argparse
import math


def normal_cdf(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def cmd_target(args):
    actual, target = args.actual, args.target
    hit = actual >= target
    pct_of_target = (actual / target * 100) if target else float("inf")
    print("\n=== Experiment scorecard: target check ===")
    print(f"Metric:   {args.metric}")
    print(f"Target:   {target:g}")
    print(f"Actual:   {actual:g}  ({pct_of_target:.0f}% of target)")
    if args.baseline is not None and args.baseline != 0:
        lift = (actual - args.baseline) / args.baseline * 100
        print(f"Baseline: {args.baseline:g}  ->  lift {lift:+.0f}%")
    print()
    if hit:
        print("VERDICT: Target met.")
        print("RECOMMEND: Double down. Repeat what worked, increase volume/frequency,")
        print("and raise the next target ~20-50%. Document why it worked before scaling.")
    elif pct_of_target >= 70:
        print("VERDICT: Close miss (>=70% of target).")
        print("RECOMMEND: Iterate, don't abandon. Change ONE variable (the message, the")
        print("channel, or the offer), keep the rest fixed, and re-run before judging.")
    else:
        print("VERDICT: Missed badly (<70% of target).")
        print("RECOMMEND: Before cutting, separate the two possible causes — they need")
        print("opposite responses:")
        print("  (a) The TARGET was too high. If per-channel conversion is healthy and the")
        print("      shortfall is just volume/reach, keep the approach and reset the target")
        print("      to something grounded in your baseline.")
        print("  (b) The CHANNEL is a poor fit. If conversion itself is weak across the")
        print("      board, reallocate effort to your next-best hypothesis.")
        print("Check per-channel conversion (e.g. with the 'ab' mode) to tell which it is.")
    print()


def cmd_ab(args):
    ca, na = args.a_conversions, args.a_total
    cb, nb = args.b_conversions, args.b_total
    pa, pb = ca / na, cb / nb
    # Two-proportion z-test (pooled).
    p_pool = (ca + cb) / (na + nb)
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / na + 1 / nb))
    z = (pb - pa) / se if se > 0 else 0.0
    p_value = 2 * (1 - normal_cdf(abs(z)))

    print("\n=== Experiment scorecard: A/B conversion ===")
    print(f"Variant A: {ca}/{na} = {pa*100:.2f}%")
    print(f"Variant B: {cb}/{nb} = {pb*100:.2f}%")
    rel = ((pb - pa) / pa * 100) if pa else float("inf")
    print(f"Difference: {(pb-pa)*100:+.2f} pts  ({rel:+.0f}% relative)")
    print(f"p-value: {p_value:.3f}")
    print()
    winner = "B" if pb > pa else "A"
    if p_value < 0.05:
        print(f"VERDICT: Variant {winner} wins (statistically significant at p<0.05).")
        print(f"RECOMMEND: Ship variant {winner} and make it the new baseline.")
    elif min(na, nb) < 100:
        print("VERDICT: Not enough data yet.")
        print("RECOMMEND: Keep both running. With under ~100 per variant, results swing")
        print("wildly. Re-check once each side has a few hundred exposures.")
    else:
        print("VERDICT: No clear winner (difference is within the range of noise).")
        print("RECOMMEND: Treat them as equivalent. Pick the simpler one and test a")
        print("bolder, more different variant next — small tweaks rarely move the needle.")
    print()


def main():
    ap = argparse.ArgumentParser(description="Score an experiment and get a recommendation.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    t = sub.add_parser("target", help="Check a metric against a target.")
    t.add_argument("--metric", default="metric")
    t.add_argument("--actual", type=float, required=True)
    t.add_argument("--target", type=float, required=True)
    t.add_argument("--baseline", type=float, default=None)
    t.set_defaults(func=cmd_target)

    a = sub.add_parser("ab", help="Two-variant conversion test.")
    a.add_argument("--a-conversions", type=int, required=True)
    a.add_argument("--a-total", type=int, required=True)
    a.add_argument("--b-conversions", type=int, required=True)
    a.add_argument("--b-total", type=int, required=True)
    a.set_defaults(func=cmd_ab)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
