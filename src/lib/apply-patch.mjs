// Source compatibility shim. The typed patch engine now lives in ./apply-patch.mts.
export {
  applyPatchText,
  extractPatchPaths,
  parsePatchText,
  previewPatchText,
} from "./apply-patch.mts";
