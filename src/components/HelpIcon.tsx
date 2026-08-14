import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHelpIcons } from "@/lib/helpIcons";

/**
 * 行内帮助图标：悬停显示说明文字（纯 CSS，无额外依赖）。
 * 受全局「显示帮助图标」开关控制（useHelpIcons），关闭时渲染 null。
 */
export function HelpIcon({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { showHelp } = useHelpIcons();
  if (!showHelp) return null;
  return (
    <span className={cn("group relative inline-flex align-middle", className)}>
      <Info
        aria-label={text}
        className="h-3.5 w-3.5 cursor-help text-muted-foreground/70 hover:text-muted-foreground"
      />
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-64 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-relaxed text-background opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
