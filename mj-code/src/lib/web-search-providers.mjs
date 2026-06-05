// Source compatibility shim. The typed web search provider registry now lives in ./web-search-providers.mts.
export {
  createSearchProvider,
  listSupportedWebProviders,
} from "./web-search-providers.mts";
