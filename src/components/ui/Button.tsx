import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'size'> {
  children: ReactNode;
  size?: string;
  variant?: string;
}

const Button = ({ children, onClick, disabled, className = '', size: _size, variant, ...props }: ButtonProps) => {
  const baseClasses = `
    flex h-10 items-center justify-center gap-2
    font-semibold py-2 px-4 rounded-md
    text-button-text text-sm
    disabled:opacity-50 disabled:cursor-not-allowed
    focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent
  `;

  const hasSurfaceBg = className.includes('bg-surface');
  const isDestructive = variant === 'destructive';

  const combinedClasses = clsx(
    baseClasses,
    {
      'bg-accent': !hasSurfaceBg && !isDestructive,
      'bg-surface': hasSurfaceBg,
      'bg-red-600 hover:bg-red-700': isDestructive,
    },
    className,
  );

  return (
    <button onClick={onClick} disabled={disabled} className={combinedClasses} {...props}>
      {children}
    </button>
  );
};

export default Button;
