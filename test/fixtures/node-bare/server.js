const { createServer } = require("node:http")
createServer((_req, res) => res.end("node-bare ok\n")).listen(
  Number(process.env.PORT) || 3000,
)
