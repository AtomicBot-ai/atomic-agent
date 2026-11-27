// atomic-system-audio: the other side of a call, for "Record a meeting"
// (ATO-2514, main/meeting-system-audio.ts).
//
// ScreenCaptureKit captures what this Mac plays (the call app's audio)
// as 16 kHz mono; this helper writes it to stdout as raw signed 16-bit
// little-endian PCM, the same format the microphone tap sends, and never
// keeps it. Events go to stderr, one JSON object per line:
//
//   {"type":"ready"}                     capture runs
//   {"type":"error","code":"screen-denied"}  no Screen and System Audio
//                                        Recording permission for the app
//   {"type":"error","code":"no-display"|"failed","detail":"…"}
//   {"type":"done"}                      stopped
//
// Video is not captured: the stream is the smallest SCK allows (2x2 at
// one frame a second) and only the audio output is attached. The app's own
// sound (a reply read aloud) is left out: `--exclude-bundle <id>` names the
// app's bundle id, and every running app whose id starts with it (the app
// and its helper processes) is excluded from the capture.
//
// The helper exits when its stdin closes, so a crashed app does not leave
// it listening.

import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

func event(_ o: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: o) {
    FileHandle.standardError.write(d)
    FileHandle.standardError.write("\n".data(using: .utf8)!)
  }
}

/// Float32 samples (mono, or the first channel of interleaved audio) to s16le.
func toS16(_ samples: UnsafeBufferPointer<Float>, stride: Int) -> Data {
  var out = Data(count: (samples.count / max(stride, 1)) * 2)
  out.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
    let dst = raw.bindMemory(to: Int16.self)
    var j = 0
    var i = 0
    while i < samples.count && j < dst.count {
      let v = max(-1.0, min(1.0, samples[i]))
      dst[j] = Int16(v * 32767.0).littleEndian
      j += 1
      i += max(stride, 1)
    }
  }
  return out
}

final class Tap: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let out = FileHandle.standardOutput

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sb.isValid,
          let desc = CMSampleBufferGetFormatDescription(sb),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee,
          asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return }
    let interleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    let stride = interleaved ? Int(max(asbd.mChannelsPerFrame, 1)) : 1
    try? sb.withAudioBufferList { list, _ in
      guard let first = list.first, let data = first.mData else { return }
      let n = Int(first.mDataByteSize) / MemoryLayout<Float>.size
      let samples = UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: n)
      let bytes = toS16(samples, stride: stride)
      if !bytes.isEmpty { out.write(bytes) }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    event(["type": "error", "code": "failed", "detail": "\(error)"])
    exit(4)
  }
}

func excludeArg() -> String? {
  let a = Array(CommandLine.arguments.dropFirst())
  guard let i = a.firstIndex(of: "--exclude-bundle"), i + 1 < a.count else { return nil }
  return a[i + 1]
}

func run() async {
  let content: SCShareableContent
  do {
    content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  } catch {
    // SCStreamError.userDeclined, or no TCC entry yet: both read as "not allowed".
    event(["type": "error", "code": "screen-denied", "detail": "\(error)"])
    exit(3)
  }
  guard let display = content.displays.first else {
    event(["type": "error", "code": "no-display"])
    exit(4)
  }
  var skip: [SCRunningApplication] = []
  if let prefix = excludeArg(), !prefix.isEmpty {
    skip = content.applications.filter { $0.bundleIdentifier.hasPrefix(prefix) }
  }
  let filter = SCContentFilter(display: display, excludingApplications: skip, exceptingWindows: [])
  let cfg = SCStreamConfiguration()
  cfg.capturesAudio = true
  cfg.excludesCurrentProcessAudio = true
  cfg.sampleRate = 16000
  cfg.channelCount = 1
  cfg.width = 2
  cfg.height = 2
  cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
  let tap = Tap()
  let stream = SCStream(filter: filter, configuration: cfg, delegate: tap)
  do {
    try stream.addStreamOutput(tap, type: .audio, sampleHandlerQueue: DispatchQueue(label: "atomic.system-audio"))
    try await stream.startCapture()
  } catch {
    event(["type": "error", "code": "failed", "detail": "\(error)"])
    exit(4)
  }
  event(["type": "ready"])
  // Until the app closes stdin (Stop, quit or crash).
  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    DispatchQueue.global().async {
      while !FileHandle.standardInput.availableData.isEmpty {}
      done.resume()
    }
  }
  try? await stream.stopCapture()
  event(["type": "done"])
  exit(0)
}

let sem = DispatchSemaphore(value: 0)
Task {
  await run()
  sem.signal()
}
sem.wait()
