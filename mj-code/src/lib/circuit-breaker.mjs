// Source compatibility shim. The typed circuit breaker now lives in ./circuit-breaker.mts.
export {
  CircuitBreaker,
  createCircuitSnapshot,
} from "./circuit-breaker.mts";
