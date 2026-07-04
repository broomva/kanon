import { LayoutGrid, List as ListIcon, Moon, Plus, Search, Sun } from "lucide-react";

export type View = "board" | "list";

export interface HeaderProps {
  view: View;
  onView: (view: View) => void;
  query: string;
  onQuery: (q: string) => void;
  onNew: () => void;
  onOpenCommand: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

export function Header({
  view,
  onView,
  query,
  onQuery,
  onNew,
  onOpenCommand,
  theme,
  onToggleTheme,
}: HeaderProps) {
  return (
    <header className="k-header">
      <div className="k-seg" role="tablist" aria-label="View">
        <button
          type="button"
          role="tab"
          aria-selected={view === "board"}
          className={`k-seg-btn${view === "board" ? " is-active" : ""}`}
          onClick={() => onView("board")}
        >
          <LayoutGrid size={15} />
          Board
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "list"}
          className={`k-seg-btn${view === "list" ? " is-active" : ""}`}
          onClick={() => onView("list")}
        >
          <ListIcon size={15} />
          List
        </button>
      </div>

      <div className="k-header-spacer" />

      <label className="k-search">
        <Search size={15} />
        <input
          className="k-search-input"
          placeholder="Search work…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>

      <button type="button" className="k-cmdk" onClick={onOpenCommand} title="Command menu">
        <span>⌘K</span>
      </button>

      <button type="button" className="k-btn k-btn--primary k-btn--sm" onClick={onNew}>
        <Plus size={16} />
        New
      </button>

      <button
        type="button"
        className="k-icon-btn"
        onClick={onToggleTheme}
        aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      >
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
      </button>
    </header>
  );
}
