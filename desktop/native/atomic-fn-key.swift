// atomic-fn-key: tells the desktop app when Fn is held down and let go,
// for dictation into any app (ATO-1064, main/dictate-hold.ts).
//
// Electron's globalShortcut sees neither Fn nor a key going up, so this
// small helper watches through a listen-only CGEventTap: it can observe
// but never changes, delays or swallows an event. One word per line on
// stdout:
//
//   ready       the tap is in place
//   down / up   Fn (or the Globe key) went down / came up
//   esc         Esc was pressed while Fn is held
//   other       another key or modifier was pressed while Fn is held
//               (Fn+arrow, Fn+F1: a chord, not dictation)
//   untrusted   no Accessibility / Input Monitoring for the app; exits 3
//   error <why> the tap could not be made; exits 4
//
// Nothing is said about any key while Fn is up. The helper exits when its
// stdin closes, so a crashed app does not leave it behind.

import Foundation
import CoreGraphics
import ApplicationServices

func say(_ s: String) {
  print(s)
  fflush(stdout)
}

/// kVK_Function, and the Globe key some keyboards report instead.
let fnKeyCodes: Set<Int64> = [63, 179]
let escKeyCode: Int64 = 53

var fnDown = false
var tap: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
  switch type {
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
  case .flagsChanged:
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    let held = event.flags.contains(.maskSecondaryFn)
    if fnKeyCodes.contains(code) {
      if held && !fnDown {
        fnDown = true
        say("down")
      } else if !held && fnDown {
        fnDown = false
        say("up")
      }
    } else if fnDown {
      if held {
        say("other")
      } else {
        // The Fn up was missed (the tap was off for a moment): end the hold now.
        fnDown = false
        say("up")
      }
    }
  case .keyDown:
    if fnDown {
      say(event.getIntegerValueField(.keyboardEventKeycode) == escKeyCode ? "esc" : "other")
    }
  default:
    break
  }
  return Unmanaged.passUnretained(event)
}

// TCC answers for the app that launched this helper (the responsible process).
if !(AXIsProcessTrusted() || CGPreflightListenEventAccess()) {
  say("untrusted")
  exit(3)
}

let mask = (CGEventMask(1) << CGEventMask(CGEventType.flagsChanged.rawValue))
  | (CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue))
guard let made = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: nil
) else {
  say("error the event tap could not be created")
  exit(4)
}
tap = made
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, made, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: made, enable: true)

Thread.detachNewThread {
  while readLine() != nil {}
  exit(0)
}

say("ready")
CFRunLoopRun()
