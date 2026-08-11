import { StatusChip, type StatusChipSize, type StatusChipTone } from '@/components/ui/StatusChip';
import {
  lifecycleLabel,
  lifecycleStatusFrom,
  lifecycleTone,
} from '@/lib/easyfixer-lifecycle';

export function EasyfixerLifecycleChip({
  value,
  fallbackLabel,
  fallbackTone = 'slate',
  size = 'sm',
}: {
  value: unknown;
  fallbackLabel?: string | null;
  fallbackTone?: StatusChipTone;
  size?: StatusChipSize;
}) {
  const status = lifecycleStatusFrom(value);
  if (status) {
    return (
      <StatusChip tone={lifecycleTone(status)} size={size} title={`Lifecycle: ${lifecycleLabel(status)}`}>
        {lifecycleLabel(status)}
      </StatusChip>
    );
  }

  if (fallbackLabel) {
    return (
      <StatusChip tone={fallbackTone} size={size} title="Legacy status (lifecycle unavailable)">
        {fallbackLabel}
      </StatusChip>
    );
  }

  return <span className="text-muted-foreground">—</span>;
}

export default EasyfixerLifecycleChip;
