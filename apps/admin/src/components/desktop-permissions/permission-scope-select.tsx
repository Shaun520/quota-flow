import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe, Users } from "lucide-react";
import type { TeamOption } from "@/lib/api/teams";

interface PermissionScopeSelectProps {
  teams: TeamOption[];
  value: string;
  disabled?: boolean;
  onChange: (scopeKey: string) => void;
}

export function PermissionScopeSelect({ teams, value, disabled, onChange }: PermissionScopeSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const isGlobal = value === "global";
  const currentTeam = isGlobal ? undefined : teams.find((team) => `team:${team.id}` === value);
  const currentLabel = isGlobal ? "全局默认" : `团队：${currentTeam?.name ?? "未知团队"}`;

  const select = (scopeKey: string) => {
    onChange(scopeKey);
    setOpen(false);
  };

  return (
    <div className={"scope-select" + (open ? " open" : "")} ref={rootRef}>
      <button
        type="button"
        className="scope-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        {isGlobal ? <Globe /> : <Users />}
        <span className="scope-select-label">{currentLabel}</span>
        <ChevronDown className="scope-select-chevron" />
      </button>
      {open ? (
        <div className="scope-select-menu" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={isGlobal}
            className={"scope-select-item" + (isGlobal ? " active" : "")}
            onClick={() => select("global")}
          >
            <Globe />
            全局默认
            {isGlobal ? <Check className="scope-select-check" /> : null}
          </button>
          {teams.map((team) => {
            const scopeKey = `team:${team.id}`;
            const active = value === scopeKey;
            return (
              <button
                type="button"
                role="option"
                aria-selected={active}
                className={"scope-select-item" + (active ? " active" : "")}
                key={team.id}
                onClick={() => select(scopeKey)}
              >
                <Users />
                团队：{team.name}
                {active ? <Check className="scope-select-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
