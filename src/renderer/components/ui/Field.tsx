import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

export interface FieldProps {
  readonly label?: string;
  readonly htmlFor?: string;
  readonly optional?: boolean;
  readonly optionalText?: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly children: ReactNode;
}

export function Field({
  label,
  htmlFor,
  optional = false,
  optionalText = 'optional',
  hint,
  error,
  children,
}: FieldProps): ReactElement {
  return (
    <div className="field">
      {label !== undefined ? (
        <label className="field__label" htmlFor={htmlFor}>
          {label}
          {optional ? (
            <span className="field__label-opt">({optionalText})</span>
          ) : null}
        </label>
      ) : null}
      {children}
      {hint !== undefined && (error === null || error === undefined) ? (
        <span className="field__hint">{hint}</span>
      ) : null}
      {error !== null && error !== undefined && error !== '' ? (
        <span className="field__error" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
}

export function Input({ invalid = false, className, ...rest }: InputProps): ReactElement {
  const classes = ['input', invalid ? 'input--invalid' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <input className={classes} {...rest} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly invalid?: boolean;
  readonly children: ReactNode;
}

export function Select({
  invalid = false,
  className,
  children,
  ...rest
}: SelectProps): ReactElement {
  const classes = ['select', invalid ? 'select--invalid' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <select className={classes} {...rest}>
      {children}
    </select>
  );
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...rest }: TextareaProps): ReactElement {
  const classes = ['textarea', className ?? ''].filter(Boolean).join(' ');
  return <textarea className={classes} {...rest} />;
}
