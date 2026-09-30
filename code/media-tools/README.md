# media-tools

Local tools kept from the 2026-06-12 home→Nextcloud media migration. The
migration's upload and verification scripts, which went through rclone, are
removed now that it is finished.

- dedup-plan.py / dedup-apply.py — canonicalize case-variant folders and
  dedup files keeping the highest-quality copy (ffprobe bitrate/duration);
  ambiguous cases (duration differs >10s) flagged for manual review.
- audio-cmp.sh, audio-quality.sh — compare bitrate/quality of audio dupes.
- find-case-dups.sh — find case-duplicate paths.
