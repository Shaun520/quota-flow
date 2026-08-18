import type { FeatureKey, PermissionModule, PermissionValues } from "./types";

interface PermissionModuleNavProps {
  modules: PermissionModule[];
  values: PermissionValues;
  selectedKey: string;
  onSelect: (moduleKey: string) => void;
  onToggleTab: (key: FeatureKey, checked: boolean) => void;
}

function featureCountOf(module: PermissionModule): number {
  return module.features.length + module.subGroups.reduce((sum, group) => sum + group.features.length, 0);
}

export function PermissionModuleNav({ modules, values, selectedKey, onSelect, onToggleTab }: PermissionModuleNavProps) {
  return (
    <nav className="permission-module-nav" aria-label="权限模块">
      {modules.map((module) => {
        const Icon = module.icon;
        const enabled = values[module.tabKey];
        const active = module.key === selectedKey;
        const count = featureCountOf(module);
        return (
          <div
            key={module.key}
            role="button"
            tabIndex={0}
            className={"permission-module-item" + (active ? " active" : "") + (enabled ? "" : " off")}
            style={active ? { borderLeftColor: module.color } : undefined}
            onClick={() => onSelect(module.key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(module.key);
              }
            }}
          >
            <span
              className="permission-module-icon"
              style={{ backgroundColor: `${module.color}1A`, color: module.color }}
            >
              <Icon />
            </span>
            <span className="permission-module-text">
              <span className="permission-module-label">{module.label}</span>
              <span className="permission-module-hint">{count > 0 ? `${count} 项功能` : "无子功能"}</span>
            </span>
            <label className="toggle" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={enabled}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onToggleTab(module.tabKey, e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        );
      })}
    </nav>
  );
}
