import { useTheme } from "next-themes";
import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

export function ThemeSwitcher({
  renderAsRadio = false,
}: {
  renderAsRadio?: boolean;
}): React.ReactElement {
  const { theme, setTheme } = useTheme();
  const activeTheme = theme ?? "system";

  if (renderAsRadio) {
    return (
      <RadioGroup
        value={activeTheme}
        onValueChange={(value) => setTheme(value)}
        className="grid grid-cols-1 gap-3"
      >
        {THEME_OPTIONS.map((item) => (
          <Label
            key={item.value}
            htmlFor={`theme-${item.value}`}
            className="cursor-pointer [&:has([data-state=checked])>div]:border-primary [&:has([data-state=checked])>div]:bg-primary/5"
          >
            <Card className="w-full border transition-colors shadow-none">
              <CardContent className="flex flex-row items-center justify-start gap-4 p-4">
                <RadioGroupItem value={item.value} id={`theme-${item.value}`} />
                <span className="text-sm font-medium">{item.label}</span>
              </CardContent>
            </Card>
          </Label>
        ))}
      </RadioGroup>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between">
          {THEME_OPTIONS.find((item) => item.value === activeTheme)?.label ??
            "System"}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map((item) => (
          <DropdownMenuItem
            key={item.value}
            className={cn(
              "cursor-pointer my-0.5",
              activeTheme === item.value && "bg-secondary-foreground/8",
            )}
            onClick={() => setTheme(item.value)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
