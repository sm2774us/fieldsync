import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 select-none",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:brightness-110",
        secondary: "bg-muted text-foreground hover:bg-border",
        outline: "border border-border bg-transparent hover:bg-muted",
        ghost: "hover:bg-muted",
        danger: "bg-danger text-white hover:brightness-110",
      },
      size: { sm: "h-8 px-3", md: "h-10 px-4", lg: "h-11 px-6 text-base", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...p }, ref) => {
    const cls = cn(buttonVariants({ variant, size }), className);
    if (asChild) return <Slot ref={ref} className={cls} {...p}>{children}</Slot>;
    return (
      <button ref={ref} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...p}>
        {loading ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
