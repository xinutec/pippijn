//! Pure spatial-path resolution: given the flat set of a user's locations and
//! a leaf id, produce the root→leaf chain. This is what "highlight where the
//! searched item is" renders from — breadcrumb in 2D, node chain in the 3D
//! house. Kept pure (no DB) so it is unit-tested directly.

use std::collections::{HashMap, HashSet};

use super::types::Location;

/// The chain of locations from the topmost ancestor down to `leaf_id`,
/// inclusive. Empty if `leaf_id` is not in `locations`. Cycle-safe: a parent
/// link that loops back is cut rather than looping forever.
pub fn ancestor_path(locations: &[Location], leaf_id: u64) -> Vec<Location> {
    let by_id: HashMap<u64, &Location> = locations.iter().map(|l| (l.id, l)).collect();
    let mut chain: Vec<Location> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    let mut cursor = Some(leaf_id);
    while let Some(id) = cursor {
        if !seen.insert(id) {
            break; // cycle guard
        }
        let Some(loc) = by_id.get(&id) else { break };
        chain.push((*loc).clone());
        cursor = loc.parent_id;
    }
    chain.reverse();
    chain
}
