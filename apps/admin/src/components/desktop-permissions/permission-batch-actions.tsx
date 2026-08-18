import { Ban, CheckCheck, RotateCcw } from "lucide-react";

interface PermissionBatchActionsProps {
  disabled?: boolean;
  onEnableAll: () => void;
  onDisableAll: () => void;
  onReset: () => void;
}

export function PermissionBatchActions({ disabled, onEnableAll, onDisableAll, onReset }: PermissionBatchActionsProps) {
  return (
    <div className="permission-batch-actions">
      <button type="button" className="btn btn-secondary" disabled={disabled} onClick={onEnableAll}>
        <CheckCheck />
        全开
      </button>
      <button type="button" className="btn btn-secondary" disabled={disabled} onClick={onDisableAll}>
        <Ban />
        全关
      </button>
      <button type="button" className="btn btn-secondary" disabled={disabled} onClick={onReset}>
        <RotateCcw />
        恢复默认
      </button>
    </div>
  );
}
