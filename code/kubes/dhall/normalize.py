#!/usr/bin/env python3
"""Canonicalise Kubernetes YAML on stdin so two renderings can be compared.

Dhall emits record fields in alphabetical order and quotes scalars more eagerly
than a human does, neither of which changes what the cluster sees. Comparing
manifests textually would therefore drown the real drift in noise, so
`generate.sh --check` compares this canonical form instead: documents sorted by
(kind, namespace, name), keys sorted, one JSON line per key.
"""

import json
import sys

import yaml


def sort_key(doc: dict) -> tuple[str, str, str]:
    meta = doc.get("metadata") or {}
    return (doc.get("kind", ""), meta.get("namespace", ""), meta.get("name", ""))


def main() -> None:
    docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
    for doc in sorted(docs, key=sort_key):
        print(json.dumps(doc, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
