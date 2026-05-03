// pdfjs-dist@4 ships `.d.ts` only for the main `pdf.mjs` entry. The worker
// module (`pdf.worker.mjs`) is untyped because it is normally executed inside
// a Worker context, not imported directly. We import it on the main thread to
// satisfy `globalThis.pdfjsWorker.WorkerMessageHandler` (see `pdf-extractor.ts`
// for why) and just need TypeScript to stop complaining about the missing
// declaration. Runtime shape (`{ WorkerMessageHandler }`) is asserted at the
// call site.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
