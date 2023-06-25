
const port = process.argv[2] || 7700;

const express = require("express")();

express.get("/", (req, res) => {
  res.send("Hello World!");
});

express.listen(port, () => {

  console.log("Listening on port " + port);

  require("..")(async gateway => {

    console.log(gateway.url);

    try {

      console.log("Internet IP: " + await gateway.getExternalIp());

      console.table(await gateway.getMappings());

      await gateway.addMapping(port, port);

      console.table(await gateway.getMappings());

      await gateway.deleteMapping(port, port);

      console.table(await gateway.getMappings());

    } catch (error) {
      console.log([gateway.host, error.toString()]);
    }
  });
});
