import { devConfig } from "./dev";
import { stgConfig } from "./stg";
import { prodConfig } from "./prod";

export const configs = {
  dev: devConfig,
  stg: stgConfig,
  prod: prodConfig,
} as const;

export type Stage = keyof typeof configs;