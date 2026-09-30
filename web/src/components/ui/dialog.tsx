import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export const DialogContent = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof D.Content> & { title: string; description?: string }>(
  ({ className, children, title, description, ...p }, ref) => (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <D.Content
        ref={ref}
        className={cn("fixed left-1/2 top-[8vh] z-50 w-[min(92vw,40rem)] max-h-[84vh] -translate-x-1/2 overflow-auto rounded-xl border bg-card p-5 shadow-2xl", className)}
        {...p}
      >
        <D.Title className="pr-8 text-base font-semibold">{title}</D.Title>
        <D.Description className={cn("mt-1 text-sm text-muted-foreground", !description && "sr-only")}>{description ?? title}</D.Description>
        <div className="mt-4">{children}</div>
        <D.Close aria-label="Close" className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-muted">
          <X className="size-4" />
        </D.Close>
      </D.Content>
    </D.Portal>
  ),
);
DialogContent.displayName = "DialogContent";
