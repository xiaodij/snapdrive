import { applyUpdate, checkForUpdates, describeBuild, updateStore } from '../state/update';
import { useStore } from '../state/store';
import { toast } from './common';

/** Settings → App version: what is running, what is live, and the buttons to update. */
export function UpdateSection() {
  const u = useStore(updateStore);
  const newer = !!u.latest && u.latest !== u.current;

  const check = async () => {
    const r = await checkForUpdates();
    if (r === 'latest') toast('SnapDrive is up to date');
    else if (r === 'offline') toast('Could not check: no connection');
  };

  return (
    <div className="section">
      <div className="label">App version</div>
      <div className="group">
        <div className="row plain">
          <div className="main">
            <div className="title">SnapDrive {__APP_VERSION__}</div>
            <div className="sub">Build {describeBuild(u.current)}</div>
          </div>
          {u.ready ? (
            <button className="btn small" onClick={() => void applyUpdate()}>
              Install update
            </button>
          ) : (
            <button className="btn small secondary" onClick={() => void check()} disabled={u.checking}>
              {u.checking ? 'Checking…' : 'Check for updates'}
            </button>
          )}
        </div>
        {newer && (
          <div className="row plain">
            <div className="main">
              <div className="title">{u.ready ? 'Update downloaded' : 'Update available, downloading…'}</div>
              <div className="sub">Build {describeBuild(u.latest)}</div>
            </div>
            {!u.ready && (
              <button className="btn small secondary" onClick={() => void applyUpdate()}>
                Reload now
              </button>
            )}
          </div>
        )}
      </div>
      <div className="footer">
        SnapDrive checks for a new version when it opens. Installing restarts the app; a scan you have not sent yet is kept.
      </div>
    </div>
  );
}
