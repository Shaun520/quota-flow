import type { FeatureKey, PermissionFeature } from "./types";

interface PermissionFeatureToggleProps {
  feature: PermissionFeature;
  checked: boolean;
  disabled?: boolean;
  onChange: (key: FeatureKey, checked: boolean) => void;
}

export function PermissionFeatureToggle({ feature, checked, disabled, onChange }: PermissionFeatureToggleProps) {
  return (
    <div className={"permission-feature-row" + (disabled ? " disabled" : "")}>
      <div className="permission-feature-text">
        <span className="permission-feature-label">{feature.label}</span>
        <span className="permission-feature-hint">{feature.description}</span>
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(feature.key, e.target.checked)}
        />
        <span className="toggle-slider" />
      </label>
    </div>
  );
}
