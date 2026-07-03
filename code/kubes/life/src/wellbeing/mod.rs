//! Wellbeing check-ins (a mental-health mood log). A *pure-sync* entity: there is
//! no typed REST surface — the on-device RxDB collection reconciles through
//! `/api/sync/wellbeing` (see `sync::repo`). This module holds only the
//! trash-restore path (the one deliberate undelete; sync pushes are set-only).

pub mod repo;
