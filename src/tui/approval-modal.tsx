import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  canGrantCategory,
  canGrantShape,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { formatApprovalCategory } from "../approval/approval-level.js";
import {
  APPROVAL_CHORDS,
  canEditPath,
  decideApproval,
} from "./app-key-bindings.js";
import { MultiLineEditor } from "./components/multi-line-editor.js";
import { readableOn } from "./theme/readable-foreground.js";
import { theme } from "./theme/theme.js";
import { MouseTarget, useMouseCommands } from "./mouse/mouse-context.js";
import { isPrimaryPress } from "./mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "./mouse/mouse-registry.js";

interface ApprovalModalProps {
  request: ApprovalRequest;
  /** Live target-path buffer, or `null` while the field is closed. */
  pathDraft: string | null;
  /** Clicking `[e]` — the key does the same via `handleApprovalKey`. */
  onPathOpen: () => void;
  onPathChange: (value: string) => void;
  onPathSubmit: (value: string) => void;
  onPathCancel: () => void;
}

/**
 * Displayed as an in-place banner rather than a floating window to keep
 * rendering predictable across terminals. Hotkey handling lives at the
 * app root (`tui-app.tsx`) via ink's `useInput`; every button here is
 * also a click target, routed through the same `decideApproval` the
 * chords use.
 *
 * **The verbs are buttons now.** They used to be bracketed letters —
 * `[y] approve`, `[n] deny` — which is a legend, not a control: it
 * describes a key rather than offering something to press, and the one
 * thing on screen that *was* pressable looked exactly like the prose
 * around it. They are drawn as chips, the same raised face the composer
 * gives `send →` and the rail gives `≡ Menu`, so the row reads as a set
 * of choices whether the operator reaches for the mouse or the keyboard.
 *
 * Three tones, and the difference is the point: approve takes the
 * raised face, deny takes the palette's `error` as a ground, and the
 * session grants take the flatter accent-tinted badge. Approving once
 * and granting for a whole session are not the same act, and they no
 * longer look like it.
 */
export function ApprovalModal({
  request,
  pathDraft,
  onPathOpen,
  onPathChange,
  onPathSubmit,
  onPathCancel,
}: ApprovalModalProps): ReactElement {
  const categoryLabel = formatApprovalCategory(request.category);
  // `[s]` for any grantable category (everything but trust_config);
  // `[a]` only when the shell tool supplied a command shape to grant.
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
  const editable = canEditPath(request);
  const editing = pathDraft !== null;
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">
        ⚠ approval required
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="gray">tool:    </Text>
          <Text bold>{request.tool}</Text>
        </Text>
        <Text>
          <Text color="gray">kind:    </Text>
          {categoryLabel}
        </Text>
        <Text>
          <Text color="gray">reason:  </Text>
          {request.reason}
        </Text>
        {request.preview ? (
          <Text>
            <Text color="gray">preview: </Text>
            {clip(request.preview, 240)}
          </Text>
        ) : null}
        {request.affectedResources && request.affectedResources.length > 0 ? (
          <Text>
            <Text color="gray">affects: </Text>
            {request.affectedResources.join(", ")}
          </Text>
        ) : null}
      </Box>
      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">target</Text>
          <Box
            borderStyle="round"
            borderColor={theme.colors.accent}
            paddingX={1}
          >
            <MultiLineEditor
              value={pathDraft ?? ""}
              focus
              bare
              onChange={onPathChange}
              onSubmit={onPathSubmit}
              onEscape={onPathCancel}
              // While the prompt is up the mouse floor is raised to the
              // modal layer; without this the field's click target sits
              // below the floor and neither caret clicks nor the
              // right-click paste menu can reach it.
              mouseLayer={MOUSE_LAYER_MODAL}
            />
          </Box>
          <Text color="gray">
            a target outside this workspace is re-checked and may ask again
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color="green">enter</Text> confirm target path
            </Text>
            <Text>
              <Text color="gray">esc  </Text> back to the prompt
            </Text>
          </Box>
        </Box>
      ) : (
      <Box marginTop={1} flexDirection="column">
        {/*
          Two rows, not one: the pair that always exists sits together on
          top, and the optional session-scoped verbs go under them. A
          single wrapping row would put `deny` in a different place
          depending on which grants this particular request offers, and
          the destructive button is the last one that should move.
        */}
        <Box flexDirection="row">
          <ApprovalButton request={request} approved tone="primary">
            {`✓ approve · ctrl+${APPROVAL_CHORDS.approve}`}
          </ApprovalButton>
          <Text> </Text>
          <ApprovalButton request={request} approved={false} tone="danger">
            {`✗ deny · ctrl+${APPROVAL_CHORDS.deny}`}
          </ApprovalButton>
        </Box>
        {grantCategory || grantShape || editable ? (
          <Box flexDirection="row" marginTop={1}>
            {grantCategory ? (
              <>
                <ApprovalButton
                  request={request}
                  approved
                  grant="category"
                  tone="secondary"
                >
                  {`allow ${categoryLabel} this session · ctrl+${APPROVAL_CHORDS.grantCategory}`}
                </ApprovalButton>
                <Text> </Text>
              </>
            ) : null}
            {/*
              `grantShape` and `editable` share this slot and share
              `ctrl+b`, because they can never both be offered: the shape
              grant is shell-only and the retarget is set by `os.fs.write`
              alone. Pinned by `approval-key-arbitration.test.ts`.
            */}
            {grantShape ? (
              <ApprovalButton
                request={request}
                approved
                grant="shape"
                tone="secondary"
              >
                {`allow all ${request.commandShape} this session · ctrl+${APPROVAL_CHORDS.contextual}`}
              </ApprovalButton>
            ) : null}
            {editable ? (
              <EditPathButton onOpen={onPathOpen}>
                {`edit target path… · ctrl+${APPROVAL_CHORDS.contextual}`}
              </EditPathButton>
            ) : null}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            esc abort run {theme.glyphs.dotSeparator} ctrl+c stop everything
          </Text>
        </Box>
      </Box>
      )}
      {editing ? null : (
        <Text color="gray">{footerHint(grantCategory)}</Text>
      )}
    </Box>
  );
}

function footerHint(grantable: boolean): string {
  // The composer stays live under this prompt, and that is a feature:
  // the operator can answer the agent in words instead of a verdict.
  // What it no longer costs is the buttons — every one of them is a
  // chord, so typing a message that happens to start with "yes" cannot
  // approve the call the way a bare `y` did.
  const typing =
    "the composer stays live — type to answer the agent instead (enter cancels this call and sends it)";
  if (!grantable) {
    return `trust-config writes are never granted for the session; approve covers this call only · ${typing}`;
  }
  return `approve covers this call once; the session grants last until the app exits (never persisted); raise the standing level on the Privacy tab (/privacy) · ${typing}`;
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

/**
 * How loudly a button asks to be pressed.
 *
 * `primary` is the raised chip face the composer's `send →` uses.
 * `danger` grounds the label in the palette's `error`, with ink chosen
 * by measurement rather than by a guess about the theme's polarity.
 * `secondary` is the flatter accent-tinted badge, and it is what the
 * session grants get: approving one call and trusting a whole category
 * until the app exits are different acts, and the row should not
 * present them as peers.
 */
type ButtonTone = "primary" | "danger" | "secondary";

/**
 * The button face.
 *
 * The padding spaces are load-bearing — the same reason `chip.tsx`
 * gives: a coloured ground flush against its label reads as highlighted
 * text, not as a control. A terminal has no bevel to draw, so the
 * ground and its padding are the entire affordance.
 */
function ButtonFace({
  tone,
  children,
}: {
  tone: ButtonTone;
  children: string;
}): ReactElement {
  const background =
    tone === "primary"
      ? theme.colors.chipBackground
      : tone === "danger"
        ? theme.colors.error
        : theme.colors.badgeBackground;
  // `readableOn` measures the ground against both ends of the palette's
  // chip pair and takes the better one. `error` is a mid-tone on every
  // palette — light enough to need dark ink on some and not on others —
  // so a fixed foreground would be wrong on half the registry.
  const foreground =
    tone === "secondary" ? theme.colors.accent : readableOn(background);
  return (
    <Text backgroundColor={background} color={foreground} bold>
      {` ${children} `}
    </Text>
  );
}

/**
 * Click target for the retarget button. Defined separately from
 * `ApprovalButton` (rather than reusing it) because it opens the target
 * field instead of deciding the request — a click that resolved the
 * approval here would be the opposite of what the operator asked for.
 */
function EditPathButton({
  onOpen,
  children,
}: {
  onOpen: () => void;
  children: string;
}): ReactElement {
  const face = <ButtonFace tone="secondary">{children}</ButtonFace>;
  const mouse = useMouseCommands();
  if (!mouse) return face;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        onOpen();
        return true;
      }}
    >
      {face}
    </MouseTarget>
  );
}

interface ApprovalButtonProps {
  request: ApprovalRequest;
  approved: boolean;
  grant?: ApprovalGrantScope;
  tone: ButtonTone;
  children: string;
}

/**
 * A clickable decision button. Still renders its face when the mouse
 * layer is absent, so the modal looks identical with `--no-mouse` and
 * under the test renderer — the chord is what drives it there, and a
 * button that vanished without a mouse would hide the chord's label
 * with it.
 */
function ApprovalButton({
  request,
  approved,
  grant,
  tone,
  children,
}: ApprovalButtonProps): ReactElement {
  const face = <ButtonFace tone={tone}>{children}</ButtonFace>;
  const mouse = useMouseCommands();
  if (!mouse) return face;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      flexShrink={0}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        decideApproval(request, approved, mouse, grant);
        return true;
      }}
    >
      {face}
    </MouseTarget>
  );
}
