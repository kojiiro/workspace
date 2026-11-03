import { createGateway } from "./app.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 3001);
const app = createGateway();

app.listen({ host, port }).then(() => {
  console.log("GLC gateway listening at http://" + host + ":" + port + " (mock only)");
}).catch(error => {
  app.log.error(error);
  process.exit(1);
});
