# health-sync — Documentation

This directory holds documentation for the health-sync service
(Fitbit sync + Owntracks/PhoneTrack proxy + "Your Day" dashboard
at health.xinutec.org).

## Layout

```
docs/
├── README.md                  ← you are here
├── design/                    System-as-shipped: current architecture
│   ├── overview.md              Top-level architecture diagram + module map
│   └── timezone.md              Per-row tz handling rules and rationale
├── proposals/                 Design proposals (active work)
│   ├── README.md                Index + status of each proposal
│   └── 2026-05-scored-classification.md
│                                Incremental factor-decomposed
│                                classification + commute prior
└── archive/                   Superseded or paused proposals
                               [GITIGNORED — local-only, per
                               .gitignore line 4. Active proposals
                               that reference archive docs (e.g.
                               2026-05 references 2025-model-hmm.md)
                               must remain understandable WITHOUT
                               the archive — the link is "see also
                               my local notes," not load-bearing.]
```

## Reading order for a new contributor

1. `design/overview.md` — what the system is.
2. `design/timezone.md` — the one cross-cutting concern that bites if missed.
3. `proposals/README.md` — what we're considering changing.
4. Specific proposal docs as needed.

Archived proposals are kept for context — `archive/2025-model-hmm.md` is
explicitly referenced by the active 2026-05 roadmap. They should be
read only after the active proposal that supersedes/pauses them.

## Status conventions

Every proposal carries a YAML frontmatter block with:

- `status:` — `active` | `paused` | `superseded`
- `superseded-by:` — relative path to the doc that replaces this one (if status is superseded)
- `paused-reason:` — why work stopped (if status is paused)
- `created:` — YYYY-MM-DD
- `updated:` — YYYY-MM-DD

Move a doc between `proposals/` and `archive/` when its status changes —
the directory location and the frontmatter `status` must agree.

## Code-level docs

In-source design lives next to the code as comments and JSDoc. This
directory is for cross-cutting docs that span multiple files or that
describe planned work not yet in the code. Don't duplicate; link.
