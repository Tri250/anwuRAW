import { useState, useEffect, useRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Input from './Input';
import Text from './Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../types/typography';
import clsx from 'clsx';

export interface OptionItem<T extends React.Key> {
  label: string;
  value: T;
  disabled?: boolean;
}

interface DropdownProps<T extends React.Key> {
  className?: string;
  onChange: (value: T) => void;
  options: Array<OptionItem<T>>;
  placeholder?: string;
  searchPlaceholder?: string;
  value: T | null;
  disabled?: boolean;
  triggerClassName?: string;
}

const Dropdown = <T extends React.Key>({
  className = '',
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  value,
  disabled = false,
  triggerClassName = '',
}: DropdownProps<T>) => {
  const { t } = useTranslation();
  // i18n 兜底:调用点未传文案时使用本地化默认值,避免硬编码英文
  const resolvedPlaceholder = placeholder ?? t('ui.dropdown.placeholder');
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('ui.dropdown.searchPlaceholder');
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const [activeIndex, setActiveIndex] = useState(-1);
  const [focusOption, setFocusOption] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const selectedOption = options.find((opt) => opt.value === value) || null;
  const filteredOptions = useMemo(() => {
    if (!searchTerm) return options;
    return options.filter((opt) => opt.label.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [options, searchTerm]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    // 触屏 WebView 可能不合成 mousedown，补 touchstart 保证「点空白处收起下拉」
    document.addEventListener('touchstart', handleClickOutside, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setSearchTerm('');
      setShowSearch(false);
      setActiveIndex(-1);
      setFocusOption(false);
      optionRefs.current.clear();
    }
  }, [isOpen]);

  // 方向键导航时把真实焦点移动到选项；鼠标打开时焦点仍停留在触发按钮
  useEffect(() => {
    if (!isOpen || !focusOption || activeIndex < 0) return;
    optionRefs.current.get(activeIndex)?.focus();
  }, [activeIndex, focusOption, isOpen, filteredOptions.length]);

  const handleSelect = (option: OptionItem<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const moveActiveOption = (direction: 1 | -1) => {
    const total = filteredOptions.length;
    if (total === 0) return;

    let next = activeIndex;
    for (let step = 0; step < total; step += 1) {
      next = next < 0 ? (direction > 0 ? 0 : total - 1) : (next + direction + total) % total;
      if (!filteredOptions[next].disabled) {
        setActiveIndex(next);
        setFocusOption(true);
        return;
      }
    }
  };

  const moveActiveToEdge = (edge: 'start' | 'end') => {
    const total = filteredOptions.length;
    if (total === 0) return;
    const indexes = edge === 'start' ? [...Array(total).keys()] : [...Array(total).keys()].reverse();
    const next = indexes.find((index) => !filteredOptions[index].disabled);
    if (next !== undefined) {
      setActiveIndex(next);
      setFocusOption(true);
    }
  };

  const openDropdown = () => {
    setIsOpen(true);
  };

  const isPrintableKey = (e: React.KeyboardEvent<Element>): boolean => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    return e.key.length === 1;
  };

  const handleContainerKeyDown = (e: React.KeyboardEvent) => {
    const isSearchInput = e.target === searchInputRef.current;

    if (e.key === 'Escape') {
      e.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!isOpen) {
        openDropdown();
        // 首次打开时从选中项之后开始，避免重复停在已选项
        setActiveIndex(-1);
      }
      moveActiveOption(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      if (isSearchInput) return;
      e.preventDefault();
      e.stopPropagation();
      if (!isOpen) openDropdown();
      moveActiveToEdge(e.key === 'Home' ? 'start' : 'end');
      return;
    }

    if (e.key === 'Enter') {
      if (isOpen && activeIndex >= 0 && filteredOptions[activeIndex] && !filteredOptions[activeIndex].disabled) {
        e.stopPropagation();
        e.preventDefault();
        handleSelect(filteredOptions[activeIndex]);
      } else if (isOpen && filteredOptions.length === 1) {
        e.stopPropagation();
        e.preventDefault();
        handleSelect(filteredOptions[0]);
      }
      return;
    }

    if (isSearchInput) return;

    if (isPrintableKey(e)) {
      e.stopPropagation();
      e.preventDefault();

      setIsOpen(true);
      setShowSearch(true);
      setActiveIndex(-1);
      setFocusOption(false);
      setSearchTerm((prev) => prev + e.key);
    }
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef} onKeyDown={handleContainerKeyDown}>
      <button
        ref={triggerRef}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        disabled={disabled}
        className={clsx(
          'w-full border border-border-color rounded-md px-3 mr-4 py-2 flex justify-between items-center text-left disabled:opacity-50 disabled:cursor-not-allowed',
          'focus:ring-accent focus:border-accent focus:outline-hidden focus:ring-2',
          triggerClassName || 'bg-surface',
        )}
        onClick={() => {
          setIsOpen(!isOpen);
          setActiveIndex(-1);
          setFocusOption(false);
        }}
        type="button"
      >
        <Text as="span" variant={TextVariants.label} color={TextColors.primary}>
          {selectedOption ? selectedOption.label : resolvedPlaceholder}
        </Text>
        <ChevronDown
          className={`${TEXT_COLOR_KEYS[TextColors.secondary]} transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          size={20}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            className="absolute right-0 mt-2 w-full origin-top-right z-20"
            exit={{ opacity: 0, scale: 0.95 }}
            initial={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1, ease: 'easeOut' }}
          >
            <div
              aria-label={resolvedPlaceholder}
              aria-orientation="vertical"
              className="bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2 max-h-80 overflow-y-auto"
              role="listbox"
            >
              {showSearch && (
                <Input
                  ref={searchInputRef}
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setActiveIndex(-1);
                    setFocusOption(false);
                  }}
                  placeholder={resolvedSearchPlaceholder}
                  autoFocus={true}
                  className="mb-2"
                />
              )}

              {filteredOptions.map((option: OptionItem<T>, index: number) => {
                const isSelected = value === option.value;
                const isActive = activeIndex === index;
                return (
                  <button
                    key={option.value}
                    ref={(element) => {
                      if (element) optionRefs.current.set(index, element);
                      else optionRefs.current.delete(index);
                    }}
                    onClick={() => handleSelect(option)}
                    disabled={option.disabled}
                    className={clsx(
                      'w-full text-left px-3 py-2 rounded-md flex items-center justify-between',
                      'transition-colors duration-150',
                      {
                        'bg-bg-primary': isSelected,
                        'bg-card-active': isActive && !isSelected,
                        'hover:bg-bg-primary': !option.disabled && !isActive,
                        'opacity-40 cursor-not-allowed': option.disabled,
                      },
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={-1}
                  >
                    <Text color={TextColors.primary} weight={isSelected ? TextWeights.semibold : TextWeights.normal}>
                      {option.label}
                    </Text>
                    {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Dropdown;
