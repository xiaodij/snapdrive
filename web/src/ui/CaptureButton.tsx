// "Scan" / "Add page" that respects the camera mode. In 'system' mode the control is a label
// wrapping a capture file input, so a single tap opens the phone's camera app (a programmatic
// click from async code would be blocked); in 'live' mode it opens the in-app viewfinder.
import type { ReactNode } from 'react';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';

export function CaptureButton({
  className,
  style,
  children,
  onLive,
  onFiles,
  label,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
  onLive: () => void;
  onFiles: (files: File[]) => void;
  label?: string;
}) {
  const { cameraMode } = useStore(settingsStore);
  if (cameraMode === 'system') {
    return (
      <label className={className} style={style} aria-label={label} role="button">
        {children}
        <input
          className="sr-only"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onFiles(files);
          }}
        />
      </label>
    );
  }
  return (
    <button className={className} style={style} onClick={onLive} aria-label={label}>
      {children}
    </button>
  );
}
