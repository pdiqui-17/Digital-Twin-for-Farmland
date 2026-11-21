import path from "node:path";
import client from "prom-client";
import { createApp, FARM_LAT, FARM_LON } from "./app";
import { ConstantWeather, OpenMeteoProvider } from "./domain/weather";
import { loadModel, saveModel } from "./modelFile";

const env = process.env;
const port = Number(env.ANALYTICS_PORT ?? env.PORT ?? 3012);
// Hệ số đã fit (chung + theo zone). .data/ đã nằm trong .gitignore.
const modelFile = env.ANALYTICS_MODEL_FILE || path.resolve(__dirname, "../../../.data/analytics-model.json");
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const weather = env.WEATHER === "constant" ? new ConstantWeather() : new OpenMeteoProvider();
const model = loadModel(modelFile);
createApp({
  weather,
  registry,
  model,
  persist: (m) => saveModel(modelFile, m),
  defaultLat: Number(env.FARM_LAT ?? FARM_LAT),
  defaultLon: Number(env.FARM_LON ?? FARM_LON),
}).listen(port, () =>
  console.log(`analytics listening on :${port}; model ${model ? `loaded (${Object.keys(model.zones).join(", ") || "chung"})` : "mặc định (chưa calibrate)"} from ${modelFile}`));
