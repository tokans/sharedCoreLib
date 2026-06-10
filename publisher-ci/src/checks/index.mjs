// The check registry. Order is presentation order; each is independent.
import trustAnchor from "./trust-anchor.mjs";
import keySeparation from "./key-separation.mjs";
import updateMetadata from "./update-metadata.mjs";
import deprecationWindow from "./deprecation-window.mjs";
import kdfFloor from "./kdf-floor.mjs";
import tlsOnly from "./tls-only.mjs";
import dependencyPinning from "./dependency-pinning.mjs";
import releasePipeline from "./release-pipeline.mjs";
import schemaMerge from "./schema-merge.mjs";

export const CHECKS = [
  trustAnchor,
  keySeparation,
  updateMetadata,
  deprecationWindow,
  kdfFloor,
  tlsOnly,
  dependencyPinning,
  releasePipeline,
  schemaMerge,
];
