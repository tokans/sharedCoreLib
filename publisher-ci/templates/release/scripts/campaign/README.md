# Growth-campaign scripts

These four dependency-free (stdlib-only) Python scripts are vendored from the
**`growth-campaign-loop`** skill so the CI release pipeline and the human running the loop
share the same tooling:

| Script | Phase | What |
|---|---|---|
| `utm_builder.py` | Plan | tracked links per channel so traffic is attributable |
| `metrics_tracker.py` | Plan / Assess | append-only metrics log + trend report |
| `experiment_scorecard.py` | Assess | turn results into a verdict (double-down / iterate / cut) |
| `outreach_mailmerge.py` | Execute | personalize one template across a contacts CSV |

`scripts/launch-campaign.mjs` calls `utm_builder.py` + `metrics_tracker.py` on each publish
to seed `campaign/<version>/`. You run the rest (`experiment_scorecard.py`,
`outreach_mailmerge.py`) by hand during the `growth-campaign-loop` skill's Phases 3-5.

Run any with `-h` for usage, e.g. `python scripts/campaign/utm_builder.py -h`.
