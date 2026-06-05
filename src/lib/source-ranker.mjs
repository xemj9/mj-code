// Source compatibility shim. The typed source ranker now lives in ./source-ranker.mts.
export {
  classifySource,
  normalizeRankingMode,
  rankSources,
} from "./source-ranker.mts";
