#!/usr/bin/env python3
"""Analiza dependencias entre workspaces npm del monorepo galaxIA.

Uso: python3 helpers/scripts/python/workspace-deps.py [--dot]
  --dot  genera salida en formato DOT (Graphviz)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def read_package(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def find_workspaces(root_pkg: dict, root_dir: Path) -> list[dict]:
    workspaces = []
    for pattern in root_pkg.get("workspaces", []):
        for pkg_json in sorted(root_dir.glob(f"{pattern}/package.json")):
            workspaces.append(read_package(pkg_json))
    return workspaces


def resolve_deps(workspaces: list[dict]) -> dict[str, list[str]]:
    ws_names = {w["name"] for w in workspaces}
    graph: dict[str, list[str]] = {}
    for w in workspaces:
        name = w["name"]
        deps = set(w.get("dependencies", {}).keys()) | set(
            w.get("devDependencies", {}).keys()
        )
        graph[name] = sorted(d for d in deps if d in ws_names)
    return graph


def build_order(graph: dict[str, list[str]]) -> list[str]:
    visited: set[str] = set()
    order: list[str] = []

    def visit(name: str):
        if name not in visited:
            visited.add(name)
            for dep in graph.get(name, []):
                visit(dep)
            order.append(name)

    for name in graph:
        visit(name)
    return order


def main():
    dot_mode = "--dot" in sys.argv

    root_pkg = read_package(ROOT / "package.json")
    workspaces = find_workspaces(root_pkg, ROOT)
    graph = resolve_deps(workspaces)
    order = build_order(graph)

    if dot_mode:
        print("digraph workspaces {")
        print("  rankdir=LR;")
        for name, deps in graph.items():
            short = name.replace("@galaxia/", "")
            print(f'  "{short}";')
            for dep in deps:
                dep_short = dep.replace("@galaxia/", "")
                print(f'  "{dep_short}" -> "{short}";')
        print("}")
        return

    print("Orden de build correcto:")
    for i, name in enumerate(order, 1):
        deps = graph.get(name, [])
        dep_str = f"  ← {', '.join(d.replace('@galaxia/', '') for d in deps)}" if deps else ""
        print(f"  {i}. {name.replace('@galaxia/', '')}{dep_str}")


if __name__ == "__main__":
    main()
