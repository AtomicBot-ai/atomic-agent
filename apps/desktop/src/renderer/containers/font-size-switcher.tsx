import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FONT_SIZE_OPTIONS, useSettingsStore } from "@/lib/settings-store";
import { cn } from "@/lib/utils";

export function FontSizeSwitcher(): React.ReactElement {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between">
          {FONT_SIZE_OPTIONS.find((item) => item.value === fontSize)?.label ??
            "Medium"}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {FONT_SIZE_OPTIONS.map((item) => (
          <DropdownMenuItem
            key={item.value}
            className={cn(
              "cursor-pointer my-0.5",
              fontSize === item.value && "bg-secondary-foreground/8",
            )}
            onClick={() => setFontSize(item.value)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
