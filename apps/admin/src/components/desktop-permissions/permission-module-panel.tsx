import type { FeatureKey, PermissionModule, PermissionSubGroup, PermissionValues } from "./types";
import { PermissionFeatureToggle } from "./permission-feature-toggle";

interface PermissionModulePanelProps {
  module: PermissionModule;
  values: PermissionValues;
  onToggleTab: (key: FeatureKey, checked: boolean) => void;
  onToggleFeature: (key: FeatureKey, checked: boolean) => void;
  onToggleSubGroup: (group: PermissionSubGroup, checked: boolean) => void;
}

export function PermissionModulePanel({
  module,
  values,
  onToggleTab,
  onToggleFeature,
  onToggleSubGroup
}: PermissionModulePanelProps) {
  const tabEnabled = values[module.tabKey];
  const Icon = module.icon;
  const hasChildren = module.features.length > 0 || module.subGroups.length > 0;

  return (
    <section className="permission-module-panel" style={{ borderTopColor: module.color }}>
      <div className="permission-panel-header">
        <div className="permission-panel-heading">
          <span
            className="permission-module-icon permission-panel-icon"
            style={{ backgroundColor: `${module.color}1A`, color: module.color }}
          >
            <Icon />
          </span>
          <div>
            <div className="permission-panel-title">{module.label}</div>
            <div className="permission-panel-desc">{module.description}</div>
          </div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={tabEnabled}
            onChange={(e) => onToggleTab(module.tabKey, e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      <div className="permission-panel-body">
        {module.features.map((feature) => (
          <PermissionFeatureToggle
            key={feature.key}
            feature={feature}
            checked={values[feature.key]}
            disabled={!tabEnabled}
            onChange={onToggleFeature}
          />
        ))}

        {module.subGroups.map((group) => {
          const groupEnabled = values[group.key];
          const childrenDisabled = !tabEnabled || !groupEnabled;
          return (
            <div className={"permission-subcard" + (childrenDisabled ? " muted" : "")} key={group.key}>
              <div className="permission-subcard-header">
                <div>
                  <div className="permission-subcard-title">{group.label}</div>
                  <div className="permission-subcard-desc">{group.description}</div>
                </div>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={groupEnabled}
                    disabled={!tabEnabled}
                    onChange={(e) => onToggleSubGroup(group, e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              {group.features.map((feature) => (
                <PermissionFeatureToggle
                  key={feature.key}
                  feature={feature}
                  checked={values[feature.key]}
                  disabled={childrenDisabled}
                  onChange={onToggleFeature}
                />
              ))}
            </div>
          );
        })}

        {!hasChildren ? <div className="permission-empty-note">该模块暂无子功能开关</div> : null}
      </div>
    </section>
  );
}
