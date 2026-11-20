import { createApp } from "./app";
import { ConstantWeather, OpenMeteoProvider } from "./domain/weather";

const port = Number(process.env.PORT ?? 3003);
const weather = process.env.WEATHER === "constant" ? new ConstantWeather() : new OpenMeteoProvider();
createApp({
  weather,
  defaultLat: Number(process.env.FARM_LAT ?? 21.03),
  defaultLon: Number(process.env.FARM_LON ?? 105.85),
}).listen(port, () => console.log(`analytics listening on :${port}`));
