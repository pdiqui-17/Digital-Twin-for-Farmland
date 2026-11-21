import client from "prom-client";
import { createApp, FARM_LAT, FARM_LON } from "./app";
import { ConstantWeather, OpenMeteoProvider } from "./domain/weather";

const env = process.env;
const port = Number(env.ANALYTICS_PORT ?? env.PORT ?? 3012);
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const weather = env.WEATHER === "constant" ? new ConstantWeather() : new OpenMeteoProvider();
createApp({
  weather,
  registry,
  defaultLat: Number(env.FARM_LAT ?? FARM_LAT),
  defaultLon: Number(env.FARM_LON ?? FARM_LON),
}).listen(port, () => console.log(`analytics listening on :${port}`));
