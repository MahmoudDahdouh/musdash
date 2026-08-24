const { createServer } = require("node:http")
createServer((_req, res) => res.end("node-dockerfile ok\n")).listen(3000)
