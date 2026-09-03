// atomic-speech — the desktop's voice-input helper.
//
// It is a plain CLI: raw 16 kHz mono signed-16-bit-little-endian PCM on
// stdin, one JSON object per line on stdout. The Electron main process
// owns it; the renderer captures the microphone and the bytes cross the
// context bridge as Uint8Array chunks.
//
// Everything here runs on this Mac. Apple's SpeechAnalyzer with a
// SpeechTranscriber (or, for the locales SpeechTranscriber does not
// cover, a DictationTranscriber) transcribes from an installed on-device
// model; nothing is uploaded and SFSpeechRecognizer's server route is
// never used. Measured, not assumed: a 9.4 s live transcription watched
// with `nettop -P -L 10` showed no row at all for this process or for
// corespeechd / com.apple.siri.embeddedspeech, in a capture window that
// did record other processes' bytes.
//
// Modes:
//   --probe                 print one {"type":"probe",...} line and exit
//   --install <locale>      download the on-device model, streaming progress
//   <locale> [<locale2>]    transcribe; with two locales both analyzers are
//                           fed the same audio and the better-scoring one
//                           wins the session (see `replace` below).
//
// Events: ready | partial | final | replace | install | installed | error | done.

import Foundation
import Speech
import AVFoundation

func emit(_ o: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: o),
     let s = String(data: d, encoding: .utf8) {
    print(s)
    fflush(stdout)
  }
}

func osVersionString() -> String {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  return "\(v.majorVersion).\(v.minorVersion)"
}

/// AVAudioPCMBuffer is not Sendable and AVAudioConverter's input block is
/// @Sendable, so the buffer travels in an explicit box. Without it the
/// build prints a non-Sendable-capture warning on every compile.
struct BufferBox: @unchecked Sendable { let buffer: AVAudioPCMBuffer }

// ---------------------------------------------------------------- engines

/// SpeechTranscriber covers 30 locales with punctuation and casing;
/// DictationTranscriber covers 43 (Russian, Arabic, Dutch, Turkish and ten
/// more that SpeechTranscriber has no model for) with plainer text. Both
/// are on-device modules of the same SpeechAnalyzer, so a locale is served
/// by whichever one has it, SpeechTranscriber first.
@available(macOS 26.0, *)
enum Engine {
  case speech(SpeechTranscriber)
  case dictation(DictationTranscriber)

  static func make(_ locale: Locale, speechLocales: Set<String>) -> Engine {
    if speechLocales.contains(locale.identifier(.bcp47)) {
      return .speech(SpeechTranscriber(locale: locale,
                                       transcriptionOptions: [],
                                       reportingOptions: [.volatileResults],
                                       attributeOptions: [.transcriptionConfidence]))
    }
    return .dictation(DictationTranscriber(locale: locale,
                                           contentHints: [],
                                           transcriptionOptions: [],
                                           reportingOptions: [.volatileResults],
                                           attributeOptions: [.transcriptionConfidence]))
  }

  var module: any SpeechModule {
    switch self {
    case .speech(let t): return t
    case .dictation(let t): return t
    }
  }

  var kind: String {
    switch self {
    case .speech: return "speech"
    case .dictation: return "dictation"
    }
  }
}

/// The per-run confidence attribute, averaged over one result. Absent
/// attributes mean "no score", never a fabricated one.
@available(macOS 26.0, *)
func meanConfidence(_ text: AttributedString) -> Double? {
  var total = 0.0
  var n = 0
  for run in text.runs {
    if let c = run[AttributeScopes.SpeechAttributes.ConfidenceAttribute.self] {
      total += Double(c)
      n += 1
    }
  }
  return n == 0 ? nil : total / Double(n)
}

@available(macOS 26.0, *)
final class Leg: @unchecked Sendable {
  let localeId: String
  let engine: Engine
  let analyzer: SpeechAnalyzer
  let format: AVAudioFormat
  let converter: AVAudioConverter
  let stream: AsyncStream<AnalyzerInput>
  let cont: AsyncStream<AnalyzerInput>.Continuation
  let primary: Bool
  var finals: [String] = []
  var scores: [Double] = []

  init?(localeId: String, speechLocales: Set<String>, inFormat: AVAudioFormat, primary: Bool) async {
    self.localeId = localeId
    self.primary = primary
    engine = Engine.make(Locale(identifier: localeId), speechLocales: speechLocales)
    guard let f = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [engine.module]),
          let conv = AVAudioConverter(from: inFormat, to: f) else { return nil }
    format = f
    converter = conv
    analyzer = SpeechAnalyzer(modules: [engine.module])
    (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
  }

  /// The session's own text so far, and the score to compare legs on.
  var text: String { finals.joined() }
  var score: Double? { scores.isEmpty ? nil : scores.reduce(0, +) / Double(scores.count) }

  func consume() -> Task<Void, Never> {
    switch engine {
    case .speech(let t):
      return Task { [weak self] in
        do {
          for try await r in t.results { self?.take(r.isFinal, r.text) }
        } catch { emit(["type": "error", "code": "results", "locale": self?.localeId ?? "", "message": "\(error)"]) }
      }
    case .dictation(let t):
      return Task { [weak self] in
        do {
          for try await r in t.results { self?.take(r.isFinal, r.text) }
        } catch { emit(["type": "error", "code": "results", "locale": self?.localeId ?? "", "message": "\(error)"]) }
      }
    }
  }

  private func take(_ isFinal: Bool, _ text: AttributedString) {
    let s = String(text.characters)
    if isFinal {
      finals.append(s)
      if let c = meanConfidence(text) { scores.append(c) }
      // Only the primary leg drives the live strip. A second leg's finals
      // are held back and can replace the whole text at the end (below),
      // because until the user stops there is nothing to compare against.
      if primary {
        var ev: [String: Any] = ["type": "final", "text": s, "locale": localeId]
        if let c = meanConfidence(text) { ev["confidence"] = c }
        emit(ev)
      }
    } else if primary {
      emit(["type": "partial", "text": s, "locale": localeId])
    }
  }

  func feed(_ inBuf: AVAudioPCMBuffer, frames: AVAudioFrameCount) {
    let ratio = format.sampleRate / inBuf.format.sampleRate
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: format,
                                        frameCapacity: AVAudioFrameCount(Double(frames) * ratio + 1024)) else { return }
    let box = BufferBox(buffer: inBuf)
    var err: NSError?
    var served = false
    converter.convert(to: outBuf, error: &err) { (_: AVAudioPacketCount, status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? in
      if served { status.pointee = .noDataNow; return nil }
      served = true
      status.pointee = .haveData
      return box.buffer
    }
    if let err {
      emit(["type": "error", "code": "convert", "locale": localeId, "message": err.localizedDescription])
      return
    }
    if outBuf.frameLength > 0 { cont.yield(AnalyzerInput(buffer: outBuf)) }
  }
}

// ---------------------------------------------------------------- probe

@available(macOS 26.0, *)
func probe() async {
  let speech = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
  let dictation = await DictationTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
  let speechInstalled = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
  let dictationInstalled = await DictationTranscriber.installedLocales.map { $0.identifier(.bcp47) }
  let supported = Array(Set(speech).union(dictation)).sorted()
  let installed = Array(Set(speechInstalled).union(dictationInstalled)).sorted()
  emit([
    "type": "probe", "ok": true, "os": osVersionString(),
    "supported": supported, "installed": installed,
    "speech": speech.sorted(), "dictation": dictation.sorted(),
    "maxReserved": AssetInventory.maximumReservedLocales,
  ])
}

// ---------------------------------------------------------------- install

@available(macOS 26.0, *)
func install(_ localeId: String) async {
  let speechLocales = Set(await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) })
  let engine = Engine.make(Locale(identifier: localeId), speechLocales: speechLocales)
  do {
    guard let request = try await AssetInventory.assetInstallationRequest(supporting: [engine.module]) else {
      emit(["type": "installed", "locale": localeId, "already": true])
      return
    }
    // `request.progress` must be re-read on every tick: a Progress captured
    // once before downloadAndInstall() reports 0.0 for the whole download.
    let monitor = Task {
      while !Task.isCancelled {
        emit(["type": "install", "locale": localeId, "fraction": request.progress.fractionCompleted])
        try? await Task.sleep(nanoseconds: 1_000_000_000)
      }
    }
    try await request.downloadAndInstall()
    monitor.cancel()
    // Reserving keeps the model from being evicted. There are only
    // `maximumReservedLocales` slots, so a full inventory releases the
    // oldest reservation rather than failing the install the user just
    // waited for.
    do {
      try await AssetInventory.reserve(locale: Locale(identifier: localeId))
    } catch {
      let reserved = await AssetInventory.reservedLocales
      if let victim = reserved.first(where: { $0.identifier(.bcp47) != localeId }) {
        await AssetInventory.release(reservedLocale: victim)
        _ = try? await AssetInventory.reserve(locale: Locale(identifier: localeId))
      }
    }
    emit(["type": "installed", "locale": localeId])
  } catch {
    emit(["type": "error", "code": "install", "locale": localeId, "message": "\(error)"])
  }
}

// ---------------------------------------------------------------- transcribe

@available(macOS 26.0, *)
func transcribe(_ localeIds: [String]) async {
  let speechLocales = Set(await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) })
  guard let inFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true) else {
    emit(["type": "error", "code": "no-input-format"])
    return
  }
  var legs: [Leg] = []
  for (i, id) in localeIds.enumerated() {
    guard let leg = await Leg(localeId: id, speechLocales: speechLocales, inFormat: inFormat, primary: i == 0) else {
      emit(["type": "error", "code": "no-format", "locale": id])
      return
    }
    legs.append(leg)
  }
  guard let primary = legs.first else { emit(["type": "error", "code": "no-locale"]); return }

  var tasks: [Task<Void, Never>] = []
  for leg in legs { tasks.append(leg.consume()) }
  for leg in legs {
    do { try await leg.analyzer.start(inputSequence: leg.stream) }
    catch {
      emit(["type": "error", "code": "start", "locale": leg.localeId, "message": "\(error)"])
      return
    }
  }
  emit([
    "type": "ready", "locale": primary.localeId,
    "locales": legs.map { $0.localeId }, "engines": legs.map { $0.engine.kind },
    "sampleRate": primary.format.sampleRate,
  ])

  // stdin: raw 16 kHz mono s16le. A pipe read can split a sample in half,
  // so an odd trailing byte is carried into the next read rather than
  // silently shifting every sample after it by one byte.
  let handle = FileHandle.standardInput
  var residue = Data()
  while true {
    let chunk = handle.availableData
    if chunk.isEmpty { break }
    residue.append(chunk)
    let usable = residue.count - (residue.count % 2)
    if usable == 0 { continue }
    let data = residue.prefix(usable)
    residue = residue.suffix(from: residue.startIndex + usable)
    let frames = AVAudioFrameCount(usable / 2)
    guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frames) else { break }
    inBuf.frameLength = frames
    data.withUnsafeBytes { raw in
      if let src = raw.bindMemory(to: Int16.self).baseAddress {
        inBuf.int16ChannelData!.pointee.update(from: src, count: Int(frames))
      }
    }
    for leg in legs { leg.feed(inBuf, frames: frames) }
  }

  for leg in legs { leg.cont.finish() }
  for leg in legs {
    do { try await leg.analyzer.finalizeAndFinishThroughEndOfInput() }
    catch { emit(["type": "error", "code": "finish", "locale": leg.localeId, "message": "\(error)"]) }
  }
  for t in tasks { _ = await t.value }

  // Two languages at once: both analyzers heard the same audio, and the
  // mean per-word confidence separates them cleanly — measured on this
  // machine, English speech scores 0.913 through en-US and Russian speech
  // scores 0.104 through the same en-US model. If a secondary leg beats
  // the primary, its whole transcript replaces what the strip has been
  // showing, and the renderer says which language won.
  if legs.count > 1, let base = primary.score {
    var best = primary
    var bestScore = base
    for leg in legs.dropFirst() {
      if let s = leg.score, s > bestScore, !leg.text.trimmingCharacters(in: .whitespaces).isEmpty {
        best = leg
        bestScore = s
      }
    }
    if best !== primary {
      emit(["type": "replace", "text": best.text, "locale": best.localeId,
            "confidence": bestScore, "runnerUp": primary.localeId, "runnerUpConfidence": base])
    }
  }
  emit(["type": "done"])
}

// ---------------------------------------------------------------- entry

let args = Array(CommandLine.arguments.dropFirst())
let sem = DispatchSemaphore(value: 0)
Task {
  if #available(macOS 26.0, *) {
    if args.first == "--probe" {
      await probe()
    } else if args.first == "--install", args.count > 1 {
      await install(args[1])
    } else {
      let locales = args.filter { !$0.hasPrefix("--") }
      await transcribe(locales.isEmpty ? ["en-US"] : Array(locales.prefix(3)))
    }
  } else {
    emit(["type": "error", "code": "os", "os": osVersionString()])
  }
  sem.signal()
}
sem.wait()
