// atomic-show-once: the Accessibility side of Show once (ATO-2499,
// main/show-once-helper.ts), one resident process for a whole recording
// instead of one osascript per click (main/show-once-probe.ts, the fallback).
//
// Read-only. It never clicks, types, captures the screen or reads a
// control's value (AXValue): only the app, the window's frame and title,
// and a control's role and title or description. A password field (role
// or subrole AXSecureTextField) is named as one with no label.
//
// stdin, one command per line:
//   click <id> <x> <y>   what is under the point (screen coordinates)
//   key <id>             the frontmost app, its focused window and control
// stdout, one JSON object per line:
//   {"ready":true}                               the helper is listening
//   {"untrusted":true}                           no Accessibility for the app; exits 3
//   {"id":n,"app":{..},"window":{..},"windowTitle":"..","windowId":n,"element":{..},"focused":{..}}
//   {"ev":"app","app":{..},"title":".."}         another app came to the front
//   {"ev":"window","app":{..},"title":".."}      its window in front changed or was renamed
//   {"ev":"menu","app":{..},"path":["File","Export To","PDF…"]}   a menu command ran
//
// The pushes come from an AXObserver on the frontmost app, moved to each
// app as it comes to the front. The helper exits when its stdin closes, so
// a crashed app does not leave it behind. Built by
// scripts/build-speech-helper.mjs (macOS 14 floor, the build's own arch).

import AppKit
import ApplicationServices
import Foundation

func emit(_ obj: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(obj),
        let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func clip(_ s: String?, _ n: Int = 120) -> String {
  return String((s ?? "").prefix(n))
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func text(_ el: AXUIElement, _ name: String) -> String? {
  return attr(el, name) as? String
}

func child(_ v: CFTypeRef?) -> AXUIElement? {
  guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}

/// A password field: NSSecureTextField and a web <input type=password> report
/// role AXTextField with subrole AXSecureTextField, so both are checked.
func isSecure(_ el: AXUIElement, _ role: String) -> Bool {
  return role == "AXSecureTextField" || text(el, kAXSubroleAttribute as String) == "AXSecureTextField"
}

func describe(_ el: AXUIElement) -> [String: Any]? {
  guard let role = text(el, kAXRoleAttribute as String) else { return nil }
  if isSecure(el, role) { return ["role": "AXSecureTextField", "label": ""] }
  var label = text(el, kAXTitleAttribute as String) ?? ""
  if label.isEmpty { label = text(el, kAXDescriptionAttribute as String) ?? "" }
  return ["role": role, "label": clip(label)]
}

func appInfo(_ a: NSRunningApplication?) -> [String: Any]? {
  guard let a = a else { return nil }
  var o: [String: Any] = ["pid": Int(a.processIdentifier)]
  if let n = a.localizedName { o["name"] = n }
  if let b = a.bundleIdentifier { o["bundleId"] = b }
  return o
}

func windowTitle(ofApp pid: pid_t) -> String {
  let root = AXUIElementCreateApplication(pid)
  guard let win = child(attr(root, kAXFocusedWindowAttribute as String)) else { return "" }
  return clip(text(win, kAXTitleAttribute as String))
}

/// The titles from the menu bar down to `item`: ["File", "Export To", "PDF…"].
func menuPath(_ item: AXUIElement) -> [String] {
  var out: [String] = []
  var cur: AXUIElement? = item
  var depth = 0
  while let el = cur, depth < 12 {
    depth += 1
    let role = text(el, kAXRoleAttribute as String) ?? ""
    if role == "AXMenuItem" || role == "AXMenuBarItem" {
      let t = text(el, kAXTitleAttribute as String) ?? ""
      if !t.isEmpty { out.append(clip(t, 60)) }
    }
    if role == "AXMenuBar" || role == "AXApplication" { break }
    cur = child(attr(el, kAXParentAttribute as String))
  }
  return Array(out.reversed())
}

func clickProbe(_ x: Double, _ y: Double) -> [String: Any] {
  var out: [String: Any] = [:]
  var hitApp: [String: Any]? = nil
  let point = CGPoint(x: x, y: y)
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  if let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] {
    for w in list {
      guard let bounds = w[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
      if let alpha = w[kCGWindowAlpha as String] as? Double, alpha == 0 { continue }
      if !rect.contains(point) { continue }
      let pid = pid_t((w[kCGWindowOwnerPID as String] as? Int) ?? 0)
      let running = NSRunningApplication(processIdentifier: pid)
      if running?.bundleIdentifier != nil {
        hitApp = appInfo(running)
        if (w[kCGWindowLayer as String] as? Int) == 0 {
          out["window"] = ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.width), "height": Double(rect.height)]
          out["windowId"] = (w[kCGWindowNumber as String] as? Int) ?? 0
        }
      }
      break
    }
  }
  out["app"] = hitApp ?? appInfo(NSWorkspace.shared.frontmostApplication) ?? NSNull()
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success, let el = hit {
    if let d = describe(el) { out["element"] = d }
    if let win = child(attr(el, kAXWindowAttribute as String)) {
      out["windowTitle"] = clip(text(win, kAXTitleAttribute as String))
    }
  }
  return out
}

/// The front window of `pid` on screen (layer 0), for a picture of it (ATO-2499 snapshots).
func frontWindowId(ofApp pid: pid_t) -> Int? {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
  for w in list where (w[kCGWindowOwnerPID as String] as? Int) == Int(pid) && (w[kCGWindowLayer as String] as? Int) == 0 {
    return w[kCGWindowNumber as String] as? Int
  }
  return nil
}

func keyProbe() -> [String: Any] {
  var out: [String: Any] = [:]
  let front = NSWorkspace.shared.frontmostApplication
  out["app"] = appInfo(front) ?? NSNull()
  if let pid = front?.processIdentifier {
    out["windowTitle"] = windowTitle(ofApp: pid)
    if let wid = frontWindowId(ofApp: pid) { out["windowId"] = wid }
  }
  if let el = child(attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as String)), let d = describe(el) {
    out["focused"] = d
  }
  return out
}

// ---- the observer on the frontmost app ----

var observer: AXObserver?
var observedApp: [String: Any]? = nil

func handle(_ name: String, _ el: AXUIElement) {
  guard let app = observedApp else { return }
  if name == (kAXMenuItemSelectedNotification as String) {
    let path = menuPath(el)
    if !path.isEmpty { emit(["ev": "menu", "app": app, "path": path]) }
  } else if name == (kAXFocusedWindowChangedNotification as String) {
    emit(["ev": "window", "app": app, "title": clip(text(el, kAXTitleAttribute as String))])
  } else if name == (kAXTitleChangedNotification as String) {
    if text(el, kAXRoleAttribute as String) == "AXWindow" {
      emit(["ev": "window", "app": app, "title": clip(text(el, kAXTitleAttribute as String))])
    }
  }
}

let axCallback: AXObserverCallback = { _, element, notification, _ in
  handle(notification as String, element)
}

func observe(_ app: NSRunningApplication) {
  if let old = observer {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(old), .commonModes)
  }
  observer = nil
  observedApp = appInfo(app)
  let pid = app.processIdentifier
  var made: AXObserver?
  guard AXObserverCreate(pid, axCallback, &made) == .success, let obs = made else { return }
  let root = AXUIElementCreateApplication(pid)
  let names = [kAXMenuItemSelectedNotification, kAXFocusedWindowChangedNotification, kAXTitleChangedNotification]
  for n in names { _ = AXObserverAddNotification(obs, root, n as CFString, nil) }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .commonModes)
  observer = obs
  if let info = observedApp { emit(["ev": "app", "app": info, "title": windowTitle(ofApp: pid)]) }
}

// ---- start ----

// TCC answers for the app that launched this helper (the responsible process).
if !AXIsProcessTrusted() {
  emit(["untrusted": true])
  exit(3)
}

NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
  if let a = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { observe(a) }
}

func answer(_ line: String) {
  let parts = line.split(separator: " ").map(String.init)
  guard parts.count >= 2, let id = Int(parts[1]) else { return }
  var out: [String: Any]
  if parts[0] == "click", parts.count >= 4, let x = Double(parts[2]), let y = Double(parts[3]) {
    out = clickProbe(x, y)
  } else if parts[0] == "key" {
    out = keyProbe()
  } else {
    out = [:]
  }
  out["id"] = id
  emit(out)
}

Thread.detachNewThread {
  while let line = readLine() {
    DispatchQueue.main.async { answer(line) }
  }
  exit(0)
}

emit(["ready": true])
if let front = NSWorkspace.shared.frontmostApplication { observe(front) }
CFRunLoopRun()
