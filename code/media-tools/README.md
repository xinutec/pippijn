# media-tools

Scripts written 2026-06-12 during the home→Nextcloud media reclamation
(amun/isis home Music/Photos/Videos/media/Documents were migrated to NC and
the redundant local copies removed after byte-level verification).

- dedup-plan.py / dedup-apply.py — canonicalize case-variant folders and
  dedup files keeping the highest-quality copy (ffprobe bitrate/duration);
  ambiguous cases (duration differs >10s) flagged for manual review.
- hash-verify.sh, nc-containment.sh, nc-containment2.sh, verify-media.sh,
  media-check.sh, music-check.sh — confirm every local file's content is on
  NC (by hash; NC serves SHA1 via rclone hashsum for checksummed files).
- photo-divergence.sh, photo-classify.py — analyse local-vs-NC photo
  differences (metadata vs real pixel difference, resolution).
- audio-cmp.sh, audio-quality.sh — compare bitrate/quality of audio dupes.
- media-to-nc.sh, nc-sync.sh, archive-upload.sh, find-case-dups.sh — upload
  / sync / case-duplicate helpers.

Run-output logs from that session remain in ~/ (regenerable, not committed).
