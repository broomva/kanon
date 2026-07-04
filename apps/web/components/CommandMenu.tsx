"use client";

import { CornerDownLeft, LayoutGrid, List as ListIcon, MoonStar, Plus, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogIndex } from "../lib/catalog";
import { glassHeavyBlur } from "../lib/glass";
import type { IssueRecord } from "../lib/types";
import { StateDot } from "./primitives";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export interface CommandMenuProps {
  open: boolean;
  onClose: () => void;
  issues: IssueRecord[];
  cat: CatalogIndex;
  onSelectIssue: (ref: string) => void;
  onNew: () => void;
  onView: (view: "board" | "list") => void;
  onToggleTheme: () => void;
}

export function CommandMenu({
  open,
  onClose,
  issues,
  cat,
  onSelectIssue,
  onNew,
  onView,
  onToggleTheme,
}: CommandMenuProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after paint.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const actions: Command[] = [
      {
        id: "new",
        label: "New work",
        hint: "Create an issue",
        icon: <Plus size={16} />,
        run: onNew,
      },
      {
        id: "board",
        label: "Board view",
        icon: <LayoutGrid size={16} />,
        run: () => onView("board"),
      },
      { id: "list", label: "List view", icon: <ListIcon size={16} />, run: () => onView("list") },
      { id: "theme", label: "Toggle theme", icon: <MoonStar size={16} />, run: onToggleTheme },
    ];
    const q = query.trim().toLowerCase();
    const matches = issues
      .filter((issue) => {
        if (!q) return true;
        const ref = (issue.identifier ?? "").toLowerCase();
        const title = (issue.title ?? "").toLowerCase();
        return ref.includes(q) || title.includes(q);
      })
      .slice(0, 8)
      .map<Command>((issue) => {
        const ref = issue.identifier ?? issue.id;
        const state = cat.state(issue.stateId);
        return {
          id: `issue-${issue.id}`,
          label: issue.title ?? "Untitled",
          hint: ref,
          icon: <StateDot stateType={state?.stateType} />,
          run: () => onSelectIssue(ref),
        };
      });
    const filteredActions = q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
    return [...filteredActions, ...matches];
  }, [query, issues, cat, onNew, onView, onToggleTheme, onSelectIssue]);

  if (!open) return null;

  const clampedActive = Math.min(active, Math.max(commands.length - 1, 0));

  function pick(cmd: Command | undefined) {
    if (!cmd) return;
    cmd.run();
    onClose();
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-outside backdrop; Esc + selection are the accessible paths
    <div className="k-cmd-scrim bv-scrim" onMouseDown={onClose}>
      <div
        className="k-cmd bv-glass-heavy"
        style={glassHeavyBlur}
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, commands.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(commands[clampedActive]);
          }
        }}
      >
        <div className="k-cmd-search">
          <Search size={17} />
          <input
            ref={inputRef}
            className="k-cmd-input"
            placeholder="Search work or run a command…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <div className="k-cmd-list">
          {commands.length === 0 ? (
            <div className="k-cmd-empty">No matches</div>
          ) : (
            commands.map((cmd, i) => (
              <button
                key={cmd.id}
                type="button"
                className={`k-cmd-item${i === clampedActive ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(cmd)}
              >
                <span className="k-cmd-icon">{cmd.icon}</span>
                <span className="k-cmd-label">{cmd.label}</span>
                {cmd.hint ? <span className="k-cmd-hint">{cmd.hint}</span> : null}
                {i === clampedActive ? <CornerDownLeft size={14} className="k-cmd-enter" /> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
