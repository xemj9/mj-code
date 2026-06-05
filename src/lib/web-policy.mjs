// Source compatibility shim. The typed web policy plane now lives in ./web-policy.mts.
export {
  canonicalizeUrl,
  evaluateUrlAgainstNetworkMode,
  filterSearchResultsForNetworkMode,
  getUrlMetadata,
  isDocsOnlyUrlAllowed,
  isDomainAllowed,
  isDomainDenied,
  isOfficialLikeUrl,
  matchesDomainRule,
  normalizeDomain,
  normalizeDomainList,
  normalizeNetworkMode,
  summarizeNetworkInput,
} from "./web-policy.mts";
