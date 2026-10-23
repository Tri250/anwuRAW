import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'size'> {
  children: ReactNode;
  size?: string;
  variant?: string;
}

const Button = ({
  children,
  onClick,
  disabled,
  className = '',
  size: _size,
  variant: _variant,
  ...props
}: ButtonProps) => {
  const baseClasses = `
    flex items-center justify-center gap-2
    font-semibold py-2 px-4 rounded-md
    text-button-text text-md
    transition-[filter,transform] duration-150
    hover:brightness-110 active:scale-[0.98] active:brightness-95
    disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100
  `;

  const hasSurfaceBg = className.includes('bg-surface');

  const combinedClasses = clsx(
    baseClasses,
    {
      'bg-accent': !hasSurfaceBg,
      'bg-surface': hasSurfaceBg,
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
