import { useCallback, useEffect, useRef, useState } from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Invokes } from '../../ui/AppProperties';
import { useEditorStore } from '../../../store/useEditorStore';
import { Adjustments, normalizeLoadedAdjustments } from '../../../utils/adjustments';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import { ToolbarMenu, ToolbarMenuItem, useMenuDismiss } from './ToolbarMenu';

interface RevisionSummary {
  id: string;
  parentId: string | null;
  label: string;
  createdAt: number;
  depth: number;
  isHead: boolean;
}

interface EditHistoryView {
  head: string | null;
  revisions: RevisionSummary[];
}

const EMPTY_HISTORY: EditHistoryView = { head: null, revisions: [] };

interface EditHistoryButtonProps {
  onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void;
}

// Durable, non-linear snapshots stored by the Rust edit_history module. The
// in-session undo stack stays linear; this menu is where the user pins
// revisions, branches from any of them, and deletes branches they no longer
// need. Left-click opens the menu; right-click on a revision deletes it.
export default function EditHistoryButton({ onKeyDown }: EditHistoryButtonProps) {
  const { t } = useTranslation();
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const applyRevision = useEditorStore((s) => s.applyRevision);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [history, setHistory] = useState<EditHistoryView>(EMPTY_HISTORY);
  const [isBusy, setIsBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(containerRef, isMenuOpen, setIsMenuOpen);

  const imagePath = selectedImage?.path ?? null;

  const refresh = useCallback(async () => {
    if (!imagePath) return;
    try {
      const view = await invoke<EditHistoryView>(Invokes.GetEditHistory, { path: imagePath });
      setHistory(view);
    } catch (err) {
      toast.error(String(err));
    }
  }, [imagePath]);

  useEffect(() => {
    if (isMenuOpen && imagePath) void refresh();
  }, [isMenuOpen, imagePath, refresh]);

  useEffect(() => {
    setHistory(EMPTY_HISTORY);
    setIsMenuOpen(false);
  }, [imagePath]);

  const handleSnapshot = async () => {
    if (!imagePath || isBusy) return;
    setIsBusy(true);
    try {
      const adjustments = useEditorStore.getState().adjustments;
      const label = `${t('editor.toolbar.snapshot')} ${history.revisions.length + 1}`;
      await invoke(Invokes.SaveEditSnapshot, { path: imagePath, label, adjustments });
      await refresh();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const handleCheckout = async (revisionId: string) => {
    if (!imagePath || isBusy) return;
    setIsBusy(true);
    try {
      const loaded = await invoke<unknown>(Invokes.CheckoutEditHistory, { path: imagePath, revisionId });
      applyRevision(normalizeLoadedAdjustments(loaded as Adjustments));
      await refresh();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = async (revision: RevisionSummary) => {
    if (!imagePath || isBusy) return;
    if (!window.confirm(`${t('editor.toolbar.deleteRevision')}: ${revision.label}?`)) return;
    setIsBusy(true);
    try {
      const view = await invoke<EditHistoryView>(Invokes.DeleteEditRevision, {
        path: imagePath,
        revisionId: revision.id,
      });
      setHistory(view);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={!selectedImage}
        onClick={() => setIsMenuOpen((prev) => !prev)}
        onKeyDown={onKeyDown}
        data-tooltip={t('editor.toolbar.history')}
        data-bench-id="edit-history"
      >
        <HistoryIcon size={20} />
      </button>

      <ToolbarMenu isOpen={isMenuOpen} title={t('editor.toolbar.history')}>
        <ToolbarMenuItem
          isSelected={false}
          label={t('editor.toolbar.snapshot')}
          onClick={() => void handleSnapshot()}
          onKeyDown={onKeyDown}
        />
        {history.revisions.length === 0 ? (
          <div className="px-4 py-2">
            <Text variant={TextVariants.small} color={TextColors.secondary}>
              {t('editor.toolbar.historyEmpty')}
            </Text>
          </div>
        ) : (
          history.revisions.map((revision) => (
            <div key={revision.id} style={{ paddingLeft: revision.depth * 12 }}>
              <ToolbarMenuItem
                detail={revision.isHead ? '\u25CF' : undefined}
                isSelected={revision.isHead}
                label={revision.label}
                onClick={() => void handleCheckout(revision.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void handleDelete(revision);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
          ))
        )}
      </ToolbarMenu>
    </div>
  );
}
