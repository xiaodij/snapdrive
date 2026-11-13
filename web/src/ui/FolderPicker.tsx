// Browse the OneDrive folder tree and pick a destination.
import { useCallback, useEffect, useState } from 'react';
import { createFolder, listFolders, type DriveItem } from '../services/onedrive';
import { ROOT_FOLDER, settingsStore, updateSettings, type FolderRef } from '../state/settings';
import { Icon, Sheet } from './common';

export function FolderPicker({ onClose }: { onClose: () => void }) {
  const [trail, setTrail] = useState<FolderRef[]>([ROOT_FOLDER]);
  const [folders, setFolders] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const current = trail[trail.length - 1];

  const load = useCallback(async (folder: FolderRef) => {
    setLoading(true);
    setError(undefined);
    try {
      setFolders(await listFolders(folder));
    } catch (err) {
      setFolders([]);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(current);
  }, [current, load]);

  const newFolder = async () => {
    const name = prompt('New folder name')?.trim();
    if (!name) return;
    try {
      const made = await createFolder(name, current);
      setTrail((t) => [...t, { id: made.id, path: `${current.path}/${made.name}` }]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const choose = () => {
    updateSettings({ folder: current });
    onClose();
  };

  const selected = settingsStore.get().folder;

  return (
    <Sheet
      title="Choose Folder"
      onClose={onClose}
      left={
        trail.length > 1 ? (
          <button className="link-btn" onClick={() => setTrail((t) => t.slice(0, -1))}>
            Back
          </button>
        ) : (
          <button className="link-btn" onClick={onClose}>
            Cancel
          </button>
        )
      }
      right={
        <button className="icon-btn" onClick={() => void newFolder()} aria-label="New folder">
          <Icon name="plus" />
        </button>
      }
    >
      <div className="section">
        <div className="group">
          <button className="row" onClick={choose}>
            <span className="lead">
              <Icon name="checkCircle" />
            </span>
            <div className="main">
              <div className="title" style={{ fontWeight: 600 }}>
                Upload here
              </div>
              <div className="sub">{current.path}</div>
            </div>
            {selected.id === current.id && <span className="chip ok">Current</span>}
          </button>
        </div>
      </div>
      <div className="section">
        <div className="label">Folders</div>
        <div className="group">
          {loading ? (
            <div className="row">
              <div className="spinner" />
              <span className="muted">Loading…</span>
            </div>
          ) : folders.length === 0 ? (
            <div className="row plain">
              <span className="muted">No subfolders</span>
            </div>
          ) : (
            folders.map((f) => (
              <button key={f.id} className="row" onClick={() => setTrail((t) => [...t, { id: f.id, path: `${current.path}/${f.name}` }])}>
                <span className="lead">
                  <Icon name="folder" />
                </span>
                <div className="main">
                  <div className="title">{f.name}</div>
                </div>
                {!!f.childCount && <span className="trail">{f.childCount}</span>}
                <Icon name="chevron" className="chev" />
              </button>
            ))
          )}
        </div>
        {error && <div className="error-text" style={{ margin: '8px 16px' }}>{error}</div>}
      </div>
    </Sheet>
  );
}
