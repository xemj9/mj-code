// Source compatibility shim. The typed path utilities now live in ./path-utils.mts.
export {
  abbreviate,
  appendLimited,
  isSubPath,
  resolveUserPath,
} from "./path-utils.mts";
