import fuzzysort from "fuzzysort";

import {
  MENU,
  MENU_GROUP_LABELS,
  MENU_GROUP_ORDER,
  menuChildren,
  menuNodeById,
  menuRoots,
  type MenuNode,
} from "./menu-registry.js";
import type { TuiState } from "../tui-state.js";

/** A group heading. Rendered, never selectable. */
export interface MenuHeaderRow {
  readonly kind: "header";
  readonly label: string;
}

/** A selectable entry. */
export interface MenuItemRow {
  readonly kind: "item";
  readonly node: MenuNode;
  /** Live state for a destination, e.g. `3 scheduled`. Empty when unknown. */
  readonly status: string;
  /** Where the node lives, shown only while searching flattens the tree. */
  readonly crumb: string;
}

export type MenuRow = MenuHeaderRow | MenuItemRow;

/**
 * Rows the menu should render for the current state.
 *
 * Three modes, and the rule that decides between them is the whole design:
 * **hierarchy to browse, flat to search.** With a query, every node in the
 * registry competes on one ranked list and the tree is irrelevant; without
 * one, the operator walks groups and submenus.
 */
export function selectMenuRows(state: TuiState): readonly MenuRow[] {
  const query = state.menuQuery.trim();
  if (query.length > 0) return searchRows(state, query);
  if (state.menuPath !== null) return submenuRows(state, state.menuPath);
  return rootRows(state);
}

/** Only the selectable rows, in render order — the cursor indexes these. */
export function selectMenuItems(state: TuiState): readonly MenuItemRow[] {
  return selectMenuRows(state).flatMap((row) =>
    row.kind === "item" ? [row] : [],
  );
}

/** The row under the cursor, or `null` when the list is empty. */
export function selectMenuSelection(state: TuiState): MenuItemRow | null {
  const items = selectMenuItems(state);
  if (items.length === 0) return null;
  return items[clampMenuCursor(state, state.menuCursor)] ?? null;
}

/** Clamp a cursor into the current item list. */
export function clampMenuCursor(state: TuiState, cursor: number): number {
  const max = selectMenuItems(state).length - 1;
  if (max < 0) return 0;
  return Math.max(0, Math.min(cursor, max));
}

/** Title shown in the popup border — `Menu` or `Menu › Manage`. */
export function selectMenuTitle(state: TuiState): string {
  if (state.menuPath === null || state.menuQuery.trim().length > 0) {
    return "Menu";
  }
  const parent = menuNodeById(state.menuPath);
  return parent ? `Menu ${String.fromCodePoint(0x203a)} ${parent.label}` : "Menu";
}

function rootRows(state: TuiState): readonly MenuRow[] {
  const rows: MenuRow[] = [];
  for (const group of MENU_GROUP_ORDER) {
    const nodes = menuRoots(group);
    if (nodes.length === 0) continue;
    rows.push({ kind: "header", label: MENU_GROUP_LABELS[group] });
    for (const node of nodes) {
      rows.push(itemRow(state, node, ""));
    }
  }
  return rows;
}

function submenuRows(state: TuiState, parentId: string): readonly MenuRow[] {
  return menuChildren(parentId).map((node) => itemRow(state, node, ""));
}

function searchRows(state: TuiState, query: string): readonly MenuRow[] {
  // Submenus are excluded: "open the Manage submenu" is a browsing move, and
  // a search that already found `Privacy` should offer Privacy, not the
  // folder it happens to sit in.
  const candidates = MENU.filter((node) => node.kind !== "submenu");
  const scored = candidates
    .map((node, idx) => {
      const haystacks = [node.label, node.slash?.name ?? "", crumbFor(node)];
      const best = Math.max(
        ...haystacks.map(
          (h) => (h ? (fuzzysort.single(query, h)?.score ?? -Infinity) : -Infinity),
        ),
      );
      return { node, score: best, idx };
    })
    .filter(({ score }) => score > -Infinity)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const rows: MenuRow[] = [];
  for (const group of MENU_GROUP_ORDER) {
    const hits = scored.filter(({ node }) => node.group === group);
    if (hits.length === 0) continue;
    rows.push({ kind: "header", label: MENU_GROUP_LABELS[group] });
    for (const { node } of hits) {
      rows.push(itemRow(state, node, crumbFor(node)));
    }
  }
  return rows;
}

function crumbFor(node: MenuNode): string {
  if (node.parent === undefined) return "";
  return menuNodeById(node.parent)?.label ?? "";
}

function itemRow(state: TuiState, node: MenuNode, crumb: string): MenuItemRow {
  return { kind: "item", node, status: statusFor(state, node), crumb };
}

/**
 * Live one-liner for a destination. Deliberately reads the same state slices
 * the sub-tab strip already counts (`debug-pane.tsx`), so opening the menu
 * costs a few array lengths and never a refresh.
 */
function statusFor(state: TuiState, node: MenuNode): string {
  switch (node.id) {
    case "go.manage.tasks":
      return countLabel(state.tasksPanel.rows.length, "task");
    case "go.manage.skills":
      return countLabel(state.skillsPanel.rows.length, "skill");
    case "go.manage.memory":
      return countLabel(state.memoryPanel.rows.length, "note");
    case "go.manage.mcp":
      return countLabel(state.mcpPanel.rows.length, "server");
    case "go.observe.feed":
      return countLabel(state.feed.length, "event");
    case "go.observe.reasoning":
      return countLabel(state.reasoning.length, "entry");
    case "go.observe.logs":
      return countLabel(state.logs.length, "line");
    case "go.run":
      return countLabel(state.messages.length, "message");
    case "session.switch":
      return countLabel(state.recentSessions.length, "recent");
    default:
      return "";
  }
}

function countLabel(count: number, noun: string): string {
  if (count === 0) return "";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
