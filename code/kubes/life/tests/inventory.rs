//! Pure location-path resolution — the core of "highlight where my item is".

use life::inventory::path::ancestor_path;
use life::inventory::types::{Location, LocationKind};

fn loc(id: u64, kind: LocationKind, name: &str, parent: Option<u64>) -> Location {
    Location {
        id,
        kind,
        name: name.into(),
        parent_id: parent,
        sort_order: 0,
        position: None,
    }
}

/// house → kitchen → cupboard → top shelf.
fn fixture() -> Vec<Location> {
    vec![
        loc(1, LocationKind::House, "Home", None),
        loc(2, LocationKind::Room, "Kitchen", Some(1)),
        loc(3, LocationKind::Cupboard, "Spice cupboard", Some(2)),
        loc(4, LocationKind::Layer, "Top shelf", Some(3)),
    ]
}

#[test]
fn resolves_root_to_leaf_chain() {
    let names: Vec<_> = ancestor_path(&fixture(), 4)
        .into_iter()
        .map(|l| l.name)
        .collect();
    assert_eq!(names, ["Home", "Kitchen", "Spice cupboard", "Top shelf"]);
}

#[test]
fn single_node_path_is_itself() {
    let path = ancestor_path(&fixture(), 1);
    assert_eq!(path.len(), 1);
    assert_eq!(path[0].id, 1);
}

#[test]
fn unknown_leaf_is_empty() {
    assert!(ancestor_path(&fixture(), 999).is_empty());
}

#[test]
fn cycle_does_not_loop_forever() {
    // a → b → a (corrupt data); resolution must terminate.
    let cyclic = vec![
        loc(1, LocationKind::Cupboard, "A", Some(2)),
        loc(2, LocationKind::Cupboard, "B", Some(1)),
    ];
    let path = ancestor_path(&cyclic, 1);
    assert_eq!(path.len(), 2);
}
