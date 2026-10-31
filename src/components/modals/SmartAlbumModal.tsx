import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Plus, Trash2, Sparkles } from 'lucide-react';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import Dropdown, { OptionItem } from '../ui/Dropdown';
import { useSmartAlbumsStore } from '../../store/useSmartAlbumsStore';
import { pushExitLayer, removeExitLayer } from '../../utils/androidBackRegistry';
import { COLOR_LABELS } from '../../utils/adjustments';
import { SmartRule, SmartRuleField, SMART_RULE_FIELDS, getRuleOps } from '../../utils/smartAlbums';

interface SmartAlbumModalProps {
  isOpen: boolean;
  albumId: string | null;
  onClose(): void;
}

const DEFAULT_VALUES: Record<SmartRuleField, string> = {
  rating: '3',
  flag: 'pick',
  edited: 'edited',
  raw: 'raw',
  color: 'none',
  camera: '',
  lens: '',
  iso: '400',
  dateTaken: new Date().toISOString().slice(0, 10),
  filename: '',
};

const newRule = (field: SmartRuleField): SmartRule => ({
  field,
  op: getRuleOps(field)[0],
  value: DEFAULT_VALUES[field],
});

export default function SmartAlbumModal({ isOpen, albumId, onClose }: SmartAlbumModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  const [name, setName] = useState('');
  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [rules, setRules] = useState<SmartRule[]>([newRule('rating')]);

  useEffect(() => {
    if (!isOpen) return;
    const album = albumId
      ? useSmartAlbumsStore.getState().albums.find((a) => a.id === albumId) || null
      : null;
    setName(album?.name || '');
    setMatch(album?.match || 'all');
    setRules(album && album.rules.length > 0 ? album.rules.map((r) => ({ ...r })) : [newRule('rating')]);
    setIsMounted(true);
    const timer = setTimeout(() => setShow(true), 10);
    return () => clearTimeout(timer);
  }, [isOpen, albumId]);

  useEffect(() => {
    if (isOpen) return;
    setShow(false);
    const timer = setTimeout(() => setIsMounted(false), 300);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // E18: while open, the Android back button closes this modal first.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const handler = () => onCloseRef.current();
    pushExitLayer(handler);
    return () => removeExitLayer(handler);
  }, [isOpen]);

  const fieldOptions = useMemo<Array<OptionItem<string>>>(
    () => SMART_RULE_FIELDS.map((field) => ({ label: t(`modals.smartAlbum.fields.${field}`), value: field })),
    [t],
  );

  const colorOptions = useMemo<Array<OptionItem<string>>>(
    () => [
      { label: t('modals.smartAlbum.colors.none'), value: 'none' },
      ...COLOR_LABELS.map((c) => ({ label: c.name.charAt(0).toUpperCase() + c.name.slice(1), value: c.name })),
    ],
    [t],
  );

  const flagOptions = useMemo<Array<OptionItem<string>>>(
    () => [
      { label: t('modals.smartAlbum.flags.pick'), value: 'pick' },
      { label: t('modals.smartAlbum.flags.reject'), value: 'reject' },
      { label: t('modals.smartAlbum.flags.none'), value: 'none' },
    ],
    [t],
  );

  const editedOptions = useMemo<Array<OptionItem<string>>>(
    () => [
      { label: t('modals.smartAlbum.edited.edited'), value: 'edited' },
      { label: t('modals.smartAlbum.edited.unedited'), value: 'unedited' },
    ],
    [t],
  );

  const rawOptions = useMemo<Array<OptionItem<string>>>(
    () => [
      { label: t('modals.smartAlbum.raw.raw'), value: 'raw' },
      { label: t('modals.smartAlbum.raw.nonRaw'), value: 'nonRaw' },
    ],
    [t],
  );

  const ratingOptions = useMemo<Array<OptionItem<string>>>(
    () => [0, 1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: String(n) })),
    [],
  );

  const buildOpOptions = useCallback(
    (field: SmartRuleField): Array<OptionItem<string>> =>
      getRuleOps(field).map((op) => ({ label: t(`modals.smartAlbum.ops.${op}` as ParseKeys), value: op })),
    [t],
  );

  const isValueDropdown = (field: SmartRuleField) => field !== 'camera' && field !== 'lens' && field !== 'filename';

  const updateRule = (index: number, updates: Partial<SmartRule>) => {
    setRules((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...updates } : rule)));
  };

  const handleSave = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed || rules.length === 0) return;
    const store = useSmartAlbumsStore.getState();
    if (albumId) {
      store.updateAlbum(albumId, { name: trimmed, rules, match });
    } else {
      store.createAlbum(trimmed, rules, match);
    }
    onClose();
  }, [albumId, name, rules, match, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT') {
        e.preventDefault();
        e.stopPropagation();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [handleSave, onClose],
  );

  if (!isMounted) return null;

  const canSave = !!name.trim() && rules.length > 0 && rules.every((r) => r.value.trim() !== '');

  return (
    <div
      aria-modal="true"
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-lg transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e: any) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={18} className="text-accent shrink-0" />
          <Text variant={TextVariants.title}>
            {albumId ? t('modals.smartAlbum.editTitle') : t('modals.smartAlbum.createTitle')}
          </Text>
        </div>
        <Text variant={TextVariants.small} className="mb-4">
          {t('modals.smartAlbum.description')}
        </Text>

        <input
          autoFocus
          className="w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-accent mb-3"
          onChange={(e) => setName(e.target.value)}
          placeholder={t('modals.smartAlbum.namePlaceholder')}
          type="text"
          value={name}
        />

        <div className="flex items-center gap-2 mb-3">
          <Text variant={TextVariants.small} className="shrink-0">
            {t('modals.smartAlbum.matchLabel')}
          </Text>
          <div className="flex bg-bg-primary p-1 rounded-md flex-1">
            {(['all', 'any'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`flex-1 px-3 py-1 rounded text-sm transition-colors ${
                  match === mode ? 'bg-card-active text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`}
                onClick={() => setMatch(mode)}
              >
                {t(`modals.smartAlbum.match.${mode}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1 mb-3">
          {rules.map((rule, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="w-36 shrink-0">
                <Dropdown
                  options={fieldOptions}
                  value={rule.field}
                  onChange={(field) => updateRule(index, newRule(field as SmartRuleField))}
                />
              </div>
              <div className="w-24 shrink-0">
                <Dropdown
                  options={buildOpOptions(rule.field)}
                  value={rule.op}
                  onChange={(op) => updateRule(index, { op: String(op) })}
                />
              </div>
              <div className="flex-1 min-w-0">
                {isValueDropdown(rule.field) ? (
                  <Dropdown
                    options={
                      rule.field === 'color'
                        ? colorOptions
                        : rule.field === 'flag'
                          ? flagOptions
                          : rule.field === 'edited'
                            ? editedOptions
                            : rule.field === 'raw'
                              ? rawOptions
                              : ratingOptions
                    }
                    value={rule.value}
                    onChange={(value) => updateRule(index, { value: String(value) })}
                  />
                ) : (
                  <input
                    className="w-full bg-bg-primary text-text-primary border border-border-color rounded-md px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-accent"
                    onChange={(e) => updateRule(index, { value: e.target.value })}
                    placeholder={t(`modals.smartAlbum.placeholders.${rule.field}` as ParseKeys)}
                    type="text"
                    value={rule.value}
                  />
                )}
              </div>
              <button
                className="p-2 rounded-md text-text-secondary hover:bg-bg-primary hover:text-text-primary transition-colors shrink-0 disabled:opacity-30"
                data-tooltip={t('modals.smartAlbum.removeRule')}
                disabled={rules.length <= 1}
                onClick={() => setRules((prev) => prev.filter((_, i) => i !== index))}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>

        <button
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-bg-primary hover:text-text-primary transition-colors mb-4"
          onClick={() => setRules((prev) => [...prev, newRule('rating')])}
        >
          <Plus size={16} />
          {t('modals.smartAlbum.addRule')}
        </button>

        <div className="flex justify-end gap-3">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-bg-primary transition-colors"
            onClick={onClose}
          >
            {t('modals.smartAlbum.cancel')}
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent text-button-text font-semibold hover:bg-accent-hover disabled:bg-gray-500 disabled:text-white disabled:cursor-not-allowed transition-colors"
            disabled={!canSave}
            onClick={handleSave}
          >
            {albumId ? t('modals.smartAlbum.save') : t('modals.smartAlbum.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
